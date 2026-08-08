/**
 * Embedded child sessions — specialists run in-process via
 * `createAgentSession`, each with its own model, thinking level, and a
 * file-backed transcript under the Task Store's `sessions/` dir.
 *
 * The child's tool surface is fixed by role: the standard coding tools
 * (read/bash/edit/write) plus exactly one maestro tool — `maestro_signal`.
 * The `maestro-child` protocol skill is injected via the ResourceLoader
 * AND the core rules are baked into the spawn prompt (never rely on the
 * child discovering the skill on its own).
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { TaskStore } from "./task-store.ts";
import type { EventLog } from "./events.ts";
import { safeRelativePath } from "./paths.ts";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SRC_DIR, "..");

export const MAESTRO_SKILL_DIR = join(PROJECT_ROOT, "skills", "maestro");
export const MAESTRO_CHILD_SKILL_DIR = join(PROJECT_ROOT, "skills", "maestro-child");

export interface ChildSessionOptions {
  store: TaskStore;
  agentId: string;
  role: string;
  blueprint: string;
  task: string;
  log: EventLog;
  signalTool: ToolDefinition;
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  cwd: string;
  /** Resume: open an existing session file instead of creating a new one. */
  sessionFile?: string;
}

export interface ChildSessionHandle {
  agentId: string;
  session: AgentSession;
  sessionFile: string;
  /** Fire-and-forget run; failures surface as `error` signals, never crash the parent. */
  start(prompt: string): void;
  dispose(): void;
}

function stripFrontmatter(markdown: string): string {
  const m = markdown.match(/^---[\s\S]*?---\s*(?:[\r\n]+)?/);
  return m ? markdown.slice(m[0].length) : markdown;
}

/** Assemble the spawn context slice: persona + shared state + task + protocol. */
export async function buildSpawnPrompt(opts: {
  store: TaskStore;
  agentId: string;
  role: string;
  blueprint: string;
  task: string;
}): Promise<string> {
  const contextSlice = await opts.store.renderContextSlice();
  const protocol = await readFile(join(MAESTRO_CHILD_SKILL_DIR, "SKILL.md"), "utf8").catch(() => "");
  const protocolCore = stripFrontmatter(protocol).trim();
  // Field-notes slice: the specialist's own notebook, injected at spawn
  // and at resume. The stub is created by maestro_spawn; whatever
  // was recorded in earlier tickets rides along on every follow-up spawn.
  const fieldNotesPath = safeRelativePath(opts.store.fieldNotesDir, `${opts.agentId}.md`, "Field notes path");
  const fieldNotes = await readFile(fieldNotesPath, "utf8").catch(() => "");
  const notes = fieldNotes.trim()
    ? fieldNotes.trim()
    : "(none yet — record things learned, architecture notes, pitfalls, and useful commands as you work)";
  return [
    `# You are ${opts.agentId} — a ${opts.role} specialist`,
    ``,
    stripFrontmatter(opts.blueprint).trim(),
    ``,
    `## Shared task state`,
    contextSlice,
    ``,
    `## Your field notes (field-notes/${opts.agentId}.md)`,
    notes,
    ``,
    `## Your current task`,
    opts.task.trim(),
    ``,
    `## Communication protocol (must follow)`,
    protocolCore || "Communicate with the orchestrator via maestro_signal only.",
  ].join("\n");
}

/**
 * Create (or resume) an embedded specialist session with a fixed, role-scoped
 * tool surface. The run is NOT started here — the caller records registry +
 * spawn command first, then calls `handle.start(prompt)` so the log order is
 * deterministic (spawn command precedes the child's first signal).
 */
export async function createChildSession(
  opts: ChildSessionOptions,
): Promise<ChildSessionHandle> {
  const { store, agentId } = opts;

  // Clean, role-fixed tool surface: no auto-discovered extensions in the
  // child (extensions are orchestrator-side; a child registers exactly one
  // maestro tool). Standard coding tools stay available so the specialist
  // can actually work and write artifacts.
  const loader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    additionalSkillPaths: [MAESTRO_CHILD_SKILL_DIR],
  });
  await loader.reload();

  const sessionManager = opts.sessionFile
    ? SessionManager.open(opts.sessionFile)
    : SessionManager.create(opts.cwd, store.sessionsDir);

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    customTools: [opts.signalTool],
    resourceLoader: loader,
    sessionManager,
  });

  const sessionFile = session.sessionFile ?? sessionManager.getSessionFile() ?? "";

  return {
    agentId,
    session,
    sessionFile,
    start(prompt: string) {
      void (async () => {
        try {
          await session.prompt(prompt);
        } catch (err) {
          try {
            const message = err instanceof Error ? err.message : String(err);
            await opts.log.append({
              from: agentId,
              to: "orchestrator",
              type: "error",
              payload: { summary: "Specialist run failed", details: message },
            });
          } catch { /* the log is best-effort here */ }
        }
      })();
    },
    dispose() {
      try {
        session.dispose();
      } catch { /* ignore */ }
    },
  };
}

/**
 * Assemble the resume context slice: blueprint + shared state + field
 * notes + protocol, with the continuation prompt "here are your field notes —
 * continue from your transcript".
 */
export async function buildResumePrompt(opts: {
  store: TaskStore;
  agentId: string;
  role: string;
  blueprint: string;
  fieldNotes?: string;
}): Promise<string> {
  const contextSlice = await opts.store.renderContextSlice();
  const protocol = await readFile(join(MAESTRO_CHILD_SKILL_DIR, "SKILL.md"), "utf8").catch(() => "");
  const protocolCore = stripFrontmatter(protocol).trim();
  const notes = opts.fieldNotes?.trim()
    ? opts.fieldNotes.trim()
    : "(no field notes yet — record what you learn as you work)";
  return [
    `# You are ${opts.agentId} — a ${opts.role} specialist (resumed)`,
    ``,
    stripFrontmatter(opts.blueprint).trim(),
    ``,
    `## Shared task state`,
    contextSlice,
    ``,
    `## Resume instructions`,
    `Here are your field notes — continue from your transcript. Your history is the record; ` +
      `pick up where you left off.`,
    ``,
    `### Your field notes`,
    notes,
    ``,
    `## Report in immediately`,
    `The orchestrator restarted and must know you are back. Before doing anything else, call ` +
      `maestro_signal type 'progress' with payload summary 'resumed'. Then continue your ` +
      `interrupted work and signal needs_input / finished / error as usual at decision points.`,
    ``,
    `## Communication protocol (must follow)`,
    protocolCore || "Communicate with the orchestrator via maestro_signal only.",
  ].join("\n");
}

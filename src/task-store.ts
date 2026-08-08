/**
 * The Task Store — durable state for one orchestrated task.
 *
 * Layout (under `<cwd>/.pi/maestro/<task-id>/`):
 *   agents.json, consumer.json, state.md, config.json,
 *   tickets/, agents/, field-notes/, artifacts/, events.jsonl, sessions/
 */
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, type MaestroConfig } from "./types.ts";
import { BUILTIN_BLUEPRINTS } from "./blueprints.ts";
import { writeAtomic } from "./persistence.ts";
import { assertIdentifier, assertRealPathInside, safeRelativePath, validIdentifier } from "./paths.ts";

const MAESTRO_DIR_NAME = "maestro";
const CURRENT_POINTER = "current.txt";

export function maestroRoot(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, MAESTRO_DIR_NAME);
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "task";
}

export class TaskStore {
  /** Absolute path to `.pi/maestro/<task-id>/`. */
  readonly root: string;
  readonly taskId: string;
  readonly cwd: string;

  constructor(cwd: string, taskId: string) {
    this.cwd = cwd;
    this.taskId = taskId;
    this.root = join(maestroRoot(cwd), taskId);
  }

  // ── paths ────────────────────────────────────────────────────────────────
  get statePath() { return join(this.root, "state.md"); }
  get registryPath() { return join(this.root, "agents.json"); }
  get consumersPath() { return join(this.root, "consumer.json"); }
  get configPath() { return join(this.root, "config.json"); }
  get eventsPath() { return join(this.root, "events.jsonl"); }
  get ticketsDir() { return join(this.root, "tickets"); }
  get blueprintsDir() { return join(this.root, "agents"); }
  get fieldNotesDir() { return join(this.root, "field-notes"); }
  get artifactsDir() { return join(this.root, "artifacts"); }
  get sessionsDir() { return join(this.root, "sessions"); }

  // ── discovery / init ─────────────────────────────────────────────────────

  /** Find the current task store for this cwd via its explicit pointer. */
  static async discover(cwd: string): Promise<TaskStore | null> {
    const root = maestroRoot(cwd);
    const pointer = join(root, CURRENT_POINTER);
    if (!existsSync(pointer)) return null;
    try {
      const taskId = (await readFile(pointer, "utf8")).trim();
      if (!validIdentifier(taskId)) return null;
      const candidate = join(root, taskId);
      if (!existsSync(candidate) || !(await stat(candidate)).isDirectory()) return null;
      await assertRealPathInside(root, candidate, "Task store");
      return new TaskStore(cwd, taskId);
    } catch {
      return null;
    }
  }

  /**
   * Create a fresh Task Store. If a store already exists for this cwd, it is
   * reused (resume), not clobbered — nothing in the Task Store is ever
   * rewritten in place.
   */
  static async init(cwd: string, taskName?: string): Promise<TaskStore> {
    const existing = await TaskStore.discover(cwd);
    if (existing) return existing;

    const root = maestroRoot(cwd);
    await mkdir(root, { recursive: true });

    const store = new TaskStore(cwd, slugify(taskName ?? "task"));
    await store.createStore();
    return store;
  }

  private async createStore(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(this.ticketsDir, { recursive: true });
    await mkdir(this.blueprintsDir, { recursive: true });
    await mkdir(this.fieldNotesDir, { recursive: true });
    await mkdir(this.artifactsDir, { recursive: true });
    await mkdir(this.sessionsDir, { recursive: true });

    // state.md — five sections, orchestrator-owned dashboard.
    if (!existsSync(this.statePath)) {
      await writeAtomic(
        this.statePath,
        [
          "# Task State",
          "",
          "## Goal",
          "",
          "(set by the orchestrator when the human states the goal)",
          "",
          "## Current phase",
          "",
          "kickoff",
          "",
          "## Open tickets",
          "",
          "(id · title · status · owner)",
          "",
          "## Decisions",
          "",
          "(orchestrator-owned; record decisions here)",
          "",
          "## Ownership",
          "",
          "(agent id · role · scope — one line per specialist)",
          "",
        ].join("\n"),
      );
    }

    // agents/ — role blueprints: built-ins seeded here; custom via maestro_define_role.
    for (const b of BUILTIN_BLUEPRINTS) {
      const file = join(this.blueprintsDir, `${b.name}.md`);
      if (!existsSync(file)) await writeAtomic(file, b.content);
    }

    // config.json — policies with defaults.
    if (!existsSync(this.configPath)) {
      await writeAtomic(this.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    }

    // agents.json — registry (lineage + status).
    if (!existsSync(this.registryPath)) {
      const registry = {
        taskId: this.taskId,
        createdAt: new Date().toISOString(),
        agents: {},
      };
      await writeAtomic(this.registryPath, JSON.stringify(registry, null, 2) + "\n");
    }

    // consumer.json — per-consumer cursors; the orchestrator entry is the
    // watermark; the orchestrator-ui entry is the card render position.
    if (!existsSync(this.consumersPath)) {
      await writeAtomic(
        this.consumersPath,
        JSON.stringify(
          { consumers: { orchestrator: { lastSequence: 0 }, "orchestrator-ui": { lastSequence: 0 } } },
          null,
          2,
        ) + "\n",
      );
    }

    // events.jsonl — empty, append-only.
    if (!existsSync(this.eventsPath)) {
      await writeAtomic(this.eventsPath, "");
    }

    // Pointer for restart discovery.
    await writeAtomic(join(maestroRoot(this.cwd), CURRENT_POINTER), this.taskId + "\n");
  }

  // ── config ───────────────────────────────────────────────────────────────
  async loadConfig(): Promise<MaestroConfig> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.configPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_CONFIG };
      const value = parsed as Record<string, unknown>;
      return {
        maxConcurrentSpecialists:
          Number.isSafeInteger(value.maxConcurrentSpecialists) && (value.maxConcurrentSpecialists as number) > 0
            ? (value.maxConcurrentSpecialists as number)
            : DEFAULT_CONFIG.maxConcurrentSpecialists,
        autoResume: typeof value.autoResume === "boolean" ? value.autoResume : DEFAULT_CONFIG.autoResume,
        reviewRequired: Array.isArray(value.reviewRequired)
          ? value.reviewRequired.filter((v): v is string => typeof v === "string")
          : [...DEFAULT_CONFIG.reviewRequired],
        approvalRules: Array.isArray(value.approvalRules)
          ? value.approvalRules.filter((v): v is string => typeof v === "string")
          : [...DEFAULT_CONFIG.approvalRules],
        spawnThreshold: typeof value.spawnThreshold === "string" ? value.spawnThreshold : DEFAULT_CONFIG.spawnThreshold,
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  // ── state.md (orchestrator-owned dashboard) ──────────────────────────────

  /** Append a line under the `## Ownership` section of state.md. */
  async recordOwnership(agentId: string, role: string, scope: string[]): Promise<void> {
    const scopeText = scope.length > 0 ? ` · scope: ${scope.join(", ")}` : "";
    const line = `- ${agentId} · role: ${role}${scopeText}`;
    const current = await readFile(this.statePath, "utf8").catch(() => "");
    const section = "\n## Ownership\n";
    const idx = current.indexOf(section);
    if (idx >= 0) {
      const head = current.slice(0, idx + section.length);
      const tail = current.slice(idx + section.length);
      // Idempotent per specialist; never clobber the other entries (the old
      // implementation replaced the whole section with the last line).
      if (tail.split("\n").some((l) => l.trim().startsWith(`- ${agentId} ·`))) return;
      await writeAtomic(this.statePath, `${head}${line}\n${tail}`);
    } else {
      await writeAtomic(this.statePath, `${current}\n${section}${line}\n`);
    }
  }

  /** Render the bounded shared context slice for a specialist's spawn prompt. */
  async renderContextSlice(): Promise<string> {
    const parts: string[] = [];

    // The task store root anchors every relative path the specialist sees.
    // State paths are relative to this directory — NOT to the child's cwd.
    parts.push(`Task store root: ${this.root} — paths below are relative to it (state.md, tickets/, artifacts/, field-notes/).`);

    const state = await readFile(this.statePath, "utf8").catch(() => "# Task State\n(empty)");
    parts.push(stateDigest(state.trimEnd()));

    // Tickets — compact list of schema-backed ticket files.
    const ticketFiles = await readdir(this.ticketsDir).catch(() => [] as string[]);
    if (ticketFiles.length > 0) {
      const rows: string[] = [];
      for (const f of ticketFiles.sort()) {
        if (!f.endsWith(".md")) continue;
        const raw = await readFile(join(this.ticketsDir, f), "utf8").catch(() => "");
        const firstLine = raw.split("\n").find((l) => l.startsWith("# "));
        rows.push(`- ${f.replace(/\.md$/, "")}: ${(firstLine ?? raw.slice(0, 80)).replace(/^#\s*/, "")}`);
      }
      parts.push(`## Tickets\n\n${rows.join("\n")}`);
    }

    // Artifacts — listing only; the specialist reads what it needs.
    const artifactFiles = await readdir(this.artifactsDir).catch(() => [] as string[]);
    if (artifactFiles.length > 0) {
      parts.push(`## Artifacts\n\n${artifactFiles.sort().map((f) => `- artifacts/${f}`).join("\n")}`);
    }

    return parts.join("\n\n");
  }

  /** Path of an artifact resolved safely against the artifacts dir. */
  artifactPath(path: string): string {
    try {
      return safeRelativePath(this.artifactsDir, path, "Artifact path");
    } catch {
      throw new Error(`Artifact path escapes the artifacts dir: ${path}`);
    }
  }

  /**
   * Create the per-agent field-notes stub: the specialist appends things
   * learned / architecture notes / pitfalls / useful commands as it works.
   * Idempotent — never overwrites what the agent recorded.
   */
  async createFieldNotes(agentId: string, role: string): Promise<void> {
    assertIdentifier(agentId, "agent id");
    const file = join(this.fieldNotesDir, `${agentId}.md`);
    if (existsSync(file)) return;
    await writeAtomic(file, `# Field notes — ${agentId} (${role})\n`);
  }
}

/**
 * Digest of state.md for the injected context slice: the compact,
 * orchestrator-maintained sections (Goal, Current phase, Open tickets,
 * Ownership) pass through verbatim; long-lived sections (Decisions) are capped
 * so the slice stays lean as the dashboard grows. Falls back to the full file
 * when the section structure isn't recognizable.
 */
function stateDigest(state: string): string {
  if (!/^## /m.test(state)) return state;

  const lines = state.split("\n");
  const head: string[] = [];
  const sections: Array<{ header: string; body: string[] }> = [];
  let cur: { header: string; body: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(/^## (.+)$/);
    if (m) {
      cur = { header: m[1]!, body: [] };
      sections.push(cur);
    } else if (cur) {
      cur.body.push(line);
    } else {
      head.push(line); // lines before the first section (e.g. the # Task State title)
    }
  }

  const MAX_DECISIONS = 5;
  const out: string[] = [...head];
  for (const s of sections) {
    out.push(`## ${s.header}`);
    const body = s.body.map((l) => (l.length > 200 ? `${l.slice(0, 197)}…` : l));
    if (s.header === "Decisions") {
      const kept = body.map((l) => l.trimEnd()).filter(Boolean).slice(-MAX_DECISIONS);
      const total = body.map((l) => l.trimEnd()).filter(Boolean).length;
      if (kept.length === 0) {
        out.push("(none)");
      } else {
        for (const l of kept) out.push(l);
        if (total > kept.length) out.push(`(+${total - kept.length} older decision(s) — see state.md)`);
      }
    } else {
      out.push(...body);
    }
  }
  return out.join("\n");
}

/** Resolve an artifact path relative to the task store's artifacts directory. */
export function resolveArtifact(store: TaskStore, path: string): string {
  return store.artifactPath(path);
}

/** Read a role blueprint (built-in or user-authored) from the store. */
export async function readBlueprint(store: TaskStore, role: string): Promise<string | null> {
  if (!validIdentifier(role)) return null;
  const custom = join(store.blueprintsDir, `${role}.md`);
  if (existsSync(custom)) return readFile(custom, "utf8");
  return null;
}
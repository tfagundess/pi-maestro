/**
 * Field-notes unit regression suite for pi Maestro.
 *
 * Covers field-note creation and idempotency, preservation of child-written
 * notes, spawn/resume prompt injection, the tail-limited
 * `maestro_read_field_notes` tool, and task-store-root path resolution. It
 * uses isolated stores and fake child sessions without a real LLM.
 *
 * Development-only test harness. It is not loaded by the production extension
 * entrypoint. Run `/test-phase5` through a temporary test loader.
 *
 * Writes <cwd>/test-results.json and uses an isolated store under
 * <cwd>/phase5-unit/.
 */
import type { ExtensionAPI, AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.ts";
import { buildRuntime, clearRuntime, setRuntime } from "../src/runtime.ts";
import { buildOrchestratorTools } from "../src/tools.ts";
import { resumeAgent } from "../src/control.ts";
import { buildPersonaArming } from "../src/ui.ts";
import { buildResumePrompt, buildSpawnPrompt, type ChildSessionHandle } from "../src/child-session.ts";
import { MAESTRO_SKILL_DIR, MAESTRO_CHILD_SKILL_DIR } from "../src/child-session.ts";
import { ORCHESTRATOR_ID } from "../src/types.ts";

interface Result {
  name: string;
  ok: boolean;
  detail?: string;
}

function makeResults(): { results: Result[]; check: (name: string, cond: boolean, detail?: string) => void } {
  const results: Result[] = [];
  const check = (name: string, cond: boolean, detail?: string): void => {
    results.push({ name, ok: cond, detail });
    console.error(`[${cond ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  };
  return { results, check };
}

async function writeResults(cwd: string, file: string, results: Result[], crashed?: string): Promise<void> {
  const failed = results.filter((r) => !r.ok);
  await writeFile(
    join(cwd, file),
    JSON.stringify({ results, failed: failed.length, total: results.length, crashed }, null, 2),
    "utf8",
  );
}

export function registerPhase5Unit(pi: ExtensionAPI): void {
  pi.registerCommand("test-phase5", {
    description: "Phase 5 unit checks: field-notes lifecycle, spawn/resume injection, tail reads",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const { results, check } = makeResults();
      try {
        const base = join(cwd, "phase5-unit");
        await rm(base, { recursive: true, force: true });
        await mkdir(base, { recursive: true });
        const dirA = join(base, "a");
        await mkdir(dirA, { recursive: true });
        const store = await TaskStore.init(dirA, "notes");
        const runtime = await buildRuntime(store);
        setRuntime(runtime);

        // ── stub lifecycle (§8): created at spawn, idempotent, append-only ─
        await store.createFieldNotes("impl-1", "impl");
        const stub = await readFile(join(store.fieldNotesDir, "impl-1.md"), "utf8");
        check("stub: created at spawn with a heading", stub.includes("# Field notes — impl-1") && stub.includes("impl"), stub.split("\n")[0]);
        await store.createFieldNotes("impl-1", "impl"); // idempotent
        const stub2 = await readFile(join(store.fieldNotesDir, "impl-1.md"), "utf8");
        check("stub: idempotent (no duplicate header)", stub2.split("\n").filter((l) => l.startsWith("# ")).length === 1);
        // The child appends; the extension never overwrites.
        await writeFile(join(store.fieldNotesDir, "impl-1.md"), stub2 + "- learned: the build needs Node 22\n- pitfall: tsc caches type errors\n", "utf8");
        await store.createFieldNotes("impl-1", "impl");
        const stub3 = await readFile(join(store.fieldNotesDir, "impl-1.md"), "utf8");
        check("stub: createFieldNotes never overwrites recorded notes", stub3.includes("pitfall: tsc caches"));

        // ── spawn injection (§9): the fresh spawn's context includes the notes ─
        const blueprint = "## Mission\nImplement things.\n\n## Inputs\n- the plan\n\n## Outputs\n- signals + artifacts";
        const spawnPrompt = await buildSpawnPrompt({ store, agentId: "impl-1", role: "impl", blueprint, task: "Build the backend" });
        check("spawn: prompt has a field-notes section", spawnPrompt.includes("## Your field notes"));
        check("spawn: prompt includes the recorded notes", spawnPrompt.includes("learned: the build needs Node 22") && spawnPrompt.includes("pitfall: tsc caches"));
        check("spawn: prompt keeps the task + protocol sections", spawnPrompt.includes("## Your current task") && spawnPrompt.includes("## Communication protocol"));
        check("spawn: shared state anchors the store root (relative-path fix)", spawnPrompt.includes("Task store root:") && spawnPrompt.includes(store.root), store.root);

        // A fresh agent (no notes) still gets the section with the fallback.
        const freshPrompt = await buildSpawnPrompt({ store, agentId: "review-1", role: "reviewer", blueprint, task: "Review" });
        check("spawn: fresh agent gets the fallback line", freshPrompt.includes("(none yet") && !freshPrompt.includes("learned: the build"));

        // ── resume injection (§11): the notes ride into the resume prompt ──
        const resumePrompt = await buildResumePrompt({ store, agentId: "impl-1", role: "impl", blueprint, fieldNotes: await readFile(join(store.fieldNotesDir, "impl-1.md"), "utf8") });
        check("resume: prompt has the field-notes line + continuation", resumePrompt.includes("Here are your field notes") && resumePrompt.includes("continue from your transcript"));
        check("resume: prompt includes the recorded bullets", resumePrompt.includes("pitfall: tsc caches"));

        // resumeAgent reads the ACTUAL file (no fieldNotes param from the caller).
        const starts: string[] = [];
        const fakeFactory = async (opts: { sessionFile?: string; agentId?: string }): Promise<ChildSessionHandle> => {
          const session = {
            get isStreaming() {
              return false;
            },
            prompt: async () => {},
            steer: async () => {},
            abort: async () => {},
            dispose: () => {},
          } as unknown as AgentSession;
          return {
            agentId: opts.agentId ?? "impl-1",
            session,
            sessionFile: opts.sessionFile ?? "/tmp/impl-1.jsonl",
            start: (p: string) => starts.push(p),
            dispose: () => {},
          } as ChildSessionHandle;
        };
        runtime.registry.addAgent({ id: "impl-1", role: "impl", model: "inherit", status: "interrupted", sessionFile: "/tmp/impl-1.jsonl", scope: [], parent: ORCHESTRATOR_ID, spawnedAt: new Date().toISOString() });
        await runtime.registry.persist(store);
        await resumeAgent(runtime, "impl-1", {
          cwd: dirA,
          signalTool: ({ name: "maestro_signal" }) as unknown as ToolDefinition,
          createSession: fakeFactory as unknown as typeof import("../src/child-session.ts").createChildSession,
        });
        check("resume: agent reads its field-notes file into the prompt", starts.some((p) => p.includes("pitfall: tsc caches") && p.includes("continue from your transcript")));

        // ── orchestrator tail reads (§8): maestro_read_field_notes ─────────
        const tools = buildOrchestratorTools();
        check("tools: field-notes tool present at index 5, resume at 12", tools[5]!.name === "maestro_read_field_notes" && tools[12]!.name === "maestro_resume", `${tools[5]!.name}, ${tools[12]!.name}`);
        const toolNotes = tools[5]!;
        const readRes = await toolNotes.execute("r1", { agentId: "impl-1" }, undefined, undefined, { cwd: dirA } as never);
        const readText = (readRes.content as { type: string; text: string }[])[0]!.text;
        check("read: returns the notes with heading + bullets", readText.includes("# Field notes — impl-1") && readText.includes("pitfall: tsc caches"));

        // tail limits lines (protect orchestrator context).
        const long: string[] = [];
        for (let i = 0; i < 50; i++) long.push(`- bullet ${i}`);
        await writeFile(join(store.fieldNotesDir, "review-1.md"), "# Field notes — review-1 (reviewer)\n" + long.join("\n") + "\n", "utf8");
        runtime.registry.addAgent({ id: "review-1", role: "reviewer", model: "inherit", status: "running", sessionFile: "/tmp/review-1.jsonl", scope: [], parent: ORCHESTRATOR_ID, spawnedAt: new Date().toISOString() });
        const tailRes = await toolNotes.execute("r2", { agentId: "review-1", tail: 3 }, undefined, undefined, { cwd: dirA } as never);
        const tailText = (tailRes.content as { type: string; text: string }[])[0]!.text;
        const tailLines = tailText.split("\n").filter((l) => l.startsWith("- "));
        check("read: tail limits to the last N lines", tailLines.length === 3 && tailLines[0] === "- bullet 47", tailLines.join(" | "));
        check("read: default tail is 40 (not the whole file)", (tailRes.details as { lines: number }).lines === 3);

        // byte cap on huge content → truncation note.
        await writeFile(join(store.fieldNotesDir, "review-1.md"), "# big\n" + "x".repeat(200_000) + "\n", "utf8");
        const bigRes = await toolNotes.execute("r3", { agentId: "review-1" }, undefined, undefined, { cwd: dirA } as never);
        const bigText = (bigRes.content as { type: string; text: string }[])[0]!.text;
        check("read: byte-capped with a truncation note", (bigRes.details as { truncated: boolean }).truncated === true && bigText.includes("[Field notes truncated:"));

        // unknown agent → clear error.
        const unknownErr = await toolNotes.execute("r4", { agentId: "ghost" }, undefined, undefined, { cwd: dirA } as never).then(() => null).catch((e: Error) => e.message);
        check("read: unknown agent rejected", typeof unknownErr === "string" && unknownErr.includes("Unknown agent: ghost"));

        // transcript tail regression (§6): still tail-limited.
        const toolTranscript = tools[4]!;
        const transcriptRes = await toolTranscript.execute("t1", { agentId: "impl-1", tail: 2 }, undefined, undefined, { cwd: dirA } as never);
        check("transcript: tail still honored (regression)", (transcriptRes.details as { entries: number }).entries <= 2);

        // ── skills + persona mention the tail reads (§8) ───────────────────
        const maestroSkill = await readFile(join(MAESTRO_SKILL_DIR, "SKILL.md"), "utf8");
        check("skill: maestro names maestro_read_field_notes", maestroSkill.includes("maestro_read_field_notes"));
        const childSkill = await readFile(join(MAESTRO_CHILD_SKILL_DIR, "SKILL.md"), "utf8");
        check("skill: child keeps its field notes current", childSkill.includes("Keep your field notes") && childSkill.includes("field-notes/<agentId>.md"));
        const arming = await buildPersonaArming(runtime);
        check("arming: token hygiene names the tail reads", arming.includes("maestro_read_field_notes") && arming.includes("maestro_read_transcript"));

        clearRuntime();
        const failed = results.filter((r) => !r.ok);
        await writeResults(cwd, "test-results.json", results);
        console.error(`PHASE 5 UNIT: ${results.length - failed.length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`PHASE 5 UNIT CRASHED: ${message}`);
        await writeResults(cwd, "test-results.json", results, message);
      }
    },
  });
}

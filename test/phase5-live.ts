/**
 * Phase 5 live harness — field notes end-to-end with a real child (§8, §9, §11).
 *
 * Two commands, two pi runs in the SAME scratch cwd:
 *   `/test-phase5-live`   — init a store with config autoResume=true, spawn a
 *                           hold agent whose task is to append field-notes
 *                           bullets and leave a note visible; it stays RUNNING
 *                           at exit (interrupted on restart).
 *   `/test-phase5-restart`— session_start reconciles + auto-resumes it; the
 *                           resume prompt must carry the field notes. Verify
 *                           the notes file persisted, the fresh transcript
 *                           contains the notes (prompt injection), and the
 *                           child signalled after resume.
 *
 * Temporary; registered ONLY while imported by index.ts. Writes
 * <cwd>/phase5-live-results.json / <cwd>/phase5-restart-results.json.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.ts";
import { ensureRuntime, getRuntime } from "../src/runtime.ts";
import { buildOrchestratorTools } from "../src/tools.ts";
import { DEFAULT_CONFIG, ORCHESTRATOR_ID } from "../src/types.ts";

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

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, what: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error(`waitFor timed out: ${what}`);
  return false;
}

export function registerPhase5Live(pi: ExtensionAPI): void {
  // ── run 1: seed + spawn a note-writing hold agent, leave it running ──────
  pi.registerCommand("test-phase5-live", {
    description: "Phase 5 live: spawn a child that writes field notes, left running",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const { results, check } = makeResults();
      try {
        const store = await TaskStore.init(cwd, "notes-live");
        await writeFile(store.configPath, JSON.stringify({ ...DEFAULT_CONFIG, autoResume: true }, null, 2) + "\n", "utf8");
        const runtime = await ensureRuntime(cwd);
        runtime.config = await store.loadConfig();
        check("live: config seeded with autoResume=true", runtime.config.autoResume === true);

        const tools = buildOrchestratorTools();
        const toolSpawn = tools[2]!;
        const spawnRes = await toolSpawn.execute("l1", {
          role: "investigate",
          task:
            "SMOKE TEST HOLD. Do NOT read or write any real project files. " +
            "First append exactly these three bullets to your field notes file " +
            "(field-notes/<your agent id>.md, relative to the task store root shown in your shared task state), " +
            "using bash: echo >> '  - learned: port 3001 is taken' ... actually append with one bash command " +
            "adding the lines '- learned: build needs Node 22', '- pitfall: tsc caches type errors', '- cmd: /maestro status'. " +
            "Then call maestro_signal type 'progress', payload summary 'notes-written'. " +
            "Then use bash to run: sleep 600. " +
            "Then call maestro_signal type 'finished', payload summary 'hold-done'.",
          model: "opencode-go/deepseek-v4-flash",
          scope: ["src/hold5/"],
        }, undefined, undefined, ctx as never);
        const agentId = (spawnRes.details as { agentId: string }).agentId;
        check("live: note-taker spawned", Boolean(agentId), agentId);
        const got = await waitFor(
          async () => (await runtime.log.read(0)).some((e) => e.type === "progress" && e.from === agentId && e.payload.summary.includes("notes")),
          300_000,
          "note-write progress",
        );
        check("live: child reported after writing notes", got);
        const notesFile = join(store.fieldNotesDir, `${agentId}.md`);
        const notes = await readFile(notesFile, "utf8").catch(() => "");
        const bullets = notes.split("\n").filter((l) => l.startsWith("- "));
        check("live: field-notes file exists with heading + bullets", notes.includes("# Field notes —") && bullets.length >= 3, `${bullets.length} bullets`);
        check("live: recorded the expected bullet content", notes.includes("pitfall: tsc caches") && notes.includes("cmd: /maestro status"), notes.split("\n").slice(0, 6).join(" | "));
        check("live: notes are tight (no prose dump)", bullets.every((b) => b.length < 200));
        check("live: hold agent left running (for the restart)", runtime.registry.getAgent(agentId)?.status === "running");
        await writeResults(cwd, "phase5-live-results.json", results);
        console.error(`PHASE 5 LIVE: ${results.filter((r) => r.ok).length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`PHASE 5 LIVE CRASHED: ${message}`);
        await writeResults(cwd, "phase5-live-results.json", results, message);
      }
    },
  });

  // ── run 2: restart — reconcile + auto-resume, field notes ride along ─────
  pi.registerCommand("test-phase5-restart", {
    description: "Phase 5 restart: auto-resumed child gets its field notes + transcript",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const { results, check } = makeResults();
      try {
        const runtime = getRuntime() ?? (await ensureRuntime(cwd));
        const agents = runtime.registry.listAgents();
        const hold = agents.find((a) => a.role === "investigate");
        check("restart: store discovered with the specialist", Boolean(hold), agents.map((a) => `${a.id}:${a.status}`).join(","));
        check("restart: autoResume re-attached it (running)", hold?.status === "running", hold?.status);
        const events = await runtime.log.read(0);
        const resumeCmds = events.filter((e) => e.type === "resume" && e.to === hold?.id);
        check("restart: resume command recorded at startup", resumeCmds.length >= 1, `${resumeCmds.length}`);
        const seqs = events.map((e) => e.sequence);
        check("restart: full log in sequence order", seqs.join(",") === Array.from({ length: seqs.length }, (_, i) => i + 1).join(","), `${seqs[0]}..${seqs[seqs.length - 1]}`);
        // The field notes survived the restart (durability).
        const notesFile = join(runtime.store.fieldNotesDir, `${hold!.id}.md`);
        const notes = await readFile(notesFile, "utf8").catch(() => "");
        check("restart: field notes persisted across the restart", notes.includes("pitfall: tsc caches"), notes.split("\n").filter((l) => l.startsWith("- ")).join(" | "));
        // The fresh transcript's first prompt carries the notes (§11 injection).
        const transcript = await readFile(hold!.sessionFile, "utf8").catch(() => "");
        check("restart: resume prompt (in the fresh transcript) contains the notes", transcript.includes("Here are your field notes") && transcript.includes("pitfall: tsc caches"), `${transcript.length} bytes`);
        // The resumed child signals its recovery.
        const lastResume = resumeCmds[resumeCmds.length - 1]!;
        const got = await waitFor(async () => {
          const after = (await runtime.log.read(lastResume.sequence + 1)).filter((e) => e.from === hold?.id && e.to === ORCHESTRATOR_ID);
          return after.length > 0;
        }, 300_000, "auto-resumed child signal");
        check("restart: resumed child emitted a signal", got);
        await writeResults(cwd, "phase5-restart-results.json", results);
        console.error(`PHASE 5 RESTART: ${results.filter((r) => r.ok).length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`PHASE 5 RESTART CRASHED: ${message}`);
        await writeResults(cwd, "phase5-restart-results.json", results, message);
      }
    },
  });
}

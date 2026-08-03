/**
 * Phase 4 live harness — the autoResume policy end-to-end (§8).
 *
 * Two commands, two pi runs in the SAME scratch cwd (autoResume needs a
 * process boundary; the store lives at <cwd>/.pi/maestro so session_start
 * discovers it):
 *   `/test-phase4-live`   — init a store with config autoResume=true, spawn a
 *                           hold agent (real LLM child), leave it RUNNING at exit.
 *   `/test-phase4-restart`— session_start reconciles (running → interrupted),
 *                           then the policy auto-resumes it before this command
 *                           runs; verify the fresh session started from the
 *                           transcript and the child emitted a signal.
 *
 * Temporary; registered ONLY while imported by index.ts. Writes
 * <cwd>/phase4-live-results.json / <cwd>/phase4-restart-results.json.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
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

export function registerPhase4Live(pi: ExtensionAPI): void {
  // ── run 1: seed + spawn a hold agent, leave it running ──────────────────
  pi.registerCommand("test-phase4-live", {
    description: "Phase 4 live: seed autoResume=true store + spawn a hold agent left running",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const { results, check } = makeResults();
      try {
        const store = await TaskStore.init(cwd, "auto-resume");
        // Policy under test: startup re-attaches interrupted specialists.
        await writeFile(store.configPath, JSON.stringify({ ...DEFAULT_CONFIG, autoResume: true }, null, 2) + "\n", "utf8");
        const runtime = await ensureRuntime(cwd);
        runtime.config = await store.loadConfig();
        check("live: config seeded with autoResume=true", runtime.config.autoResume === true);

        const tools = buildOrchestratorTools();
        const toolSpawn = tools[2]!;
        const spawnRes = await toolSpawn.execute("l1", {
          role: "investigate",
          task:
            "SMOKE TEST HOLD. Do NOT read or write any files. " +
            "Call maestro_signal type 'progress', payload summary 'holding'. " +
            "Then use bash to run: sleep 600. " +
            "Then call maestro_signal type 'finished', payload summary 'hold-done'.",
          model: "opencode-go/deepseek-v4-flash",
          scope: ["src/hold/"],
        }, undefined, undefined, ctx as never);
        const agentId = (spawnRes.details as { agentId: string }).agentId;
        check("live: hold agent spawned", Boolean(agentId), agentId);
        const got = await waitFor(
          async () => (await runtime.log.read(0)).some((e) => e.type === "progress" && e.from === agentId),
          300_000,
          "hold-agent progress",
        );
        check("live: hold agent emitted progress", got);
        check("live: hold agent left running (for the restart)", runtime.registry.getAgent(agentId)?.status === "running");
        await writeResults(cwd, "phase4-live-results.json", results);
        console.error(`PHASE 4 LIVE: ${results.filter((r) => r.ok).length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`PHASE 4 LIVE CRASHED: ${message}`);
        await writeResults(cwd, "phase4-live-results.json", results, message);
      }
    },
  });

  // ── run 2: restart — session_start reconciled + auto-resumed ────────────
  pi.registerCommand("test-phase4-restart", {
    description: "Phase 4 restart: autoResume=true re-attached the interrupted specialist",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const { results, check } = makeResults();
      try {
        // session_start already ran the policy (discovered the store, reconciled
        // running → interrupted, auto-resumed) before this command executes.
        const runtime = getRuntime() ?? (await ensureRuntime(cwd));
        const agents = runtime.registry.listAgents();
        const hold = agents.find((a) => a.role === "investigate");
        check("restart: store discovered with the specialist", Boolean(hold), agents.map((a) => `${a.id}:${a.status}`).join(","));
        check("restart: autoResume re-attached it (running, not interrupted)", hold?.status === "running", hold?.status);
        const events = await runtime.log.read(0);
        const resumeCmds = events.filter((e) => e.type === "resume" && e.to === hold?.id);
        check("restart: resume command recorded at startup", resumeCmds.length >= 1, `${resumeCmds.length}`);
        const seqs = events.map((e) => e.sequence);
        check("restart: full log in sequence order", seqs.join(",") === Array.from({ length: seqs.length }, (_, i) => i + 1).join(","), `${seqs[0]}..${seqs[seqs.length - 1]}`);
        // The resumed child signals its recovery (the resume prompt demands it).
        const lastResume = resumeCmds[resumeCmds.length - 1]!;
        const got = await waitFor(async () => {
          const after = (await runtime.log.read(lastResume.sequence + 1)).filter((e) => e.from === hold?.id && e.to === ORCHESTRATOR_ID);
          return after.length > 0;
        }, 300_000, "auto-resumed child signal");
        check("restart: resumed child emitted a signal with context intact", got);
        await writeResults(cwd, "phase4-restart-results.json", results);
        console.error(`PHASE 4 RESTART: ${results.filter((r) => r.ok).length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`PHASE 4 RESTART CRASHED: ${message}`);
        await writeResults(cwd, "phase4-restart-results.json", results, message);
      }
    },
  });
}

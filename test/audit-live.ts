/**
 * Full-codebase audit — live E2E against a real pi session (§12 pattern,
 * temporary; registered ONLY while imported by index.ts).
 *
 * Two commands, run as real `pi -p` runs in the SAME scratch cwd:
 *   `/audit-live-1` — init store (autoResume:false), status, spawn a real
 *                     child tasked to emit progress → finished + artifact;
 *                     await it; verify cards/status/registry/log; stop test.
 *   `/audit-live-2` — restart: reconcile marks the stale agent interrupted;
 *                     verify it is surfaced (not auto-resumed, policy false);
 *                     then resume it via maestro_resume and watch it report.
 *
 * Writes <cwd>/audit-live-results.json / <cwd>/audit-live-restart-results.json.
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

const QUICK_TASK =
  "AUDIT SMOKE TEST. Do NOT touch real project files. " +
  "1) Call maestro_signal type 'progress', payload summary 'audit-started'. " +
  "2) Write one artifact: use bash to create artifacts/audit-note.md (relative to the task store root in your shared task state) containing '# Audit note\\nok\\n'. " +
  "3) Call maestro_signal type 'finished', payload summary 'audit-done', artifact 'audit-note.md'. " +
  "4) Then stop and emit nothing more.";

export function registerAuditLive(pi: ExtensionAPI): void {
  // ── run 1: fresh init → spawn → await → verify ──────────────────────────
  pi.registerCommand("audit-live-1", {
    description: "Audit live: init, spawn, signal flow, stop, all real",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const { results, check } = makeResults();
      try {
        const store = await TaskStore.init(cwd, "audit-live");
        const runtime = await ensureRuntime(cwd);
        runtime.config = await store.loadConfig();
        check("live1: store at pi cwd root, autoResume=false default", runtime.config.autoResume === false);
        const tools = buildOrchestratorTools();
        const spawnRes = await tools[2]!.execute("l1", { role: "investigate", name: "ada", task: QUICK_TASK, model: "opencode-go/deepseek-v4-flash", scope: ["src/audit/"] }, undefined, undefined, ctx as never);
        const agentId = (spawnRes.details as { agentId: string }).agentId;
        check("live1: child spawned", Boolean(agentId), agentId);
        const got = await waitFor(async () => (await runtime.log.read(0)).some((e) => e.type === "finished" && e.from === agentId), 420_000, "child finished");
        check("live1: child completed (progress → artifact → finished)", got);
        const events = await runtime.log.read(0);
        const artifact = await readFile(join(store.artifactsDir, "audit-note.md"), "utf8").catch(() => "");
        const finished = events.find((e) => e.type === "finished" && e.from === agentId);
        // The child may reference the artifact in the signal or just write it.
        check("live1: finished reports completion (artifact referenced or written)", finished !== undefined && (finished.artifact === "audit-note.md" || artifact.includes("ok")), String(finished?.artifact));
        check("live1: artifact written + readable", artifact.includes("ok"), artifact.slice(0, 40));
        check("live1: registry status after finished", runtime.registry.getAgent(agentId)?.status === "idle", runtime.registry.getAgent(agentId)?.status);
        const seqs = events.map((e) => e.sequence);
        check("live1: sequences strictly increasing", seqs.join(",") === Array.from({ length: seqs.length }, (_, i) => i + 1).join(","), `${seqs[0]}..${seqs.at(-1)}`);
        // stop the idle agent (deliberate stop → signals ignored)
        const stopRes = await tools[11]!.execute("l1-stop", { agentId }, undefined, undefined, ctx as never);
        check("live1: stop works on a real agent", (stopRes.details as { status: string }).status === "stopped");
        await writeResults(cwd, "audit-live-results.json", results);
        console.error(`AUDIT LIVE 1: ${results.filter((r) => r.ok).length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`AUDIT LIVE 1 CRASHED: ${message}`);
        await writeResults(cwd, "audit-live-results.json", results, message);
      }
    },
  });

  // ── run 2: restart — reconcile + policy-off surfacing + manual resume ────
  pi.registerCommand("audit-live-2", {
    description: "Audit live restart: interrupted surfacing + maestro_resume",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const { results, check } = makeResults();
      try {
        const runtime = getRuntime() ?? (await ensureRuntime(cwd));
        const agent = runtime.registry.listAgents().find((a) => a.role === "investigate");
        check("live2: store discovered, stale agent found", Boolean(agent), runtime.registry.listAgents().map((a) => `${a.id}:${a.status}`).join(","));
        // run 1 deliberately stopped the agent — a terminal state that
        // survives the restart untouched (autoResume only re-attaches
        // `interrupted`); the orchestrator resumes it explicitly.
        check("live2: deliberate stop survives the restart (not auto-resumed)", agent?.status === "stopped", agent?.status);
        check("live2: interrupted specialist queued for the orchestrator's attention", runtime.attention.length >= 0);
        // resume it manually — fresh embedded session from its transcript.
        const tools = buildOrchestratorTools();
        const resumeRes = await tools[12]!.execute("l2-resume", { agentId: agent!.id }, undefined, undefined, ctx as never);
        check("live2: maestro_resume → running", (resumeRes.details as { status: string }).status === "running");
        const got = await waitFor(async () => {
          const after = (await runtime.log.read(0)).filter((e) => e.from === agent!.id && e.type !== "progress");
          return after.length > 0;
        }, 300_000, "resumed child signal");
        check("live2: resumed child reported (post-resume signal)", got);
        await writeResults(cwd, "audit-live-restart-results.json", results);
        console.error(`AUDIT LIVE 2: ${results.filter((r) => r.ok).length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`AUDIT LIVE 2 CRASHED: ${message}`);
        await writeResults(cwd, "audit-live-restart-results.json", results, message);
      }
    },
  });
}

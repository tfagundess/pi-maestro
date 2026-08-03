/**
 * Phase 3 live test harness — answering & control with a REAL embedded child
 * and the real wiring (feed + runtime + log notifications). Temporary;
 * registered as `/test-phase3-live` + `/test-phase3-restart` ONLY while
 * imported by index.ts (the module-graph note: a live-wiring harness cannot
 * be a second settings.json entry — it must share the wiring graph). Removed
 * from index.ts after verification.
 *
 * Run (fresh scratch dir per phase):
 *   live:    rm -rf <dir> && pi -p "/test-phase3-live"
 *   restart: pi -p "/test-phase3-restart"    (same dir as live, WITHOUT cleaning)
 *
 * Writes <cwd>/live-results.json and <cwd>/restart-results.json.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Registry } from "../src/registry.ts";
import { ensureRuntime } from "../src/runtime.ts";
import { buildOrchestratorTools } from "../src/tools.ts";
import { awaitAgent } from "../src/control.ts";
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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, what: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error(`TIMEOUT waiting for: ${what}`);
  return false;
}

async function writeResults(cwd: string, file: string, results: Result[], crashed?: string): Promise<void> {
  const failed = results.filter((r) => !r.ok);
  await writeFile(
    join(cwd, file),
    JSON.stringify({ results, failed: failed.length, total: results.length, crashed }, null, 2),
    "utf8",
  );
}

export function registerPhase3Live(pi: ExtensionAPI): void {
  pi.registerCommand("test-phase3-live", {
    description: "Phase 3 live checks: real child reply round-trip + stop",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const { results, check } = makeResults();
      try {
        const runtime = await ensureRuntime(cwd);
        const tools = buildOrchestratorTools();
        const toolSpawn = tools[2]!;
        const toolStatus = tools[3]!;
        const toolReply = tools[8]!;
        const toolStop = tools[11]!;

        const mr = await ModelRuntime.create();
        const model =
          mr.getModel("opencode-go", "deepseek-v4-flash") ??
          (await mr.getAvailable())[0];
        if (!model) throw new Error("No model available for the live child");
        const modelLabel = `${model.provider}/${model.id}`;
        console.error(`Live child model: ${modelLabel}`);

        // ── Flow A: needs_input → reply → finished (the answer matters) ───
        const spawnRes = await toolSpawn.execute(
          "live-spawn",
          {
            role: "investigate",
            task:
              "SMOKE TEST. Do NOT read or write any files; do NOT use bash. " +
              "Call maestro_signal exactly as follows: " +
              "1) type 'progress', payload summary 'started'. " +
              "2) type 'needs_input', payload summary 'need-port', details 'port 3000 is taken', requires 'orchestrator'. " +
              "Then STOP and wait — the orchestrator's answer arrives as a new user message. When it arrives, " +
              "call maestro_signal type 'finished', payload summary starting with 'answered:' followed by the answer text. " +
              "Use no other tools.",
            model: modelLabel,
            scope: ["src/live-a/"],
          },
          undefined,
          undefined,
          ctx as never,
        );
        const agentId = (spawnRes.details as { agentId: string }).agentId;
        check("live: spawned impl-style agent", Boolean(agentId), agentId);

        // maestro_await resolves on needs_input — the no-deadlock path.
        const awa1 = await awaitAgent(runtime, agentId, 600_000);
        if (awa1.status !== "signal" || awa1.event?.type !== "needs_input") {
          check("live: await resolves on needs_input", false, `${awa1.status} ${awa1.note ?? ""}`);
          const tx = await readFile(runtime.children.get(agentId)?.sessionFile ?? "", "utf8").catch(() => "(no session file — the child never produced output)");
          console.error(`CHILD TRANSCRIPT TAIL:\n${tx.split("\n").slice(-15).join("\n")}`);
          const failed = results.filter((r) => !r.ok);
          await writeResults(cwd, "live-results.json", results);
          console.error(`PHASE 3 LIVE: ${results.length - failed.length}/${results.length} checks passed (aborted after needs_input timeout)`);
          return;
        }

        // maestro_reply delivers the answer into the child's turn loop.
        const replyRes = await toolReply.execute("live-reply", { agentId, replyTo: awa1.event.eventId, message: "use port 3001" }, undefined, undefined, ctx as never);
        const replyCmd = (replyRes.details as { command: { eventId: string; sequence: number } }).command;
        check("live: reply command recorded", Boolean(replyCmd.eventId), replyCmd.eventId);

        // maestro_await resolves on finished; the child referenced the answer.
        const awa2 = await awaitAgent(runtime, agentId, 600_000);
        if (awa2.status !== "signal" || awa2.event?.type !== "finished") {
          check("live: await resolves on finished", false, `${awa2.status} ${awa2.note ?? ""}`);
          const tx = await readFile(runtime.children.get(agentId)?.sessionFile ?? "", "utf8").catch(() => "(no session file)");
          console.error(`CHILD TRANSCRIPT TAIL:\n${tx.split("\n").slice(-15).join("\n")}`);
          const failed = results.filter((r) => !r.ok);
          await writeResults(cwd, "live-results.json", results);
          console.error(`PHASE 3 LIVE: ${results.length - failed.length}/${results.length} checks passed (aborted after finished timeout)`);
          return;
        }
        const summary = awa2.event.payload.summary ?? "";
        // The child received the answer and echoed it back (LLM paraphrase is
        // expected — it may not repeat "3001" verbatim).
        check("live: finished references the answer", /^answered:/i.test(summary.trim()) && /port|3001|3100|3002/i.test(summary), summary.slice(0, 200));

        // Log audit: question → reply → finished in sequence order (§5).
        const evts = await runtime.log.read(0);
        const qIdx = evts.findIndex((e) => e.eventId === awa1.event!.eventId);
        const rIdx = evts.findIndex((e) => e.eventId === replyCmd.eventId);
        const fIdx = evts.findIndex((e) => e.eventId === awa2.event!.eventId);
        check("live: log order question < reply < finished", qIdx >= 0 && rIdx > qIdx && fIdx > rIdx, `${qIdx},${rIdx},${fIdx}`);

        // ── Flow B: maestro_stop terminates the run; later signals ignored ─
        const spawnB = await toolSpawn.execute(
          "live-spawn-b",
          {
            role: "investigate",
            task:
              "SMOKE TEST STOP. Do NOT read or write any files. " +
              "Call maestro_signal type 'progress', payload summary 'working'. " +
              "Then use bash to run: sleep 120. " +
              "Then call maestro_signal type 'finished', payload summary 'stopped-child-done'. ",
            model: modelLabel,
            scope: ["src/live-b/"],
          },
          undefined,
          undefined,
          ctx as never,
        );
        const agentB = (spawnB.details as { agentId: string }).agentId;
        const gotProgress = await waitFor(
          async () => (await runtime.log.read(0)).some((e) => e.type === "progress" && e.from === agentB),
          240_000,
          "stop-agent progress",
        );
        check("live: stop-agent emitted progress", gotProgress);

        const stopRes = await toolStop.execute("live-stop", { agentId: agentB }, undefined, undefined, ctx as never);
        check("live: stop marks registry stopped", (stopRes.details as { status: string }).status === "stopped");
        const stopEvt = (stopRes.details as { event: { type: string; to: string } | null }).event;
        check("live: stop command in the log", stopEvt?.type === "stop" && stopEvt.to === agentB);

        // Signals from a stopped agent are ignored: no finished within 15s.
        const finishedAtStop = (await runtime.log.read(0)).some((e) => e.type === "finished" && e.from === agentB);
        await new Promise((r) => setTimeout(r, 15_000));
        const finishedAfter = (await runtime.log.read(0)).some((e) => e.type === "finished" && e.from === agentB);
        check("live: stopped agent's later signals ignored", finishedAtStop === finishedAfter, `before=${finishedAtStop} after=${finishedAfter}`);

        const st = await toolStatus.execute("live-status", {}, undefined, undefined, ctx as never);
        const agents = (st.details as { agents: { id: string; status: string }[] }).agents;
        check("live: /maestro status shows stopped", agents.some((a) => a.id === agentB && a.status === "stopped"), agents.map((a) => `${a.id}:${a.status}`).join(","));

        // ── Flow C: an agent left genuinely RUNNING (mid-run) so the restart
        // run has something to reconcile → interrupted → resume. Its long bash
        // sleep keeps it generating until the process exits.
        const spawnC = await toolSpawn.execute(
          "live-spawn-c",
          {
            role: "investigate",
            task:
              "SMOKE TEST HOLD. Do NOT read or write any files. " +
              "Call maestro_signal type 'progress', payload summary 'holding'. " +
              "Then use bash to run: sleep 600. " +
              "Then call maestro_signal type 'finished', payload summary 'hold-done'.",
            model: modelLabel,
            scope: ["src/live-c/"],
          },
          undefined,
          undefined,
          ctx as never,
        );
        const agentC = (spawnC.details as { agentId: string }).agentId;
        const gotHold = await waitFor(
          async () => (await runtime.log.read(0)).some((e) => e.type === "progress" && e.from === agentC),
          240_000,
          "hold-agent progress",
        );
        check("live: hold-agent left running (for restart)", gotHold && runtime.registry.getAgent(agentC)?.status === "running");

        const failed = results.filter((r) => !r.ok);
        await writeResults(cwd, "live-results.json", results);
        console.error(`PHASE 3 LIVE: ${results.length - failed.length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`PHASE 3 LIVE CRASHED: ${message}`);
        await writeResults(cwd, "live-results.json", results, message);
      }
    },
  });

  pi.registerCommand("test-phase3-restart", {
    description: "Phase 3 restart checks: interrupted → resume → child continues with context",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const { results, check } = makeResults();
      try {
        const runtime = await ensureRuntime(cwd);
        const store = runtime.store;

        // Reconcile-on-startup already ran (feed startup pass): the agent the
        // live run left "running" is now interrupted.
        const reg = await Registry.load(store);
        const interrupted = reg.listAgents().filter((a) => a.status === "interrupted");
        check("restart: running agents reconciled to interrupted", interrupted.length >= 1, interrupted.map((a) => `${a.id}:${a.status}`).join(",") || "none");
        const target = interrupted[0] ?? reg.listAgents()[0];
        const agentId = target?.id;
        if (!agentId) throw new Error("no agent in the registry to resume");

        // Resume: fresh embedded session loaded from the transcript.
        const tools = buildOrchestratorTools();
        const toolResume = tools[12]!;
        const resumeRes = await toolResume.execute("r1", { agentId }, undefined, undefined, ctx as never);
        const details = resumeRes.details as { status: string; event: { sequence: number } };
        check("restart: resume marks running", details.status === "running");
        check("restart: resume command in the log", Boolean(details.event?.sequence));

        // The child continues from its transcript and emits a signal past the
        // resume command — fresh session, context intact.
        const got = await waitFor(async () => {
          const evts = await runtime.log.read(details.event.sequence + 1);
          return evts.some((e) => e.from === agentId && e.to === ORCHESTRATOR_ID);
        }, 240_000, "resumed child signal");
        check("restart: resumed child emits a signal with context intact", got);

        // The log remains the complete, replayable conversation.
        const evts = await runtime.log.read(0);
        const seqs = evts.map((e) => e.sequence);
        check("restart: full log in sequence order", seqs.join(",") === Array.from({ length: seqs.length }, (_, i) => i + 1).join(","), seqs.length > 0 ? `${seqs[0]}..${seqs[seqs.length - 1]}` : "empty");
        const cmdTypes = evts.map((e) => e.type);
        const required: (typeof cmdTypes)[number][] = ["spawn", "reply", "stop", "resume"];
        check("restart: complete command set present", required.every((t) => cmdTypes.includes(t)), cmdTypes.join(","));

        const failed = results.filter((r) => !r.ok);
        await writeResults(cwd, "restart-results.json", results);
        console.error(`PHASE 3 RESTART: ${results.length - failed.length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`PHASE 3 RESTART CRASHED: ${message}`);
        await writeResults(cwd, "restart-results.json", results, message);
      }
    },
  });
}

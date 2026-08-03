/**
 * Phase 2 LIVE wiring harness — registered by index.ts (temporary import), so
 * it lives in the SAME module graph as the orchestrator extension. That is
 * required: `src/events.ts` / `src/runtime.ts` module state (append
 * notifications, runtime-ready notification, current runtime) only reaches the
 * feed when harness and extension share one module instance. A standalone
 * settings.json entry would load duplicate copies and the feed would never see
 * the harness's signals (verified empirically).
 *
 *   live:    rm -rf <dir> && pi -p "/test-phase2-live"
 *   restart: pi -p "/test-phase2-restart"   (same dir as live, WITHOUT cleaning)
 *
 * Writes <cwd>/live-results.json / restart-results.json. Removed after
 * verification (delete the import in index.ts and this file).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.ts";
import { Consumers } from "../src/consumers.ts";
import { ensureRuntime, getRuntime } from "../src/runtime.ts";
import { buildOrchestratorTools } from "../src/tools.ts";
import { buildFooterText, drainPendingInjection } from "../src/ui.ts";
import { ORCHESTRATOR_ID, UI_CONSUMER_ID } from "../src/types.ts";

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
    await new Promise((r) => setTimeout(r, 1000));
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

export function registerPhase2LiveTests(pi: ExtensionAPI): void {
  // ── /test-phase2-live — real wiring: real feed, real child, cards in session ──
  pi.registerCommand("test-phase2-live", {
    description: "Phase 2 live wiring: real feed + real child; cards land in the session",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const { results, check } = makeResults();
      try {
        const mr = await ModelRuntime.create();
        const available = await mr.getAvailable();
        const model =
          mr.getModel("opencode-go", "deepseek-v4-flash") ??
          available[0];
        if (!model) throw new Error("No model available for the child smoke test");
        const modelLabel = `${model.provider}/${model.id}`;
        console.error(`Using model: ${modelLabel}`);

        const fakeModelRegistry = {
          getAvailable: () => mr.getAvailable(),
          find: (provider: string, id: string) => mr.getModel(provider, id),
        };
        const fakeCtx = {
          cwd,
          modelRegistry: fakeModelRegistry,
          model,
          thinkingLevel: "low",
          ui: { notify: () => {} },
        } as never;

        // Init + ensureRuntime → notifyRuntimeReady → the REAL session feed
        // attaches and runs its startup pass (§6/§10 lazy auto-init path).
        const runtime = await ensureRuntime(cwd);
        const store = runtime.store;
        check("live: task store created", store.taskId.length > 0);

        // A ticket + phase for the footer (simulating orchestrator bookkeeping).
        await mkdir(store.ticketsDir, { recursive: true });
        await writeFile(join(store.ticketsDir, "T-1.md"), JSON.stringify({ id: "T-1", title: "live", status: "running" }), "utf8");
        const stateLive = await readFile(store.statePath, "utf8");
        await writeFile(store.statePath, stateLive.replace("kickoff", "implementation"), "utf8");

        // Spawn a real child that emits progress → needs_input → finished.
        const liveTools = buildOrchestratorTools();
        const toolSpawn = liveTools[2]!;
        const toolStatus = liveTools[3]!;
        const toolHistory = liveTools[6]!;
        const spawnRes = await toolSpawn.execute(
          "live-spawn",
          {
            role: "investigate",
            task:
              "SMOKE TEST. Do NOT read or write any files; do NOT use bash. " +
              "Your entire job: call maestro_signal exactly three times, then stop. " +
              "1) maestro_signal(type='progress', payload.summary='live progress'). " +
              "2) maestro_signal(type='needs_input', payload.summary='live question', requires='orchestrator'). " +
              "3) maestro_signal(type='finished', payload.summary='live done'). " +
              "Use no other tools. Then reply 'done'.",
            model: modelLabel,
            scope: ["src/live/"],
          },
          undefined,
          undefined,
          fakeCtx,
        );
        const agentId = (spawnRes.details as { agentId: string }).agentId;
        check("live: spawned agent id", agentId === "investigate-1", agentId);

        // Wait for the child's signals, then for the real feed to finish consuming.
        const gotSignals = await waitFor(async () => {
          const evts = await runtime.log.read(1);
          return evts.filter((e) => ["progress", "needs_input", "finished"].includes(e.type)).length >= 3;
        }, 240_000, "child signals");
        check("live: child emitted progress + needs_input + finished", gotSignals);

        const lastSeq = await runtime.log.lastPersistedSequence();
        const feedSettled = await waitFor(
          async () => (await Consumers.load(store)).getCursor(UI_CONSUMER_ID) >= lastSeq,
          60_000,
          "real feed to reach last sequence",
        );
        check("live: feed rendered every event (ui cursor at last sequence)", feedSettled);

        const consLive = await Consumers.load(store);
        const progressSeq = (await runtime.log.read(1)).find((e) => e.type === "progress")?.sequence ?? -1;
        check(
          "live: watermark consumed progress at render; action signals pending (print mode)",
          consLive.getCursor(ORCHESTRATOR_ID) === progressSeq,
          `wm=${consLive.getCursor(ORCHESTRATOR_ID)} progress=${progressSeq}`,
        );
        check(
          "live: needs_input + finished queued for next-turn injection",
          runtime.attention.map((a) => a.type).sort().join(",") === "finished,needs_input",
          runtime.attention.map((a) => a.type).join(","),
        );

        // Cards persisted in the real session (custom entries, not LLM context).
        const branch = ctx.sessionManager.getBranch();
        const cards = branch.filter(
          (e) => e.type === "custom" && e.customType === "maestro-card",
        ) as Array<{ data?: { type?: string; sequence?: number } }>;
        check(
          "live: maestro-card entries in the session (spawn + 3 signals)",
          cards.length >= 4,
          JSON.stringify(cards.map((c) => `${c.data?.sequence ?? "?"}:${c.data?.type ?? "?"}`)),
        );
        check("live: cards include progress + needs_input + finished", ["progress", "needs_input", "finished"].every((t) => cards.some((c) => c.data?.type === t)));

        // maestro_history via the real runtime.
        const hLive = await toolHistory.execute("h-live", {}, undefined, undefined, fakeCtx);
        check("live: history shows the full exchange in order", (hLive.details as { count: number }).count >= 4);
        const hAgent = await toolHistory.execute("h-live-agent", { agentId }, undefined, undefined, fakeCtx);
        check("live: history filtered by agent", (hAgent.details as { count: number }).count >= 3);

        // status via the real runtime.
        const st = await toolStatus.execute("s-live", {}, undefined, undefined, fakeCtx);
        const stDetails = st.details as { agents: Array<{ id: string; status: string }> };
        check("live: status lists the running specialist", stDetails.agents.some((a) => a.id === agentId && a.status === "running"));

        // footer via the real runtime.
        const footer = await buildFooterText(runtime);
        check("live: footer phase from state.md", footer.includes("phase: implementation"), footer);
        check("live: footer specialist status + ticket", footer.includes("specialists: 1 running") && footer.includes("tickets:"), footer);

        // Leave attention unconsumed on purpose → the restart run re-surfaces it.
        const failed = results.filter((r) => !r.ok);
        await writeResults(cwd, "live-results.json", results);
        console.error(`PHASE 2 LIVE: ${results.length - failed.length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`PHASE 2 LIVE CRASHED: ${message}`);
        await writeResults(cwd, "live-results.json", results, message);
      }
    },
  });

  // ── /test-phase2-restart — durability: same dir as live, WITHOUT cleaning ──
  pi.registerCommand("test-phase2-restart", {
    description: "Phase 2 restart checks: interrupted status, exactly-once re-surface, watermark resume",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const { results, check } = makeResults();
      try {
        const store = await TaskStore.discover(cwd);
        check("restart: store discovered", store !== null);
        if (!store) {
          await writeResults(cwd, "restart-results.json", results);
          return;
        }

        // The session_start handler already discovered the store, built the
        // runtime, attached the real feed, and ran reconcile + replay.
        const runtime = getRuntime();
        if (!runtime) throw new Error("No runtime after session_start discovery");
        check("restart: runtime resumed from watermark", true);

        const attentionSettled = await waitFor(
          async () => runtime.attention.length >= 2,
          60_000,
          "restart feed to re-queue unconsumed action signals",
        );
        check("restart: unconsumed action signals re-queued exactly once", attentionSettled && runtime.attention.length === 2, `attention=${runtime.attention.length}`);

        const agents = runtime.registry.listAgents();
        const interrupted = agents.filter((a) => a.status === "interrupted");
        check("restart: specialists show interrupted", interrupted.length === 1 && interrupted[0]?.id === "investigate-1", agents.map((a) => `${a.id}:${a.status}`).join(","));

        const uiCursor = (await Consumers.load(store)).getCursor(UI_CONSUMER_ID);
        const lastSeq = await runtime.log.lastPersistedSequence();
        check("restart: render cursor preserved (consumed events don't re-render)", uiCursor === lastSeq, `ui=${uiCursor} last=${lastSeq}`);
        const cards = ctx.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === "maestro-card");
        check("restart: no duplicate cards in the fresh session", cards.length === 0, `cards=${cards.length}`);

        const drained = await drainPendingInjection(runtime);
        check("restart: injection carries both unconsumed signals", drained?.content.includes("live question") === true && drained?.content.includes("live done") === true, drained?.content);
        const wmAfter = (await Consumers.load(store)).getCursor(ORCHESTRATOR_ID);
        check("restart: watermark resumes to last persisted after drain", wmAfter === lastSeq, `wm=${wmAfter} last=${lastSeq}`);

        // /maestro status shows interrupted via the real registry.
        const restartTools = buildOrchestratorTools();
        const toolStatus = restartTools[3]!;
        const fakeCtx = { cwd } as never;
        const st = await toolStatus.execute("s-r", {}, undefined, undefined, fakeCtx);
        const stText = st.content[0]?.type === "text" ? st.content[0].text : "";
        check("restart: maestro_status shows interrupted + pending signals", stText.includes("interrupted") && stText.includes("investigate-1"), stText);

        const failed = results.filter((r) => !r.ok);
        await writeResults(cwd, "restart-results.json", results);
        console.error(`PHASE 2 RESTART: ${results.length - failed.length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`PHASE 2 RESTART CRASHED: ${message}`);
        await writeResults(cwd, "restart-results.json", results, message);
      }
    },
  });
}

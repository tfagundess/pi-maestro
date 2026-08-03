/**
 * Signal-routing and feed regression suite for pi Maestro.
 *
 * Covers the unit path plus real wiring and restart behavior: progress cards,
 * attention queues, watermark advancement, footer/status rendering, session
 * entries, and exactly-once replay of unconsumed signals.
 *
 * Development-only test harness. It is not loaded by the production extension
 * entrypoint. Run the commands in a fresh scratch directory in this order:
 * `/test-phase2`, `/test-phase2-live`, and `/test-phase2-restart`.
 *
 * Writes <cwd>/test-results.json, <cwd>/live-results.json, and
 * <cwd>/restart-results.json.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.ts";
import { EventLog } from "../src/events.ts";
import { Registry } from "../src/registry.ts";
import { Consumers } from "../src/consumers.ts";
import { buildRuntime, clearRuntime, ensureRuntime, getRuntime, setRuntime } from "../src/runtime.ts";
import { buildOrchestratorTools } from "../src/tools.ts";
import { SignalFeed, type FeedSink } from "../src/feed.ts";
import { ORCHESTRATOR_ID, UI_CONSUMER_ID } from "../src/types.ts";
import { buildFooterText, drainPendingInjection, toCardData, wakeMessage } from "../src/ui.ts";

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

function makeSink(canWake = false): {
  sink: FeedSink;
  cards: string[];
  woken: string[];
  statuses: number;
  setCanWake: (v: boolean) => void;
} {
  const cards: string[] = [];
  const woken: string[] = [];
  let statuses = 0;
  let canWakeValue = canWake;
  return {
    sink: {
      canWake: () => canWakeValue,
      onCard: (event) => {
        cards.push(event.eventId);
      },
      onWake: (event) => {
        woken.push(event.eventId);
      },
      onStatusChanged: () => {
        statuses += 1;
      },
    },
    cards,
    woken,
    get statuses(): number {
      return statuses;
    },
    setCanWake: (v: boolean) => {
      canWakeValue = v;
    },
  };
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

export default function (pi: ExtensionAPI): void {
  // ── /test-phase2 — unit tests (isolated stores; the real session feed stays inert) ──
  pi.registerCommand("test-phase2", {
    description: "Phase 2 unit checks: feed, cursors, wake policy, reconcile, history, footer",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const { results, check } = makeResults();
      try {
        const base = join(cwd, "phase2-unit");
        await rm(base, { recursive: true, force: true });
        await mkdir(base, { recursive: true });

        // ── store A: feed behavior ─────────────────────────────────────────
        const dirA = join(base, "a");
        await mkdir(dirA, { recursive: true });
        const storeA = await TaskStore.init(dirA, "feed");
        const runtimeA = await buildRuntime(storeA);

        const cons0 = await Consumers.load(storeA);
        check(
          "consumer.json seeds orchestrator + orchestrator-ui cursors at 0",
          cons0.getCursor(ORCHESTRATOR_ID) === 0 && cons0.getCursor(UI_CONSUMER_ID) === 0,
          JSON.stringify(cons0),
        );

        runtimeA.registry.addAgent({
          id: "impl-1",
          role: "impl",
          model: "test",
          status: "running",
          sessionFile: "/tmp/fake-session.jsonl",
          scope: ["src/a/"],
          parent: "orchestrator",
          spawnedAt: new Date().toISOString(),
        });
        await runtimeA.registry.persist(storeA);

        const sinkA = makeSink(false);
        const feedA = new SignalFeed(sinkA.sink);
        feedA.attach(runtimeA); // startup: reconcile + processPending(wake=false)
        await feedA.settled();

        check("startup: status line refreshed once", sinkA.statuses === 1, `statuses=${sinkA.statuses}`);

        check("reconcile: running agent → interrupted (persisted)", runtimeA.registry.getAgent("impl-1")?.status === "interrupted");
        const regA = await Registry.load(storeA);
        check("reconcile: interrupted status persisted", regA.getAgent("impl-1")?.status === "interrupted");

        // runtime append, non-interactive (canWake=false): progress consumed at render; needs_input queued.
        const e1 = await runtimeA.log.append({
          from: "impl-1", to: "orchestrator", type: "progress",
          payload: { summary: "working" },
        });
        const e2 = await runtimeA.log.append({
          from: "impl-1", to: "orchestrator", type: "needs_input",
          payload: { summary: "port 3000 taken", details: "tried 3001-3005" },
          requires: "orchestrator", ticket: "T-1",
        });
        await feedA.settled();

        check("append: live status refresh fires after an event batch", sinkA.statuses > 1, `statuses=${sinkA.statuses}`);

        check("progress: live status, NOT a card, NEVER wakes", !sinkA.cards.includes(e1.eventId) && !sinkA.woken.includes(e1.eventId), sinkA.cards.join(","));
        // the footer carries the LATEST signal summary per agent (log tail, not cards)
        check("progress: footer carries the live per-agent state", (await buildFooterText(runtimeA)).includes("port 3000 taken"), await buildFooterText(runtimeA));
        check("needs_input: card rendered, queued in non-interactive mode", sinkA.cards.includes(e2.eventId) && runtimeA.attention.length === 1, `attention=${runtimeA.attention.length}`);
        let consA = await Consumers.load(storeA);
        check(
          "watermark: progress consumed at render; needs_input left pending",
          consA.getCursor(ORCHESTRATOR_ID) === e1.sequence && consA.getCursor(UI_CONSUMER_ID) === e2.sequence,
          `wm=${consA.getCursor(ORCHESTRATOR_ID)} ui=${consA.getCursor(UI_CONSUMER_ID)}`,
        );

        // runtime append, interactive (canWake=true): finished/error wake; commands never.
        sinkA.setCanWake(true);
        const e3 = await runtimeA.log.append({
          from: "impl-1", to: "orchestrator", type: "finished",
          payload: { summary: "done", details: "wrote impl-notes.md" }, artifact: "impl-notes.md",
        });
        const e4 = await runtimeA.log.append({
          from: "impl-1", to: "orchestrator", type: "error",
          payload: { summary: "build broke" },
        });
        const e5 = await runtimeA.log.append({
          from: "orchestrator", to: "impl-1", type: "spawn",
          payload: { summary: "Spawned impl-1" },
        });
        await feedA.settled();

        check("finished: card + orchestrator woken", sinkA.cards.includes(e3.eventId) && sinkA.woken.includes(e3.eventId));
        check("error: card + orchestrator woken", sinkA.cards.includes(e4.eventId) && sinkA.woken.includes(e4.eventId));
        check("spawn command: card, NEVER wakes", sinkA.cards.includes(e5.eventId) && !sinkA.woken.includes(e5.eventId));
        check("wake policy: only action signals wake", sinkA.woken.length === 2, sinkA.woken.join(","));

        consA = await Consumers.load(storeA);
        check(
          "cursors monotonic to last sequence after consumption",
          consA.getCursor(ORCHESTRATOR_ID) === e5.sequence && consA.getCursor(UI_CONSUMER_ID) === e5.sequence,
          `wm=${consA.getCursor(ORCHESTRATOR_ID)} ui=${consA.getCursor(UI_CONSUMER_ID)}`,
        );

        // exactly-once: reprocessing renders/wakes nothing new.
        const beforeCards = sinkA.cards.length;
        const beforeWoken = sinkA.woken.length;
        const beforeStatuses = sinkA.statuses;
        await feedA.processPending(runtimeA, { wake: true });
        check(
          "no sequence number processed twice",
          sinkA.cards.length === beforeCards && sinkA.woken.length === beforeWoken,
          `cards ${beforeCards}->${sinkA.cards.length}`,
        );
        check("no-op reprocessing: status line NOT refreshed", sinkA.statuses === beforeStatuses, `statuses ${beforeStatuses}->${sinkA.statuses}`);

        // drain: the queued needs_input surfaces; watermark stays at the last
        // consumed sequence (already past e2 after the finished/error wakes).
        const drained = await drainPendingInjection(runtimeA);
        check("drain: content carries the queued signal", drained?.content.includes("port 3000 taken") === true, drained?.content);
        const consA2 = await Consumers.load(storeA);
        check("drain: watermark unchanged (already consumed past the drained signal)", consA2.getCursor(ORCHESTRATOR_ID) === e5.sequence, `wm=${consA2.getCursor(ORCHESTRATOR_ID)}`);
        check("drain: attention emptied", runtimeA.attention.length === 0);

        // ── store B: restart / crash-between-append-and-render ─────────────
        const dirB = join(base, "b");
        await mkdir(dirB, { recursive: true });
        const storeB = await TaskStore.init(dirB, "restart");
        const runtimeB1 = await buildRuntime(storeB);
        runtimeB1.registry.addAgent({
          id: "review-1", role: "reviewer", model: "test", status: "running",
          sessionFile: "/tmp/fake-review.jsonl", scope: ["src/b/"], parent: "orchestrator",
          spawnedAt: new Date().toISOString(),
        });
        await runtimeB1.registry.persist(storeB);

        const sinkB1 = makeSink(false);
        const feedB1 = new SignalFeed(sinkB1.sink);
        feedB1.attach(runtimeB1);
        await feedB1.settled();

        const s1 = await runtimeB1.log.append({ from: "review-1", to: "orchestrator", type: "progress", payload: { summary: "started" } });
        const s2 = await runtimeB1.log.append({ from: "review-1", to: "orchestrator", type: "needs_input", payload: { summary: "diff unclear" }, requires: "orchestrator" });
        await feedB1.settled();
        check("B session1: action signals render cards (progress is live status)", sinkB1.cards.length === 1 && sinkB1.cards.includes(s2.eventId), sinkB1.cards.join(","));
        check("B session1: watermark at progress (needs_input queued)", (await Consumers.load(storeB)).getCursor(ORCHESTRATOR_ID) === s1.sequence);

        // crash: feed detached; two more events land but are never processed.
        feedB1.detach();
        const s3 = await runtimeB1.log.append({ from: "review-1", to: "orchestrator", type: "finished", payload: { summary: "reviewed" } });
        const s4 = await runtimeB1.log.append({ from: "review-1", to: "orchestrator", type: "error", payload: { summary: "check failed" } });

        // restart: fresh runtime + feed.
        const runtimeB2 = await buildRuntime(storeB);
        const sinkB2 = makeSink(false);
        const feedB2 = new SignalFeed(sinkB2.sink);
        feedB2.attach(runtimeB2); // startup: reconcile + replay unconsumed (wake=false)
        await feedB2.settled();

        check("B restart: stale running → interrupted", runtimeB2.registry.getAgent("review-1")?.status === "interrupted");
        check(
          "B restart: unconsumed events re-surface as cards exactly once",
          sinkB2.cards.length === 2 &&
            sinkB2.cards.includes(s3.eventId) &&
            sinkB2.cards.includes(s4.eventId),
          sinkB2.cards.join(","),
        );
        check(
          "B restart: consumed events don't re-render",
          !sinkB2.cards.includes(s1.eventId) && !sinkB2.cards.includes(s2.eventId),
          sinkB2.cards.join(","),
        );
        check(
          "B restart: unconsumed action signals re-queued exactly once",
          runtimeB2.attention.map((a) => a.eventId).sort().join(",") === [s2.eventId, s3.eventId, s4.eventId].sort().join(","),
          runtimeB2.attention.map((a) => a.eventId).join(","),
        );
        const consB = await Consumers.load(storeB);
        check(
          "B restart: render cursor advanced, watermark resumes from progress",
          consB.getCursor(UI_CONSUMER_ID) === s4.sequence && consB.getCursor(ORCHESTRATOR_ID) === s1.sequence,
          `wm=${consB.getCursor(ORCHESTRATOR_ID)} ui=${consB.getCursor(UI_CONSUMER_ID)}`,
        );

        const drainedB = await drainPendingInjection(runtimeB2);
        check("B drain: content mentions interrupted specialist", drainedB?.content.includes("review-1") === true, drainedB?.content);
        check("B drain: watermark resumes to last persisted", (await Consumers.load(storeB)).getCursor(ORCHESTRATOR_ID) === s4.sequence);

        const runtimeB3 = await buildRuntime(storeB);
        const sinkB3 = makeSink(false);
        const feedB3 = new SignalFeed(sinkB3.sink);
        feedB3.attach(runtimeB3);
        await feedB3.settled();
        check(
          "B third restart: nothing re-rendered or re-queued",
          sinkB3.cards.length === 0 && runtimeB3.attention.length === 0,
          `cards=${sinkB3.cards.length} attention=${runtimeB3.attention.length}`,
        );

        // ── store C: maestro_history / maestro_status / footer (via tools) ──
        const dirC = join(base, "c");
        await mkdir(dirC, { recursive: true });
        const storeC = await TaskStore.init(dirC, "history");
        const runtimeC = await buildRuntime(storeC);
        runtimeC.registry.addAgent({
          id: "impl-1", role: "impl", model: "test", status: "running",
          sessionFile: "/tmp/fake.jsonl", scope: [], parent: "orchestrator",
          spawnedAt: new Date().toISOString(),
        });
        await runtimeC.registry.persist(storeC);

        await runtimeC.log.append({ from: "orchestrator", to: "impl-1", type: "spawn", payload: { summary: "Spawned impl-1" } });
        await runtimeC.log.append({ from: "impl-1", to: "orchestrator", type: "progress", payload: { summary: "p1" }, ticket: "T-1" });
        await runtimeC.log.append({ from: "impl-1", to: "orchestrator", type: "needs_input", payload: { summary: "q1" }, ticket: "T-1" });
        await runtimeC.log.append({ from: "impl-1", to: "orchestrator", type: "finished", payload: { summary: "d1" }, ticket: "T-2", artifact: "notes.md" });

        setRuntime(runtimeC);
        const tools = buildOrchestratorTools();
        const toolStatus = tools[3]!;
        const toolHistory = tools[7]!; // maestro_history (index shifted +1 by the Phase-5 read_field_notes insert)
        const fakeCtx = { cwd: dirC } as never;

        const hAll = await toolHistory.execute("h-all", {}, undefined, undefined, fakeCtx);
        const hText = hAll.content[0]?.type === "text" ? hAll.content[0].text : "";
        check("history: all events in sequence order with directions",
          ["seq 1", "seq 2", "seq 3", "seq 4"].every((s) => hText.includes(s)) && hText.indexOf("seq 1") < hText.indexOf("seq 4"),
          `${(hAll.details as { count: number }).count} entries`,
        );
        check("history: complete log (events + commands)", (hAll.details as { count: number }).count === 4);
        const hAgent = await toolHistory.execute("h-agent", { agentId: "impl-1" }, undefined, undefined, fakeCtx);
        check("history: filter by agent (from OR to)", (hAgent.details as { count: number }).count === 4, `count=${(hAgent.details as { count: number }).count}`);
        const hTicket = await toolHistory.execute("h-ticket", { ticket: "T-1" }, undefined, undefined, fakeCtx);
        check("history: filter by ticket", (hTicket.details as { count: number }).count === 2);
        const hTail = await toolHistory.execute("h-tail", { tail: 2 }, undefined, undefined, fakeCtx);
        const hTailText = hTail.content[0]?.type === "text" ? hTail.content[0].text : "";
        check("history: tail returns last N, sequence order intact", (hTail.details as { count: number }).count === 2 && hTailText.startsWith("seq 3"), hTailText.split("\n")[0]);

        const st = await toolStatus.execute("s", {}, undefined, undefined, fakeCtx);
        const stDetails = st.details as { agents: unknown[]; pendingSignals: unknown[]; watermark: number };
        check("status: lists agents + pending signals past watermark", stDetails.agents.length === 1 && stDetails.pendingSignals.length === 3, JSON.stringify(stDetails));

        // footer: phase · specialists · tickets · blocked.
        await writeFile(join(storeC.ticketsDir, "T-1.md"), JSON.stringify({ id: "T-1", title: "t1", status: "done" }), "utf8");
        await writeFile(join(storeC.ticketsDir, "T-2.md"), JSON.stringify({ id: "T-2", title: "t2", status: "waiting_input" }), "utf8");
        const stateC = await readFile(storeC.statePath, "utf8");
        await writeFile(storeC.statePath, stateC.replace("kickoff", "build"), "utf8");
        const footer = await buildFooterText(runtimeC);
        check("footer: current phase", footer.includes("phase: build"), footer);
        check("footer: specialist status", footer.includes("specialists: 1 running"), footer);
        check("footer: ticket progress + blocked work", footer.includes("tickets: 1/2 done") && footer.includes("blocked: 1"), footer);

        // wake message + card data formatting.
        const w = wakeMessage({ ...e2, sequence: 99 });
        check("wake message carries signal content + requires", w.includes("port 3000 taken") && w.includes("requires: orchestrator"));
        const card = toCardData(e2);
        check("card data: durable fields", card.eventId === e2.eventId && card.ticket === "T-1" && card.requires === "orchestrator");

        clearRuntime();
        const failed = results.filter((r) => !r.ok);
        await writeResults(cwd, "test-results.json", results);
        console.error(`PHASE 2 UNIT: ${results.length - failed.length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`PHASE 2 UNIT CRASHED: ${message}`);
        await writeResults(cwd, "test-results.json", results, message);
      }
    },
  });

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
        const toolHistory = liveTools[7]!; // maestro_history (index shifted +1 by the Phase-5 read_field_notes insert)
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
        // Progress is live status (footer), not a card (§4) — expect spawn +
        // needs_input + finished as cards only.
        check(
          "live: maestro-card entries in the session (spawn + needs_input + finished)",
          cards.length >= 3,
          JSON.stringify(cards.map((c) => `${c.data?.sequence ?? "?"}:${c.data?.type ?? "?"}`)),
        );
        check("live: cards include needs_input + finished (progress is footer-only)", ["needs_input", "finished"].every((t) => cards.some((c) => c.data?.type === t)));

        // maestro_history via the real runtime.
        const hLive = await toolHistory.execute("h-live", {}, undefined, undefined, fakeCtx);
        check("live: history shows the full exchange in order", (hLive.details as { count: number }).count >= 4);
        const hAgent = await toolHistory.execute("h-live-agent", { agentId }, undefined, undefined, fakeCtx);
        check("live: history filtered by agent", (hAgent.details as { count: number }).count >= 3);

        // status via the real runtime.
        const st = await toolStatus.execute("s-live", {}, undefined, undefined, fakeCtx);
        const stDetails = st.details as { agents: Array<{ id: string; status: string }> };
        // The child finished and the orchestrator consumed the signal → §3
        // registry semantics mark it idle (alive, no active run), not running.
        check("live: status lists the specialist (finished → idle per §3)", stDetails.agents.some((a) => a.id === agentId && a.status === "idle"));

        // footer via the real runtime.
        const footer = await buildFooterText(runtime);
        check("live: footer phase from state.md", footer.includes("phase: implementation"), footer);
        check("live: footer specialist status + ticket", footer.includes("specialists: 1 idle") && footer.includes("tickets:"), footer);

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
        // The live child finished and its signal was consumed → §3 marks it
        // idle; reconcile only interrupts running/blocked agents, so it stays
        // idle across the restart (nothing was running at process exit).
        check("restart: finished specialist stays idle (reconcile leaves idle alone)", agents.some((a) => a.id === "investigate-1" && a.status === "idle"), agents.map((a) => `${a.id}:${a.status}`).join(","));

        const uiCursor = (await Consumers.load(store)).getCursor(UI_CONSUMER_ID);
        const lastSeq = await runtime.log.lastPersistedSequence();
        check("restart: render cursor preserved (consumed events don't re-render)", uiCursor === lastSeq, `ui=${uiCursor} last=${lastSeq}`);
        const cards = ctx.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === "maestro-card");
        check("restart: no duplicate cards in the fresh session", cards.length === 0, `cards=${cards.length}`);

        // /maestro status via the real registry — BEFORE the drain: the
        // specialist is idle (finished per §3) and the re-queued action
        // signals are pending past the watermark.
        const restartTools = buildOrchestratorTools();
        const toolStatus = restartTools[3]!;
        const fakeCtx = { cwd } as never;
        const st = await toolStatus.execute("s-r", {}, undefined, undefined, fakeCtx);
        const stText = st.content[0]?.type === "text" ? st.content[0].text : "";
        check("restart: maestro_status shows the specialist idle + re-queued signals pending", stText.includes("idle") && stText.includes("investigate-1") && stText.includes("(2 past watermark)"), stText);

        const drained = await drainPendingInjection(runtime);
        // Injection groups pending signals per specialist: the first is
        // spelled out, the rest summarized as "(+N more)" — the orchestrator
        // reads maestro_status for the full list. Both signals ARE queued
        // (asserted above).
        check("restart: injection surfaces the pending signals (first spelled out + rest counted)", drained?.content.includes("live question") === true && drained?.content.includes("(+1 more)") === true, drained?.content);
        const wmAfter = (await Consumers.load(store)).getCursor(ORCHESTRATOR_ID);
        check("restart: watermark resumes to last persisted after drain", wmAfter === lastSeq, `wm=${wmAfter} last=${lastSeq}`);

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

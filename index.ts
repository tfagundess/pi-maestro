/**
 * pi Maestro — Orchestrator Extension
 *
 * Hub-and-spoke agent orchestration for pi (design: pi-maestro-extension.md).
 * One extension factory, two roles (§14 role detection):
 *
 * - Orchestrator session (no MAESTRO_AGENT_ID): the full maestro toolset +
 *   commands + the signal feed (cards / footer / wake / reconcile) +
 *   startup/discovery + skill contribution.
 * - Child session (MAESTRO_AGENT_ID set, RPC transport — §13 extension):
 *   registers ONLY maestro_signal. Embedded children (the current transport)
 *   are built directly by the orchestrator via `customTools`, so this branch
 *   is the RPC path.
 *
 * No background resources at factory time (§14); the feed + footer live in
 * `session_start`, cleanup in `session_shutdown`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TaskStore } from "./src/task-store.ts";
import { buildRuntime, clearRuntime, getRuntime, setRuntime, teardownRuntime } from "./src/runtime.ts";
import { MAESTRO_CHILD_SKILL_DIR, MAESTRO_SKILL_DIR } from "./src/child-session.ts";
import {
  makeMaestroSignalTool,
  registerMaestroCommands,
  registerMaestroTools,
  resolveRegistryModel,
} from "./src/tools.ts";
import { autoResumeInterrupted } from "./src/control.ts";
import { SignalFeed, type FeedSink } from "./src/feed.ts";
import {
  buildOrchestratorContext,
  refreshFooter,
  registerMaestroCards,
  toCardData,
  wakeMessage,
} from "./src/ui.ts";

export default function (pi: ExtensionAPI): void {
  const childAgentId = process.env.MAESTRO_AGENT_ID;

  // ── child role (RPC transport) — a single tool ─────────────────────────
  if (childAgentId) {
    pi.registerTool(makeMaestroSignalTool(childAgentId));
    return;
  }

  // ── orchestrator role ───────────────────────────────────────────────────

  let feed: SignalFeed | null = null;
  let activeCtx: ExtensionContext | null = null;
  // Persona arming (§14): pi skills are progressive disclosure — the model may
  // not load the maestro skill on its own, so the core rules + effective
  // policies are injected into orchestrator context via before_agent_start,
  // once per process (reset on session_start).
  let personaArmed = false;

  // The feed is the single consumer of events.jsonl (§5): the in-process
  // append notification is only a trigger; delivery is the log read past the
  // cursors. Cards persist in the session; the orchestrator is woken per the
  // routing matrix (needs_input / finished / error; never progress).
  const sink: FeedSink = {
    canWake: () => {
      const mode = activeCtx?.mode;
      return mode === "tui" || mode === "rpc";
    },
    onCard: (event) => {
      pi.appendEntry("maestro-card", toCardData(event));
    },
    onWake: (event) => {
      const ctx = activeCtx;
      const options =
        ctx && !ctx.isIdle()
          ? { triggerTurn: true, deliverAs: "followUp" as const } // finish the current turn first
          : { triggerTurn: true };
      pi.sendMessage(
        { customType: "maestro-wake", content: wakeMessage(event), display: true },
        options,
      );
    },
    onStatusChanged: () => {
      if (activeCtx) void refreshFooter(activeCtx, getRuntime());
    },
  };

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    personaArmed = false;

    // Discover an existing task store so a restarted orchestrator resumes from
    // its watermark; reconcile (mark interrupted + re-surface unconsumed
    // signals) runs in the feed's startup pass (§11).
    const store = await TaskStore.discover(ctx.cwd);
    let runtime = null;
    if (store) {
      runtime = await buildRuntime(store);
      setRuntime(runtime);
    }

    feed = new SignalFeed(sink);
    feed.attach(runtime);

    if (runtime) {
      // Startup pass completes (reconcile + surface unconsumed signals) before
      // the policy runs, so `interrupted` reflects this process's reality.
      await feed.settled();
      // Policy §8 `autoResume`: re-attach interrupted specialists automatically
      // (no-op when the policy is false — they stay interrupted and the
      // orchestrator decides on its next turn via the pending injection).
      const resumed = await autoResumeInterrupted(runtime, {
        cwd: ctx.cwd,
        thinkingLevel: ctx.thinkingLevel,
        resolveModel: (a) => resolveRegistryModel(ctx, a.model),
        signalToolFor: (agentId) => makeMaestroSignalTool(agentId),
      });
      if (resumed.length > 0) {
        ctx.ui.notify(`[maestro] auto-resumed ${resumed.length} specialist(s): ${resumed.join(", ")}`, "info");
      }
    }
    await refreshFooter(ctx, runtime);
  });

  pi.on("session_shutdown", async () => {
    feed?.detach();
    feed = null;
    activeCtx = null;
    await teardownRuntime();
    clearRuntime();
  });

  // Contribute both skills (maestro = orchestrator persona, maestro-child =
  // specialist protocol) to resource discovery (§14).
  pi.on("resources_discover", async () => ({
    skillPaths: [MAESTRO_SKILL_DIR, MAESTRO_CHILD_SKILL_DIR],
  }));

  // Context injection (§14 before_agent_start): the orchestrator persona +
  // effective policies (once per process — the model may not load the skill on
  // its own) plus unconsumed action signals + interrupted specialists
  // (startup / non-interactive fallback of the wake policy).
  pi.on("before_agent_start", async (_event, _ctx) => {
    const runtime = getRuntime();
    if (!runtime) return;
    const injected = await buildOrchestratorContext(runtime, personaArmed);
    if (!injected) return;
    personaArmed = injected.personaArmed;
    return {
      message: { customType: "maestro-pending", content: injected.content, display: true },
    };
  });

  registerMaestroCards(pi);
  registerMaestroTools(pi);
  registerMaestroCommands(pi);
}

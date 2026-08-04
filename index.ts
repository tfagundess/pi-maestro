/**
 * pi Maestro — Orchestrator Extension
 *
 * Hub-and-spoke agent orchestration for pi (design: pi-maestro-extension.md).
 * One extension factory, two roles (§14 role detection):
 *
 * - Orchestrator session (no MAESTRO_AGENT_ID): a dormant `/maestro` command
 *   at startup. The tools, persona, runtime, and signal feed activate only
 *   after the user explicitly runs `/maestro init`.
 * - Child session (MAESTRO_AGENT_ID set, RPC transport — §13 extension):
 *   registers ONLY maestro_signal. Embedded children (the current transport)
 *   are built directly by the orchestrator via `customTools`, so this branch
 *   is the RPC path.
 *
 * No background resources at factory time (§14); the command is registered at
 * load time so it can provide the explicit activation boundary. Runtime/feed
 * resources are created by `/maestro init` and cleaned up in `session_shutdown`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TaskStore } from "./src/task-store.ts";
import { buildRuntime, clearRuntime, getRuntime, notifyRuntimeReady, setRuntime, teardownRuntime } from "./src/runtime.ts";
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
  let activated = false;
  let cardsRegistered = false;
  let toolsRegistered = false;
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
    // Existing task stores are data, not activation state. A new Pi session
    // stays dormant until the user explicitly runs `/maestro init`.
    activated = false;
    personaArmed = false;
    activeCtx = null;
    feed = null;
    clearRuntime();
    await refreshFooter(ctx, null);
  });

  pi.on("session_shutdown", async () => {
    feed?.detach();
    feed = null;
    activeCtx = null;
    activated = false;
    await teardownRuntime();
    clearRuntime();
  });

  // The child protocol is loaded directly by child-session.ts. Do not expose
  // the orchestrator skill during startup: `/maestro init` is the sole user
  // activation boundary, and the active orchestrator persona is injected
  // directly by before_agent_start after that command.

  // Context injection (§14 before_agent_start): the orchestrator persona +
  // effective policies (once per process — the model may not load the skill on
  // its own) plus unconsumed action signals + interrupted specialists
  // (activation / non-interactive fallback of the wake policy).
  pi.on("before_agent_start", async (_event, _ctx) => {
    if (!activated) return;
    const runtime = getRuntime();
    if (!runtime) return;
    const injected = await buildOrchestratorContext(runtime, personaArmed);
    if (!injected) return;
    personaArmed = injected.personaArmed;
    return {
      message: { customType: "maestro-pending", content: injected.content, display: true },
    };
  });

  const activate = async (ctx: ExtensionContext, taskName?: string): Promise<string> => {
    if (activated) {
      const runtime = getRuntime();
      if (!runtime) throw new Error("Maestro activation state is inconsistent; restart Pi and try again.");
      return runtime.store.taskId;
    }

    // This is the only orchestrator-side call to TaskStore.init().
    const store = await TaskStore.init(ctx.cwd, taskName);
    activeCtx = ctx;
    activated = true;
    personaArmed = false;

    if (!cardsRegistered) {
      registerMaestroCards(pi);
      cardsRegistered = true;
    }
    if (!toolsRegistered) {
      registerMaestroTools(pi);
      toolsRegistered = true;
    }

    // Attach before the explicit runtime-ready notification so it runs the
    // activation reconciliation/replay pass through the session-scoped feed.
    feed = new SignalFeed(sink);
    feed.attach(null);
    try {
      // The store was created/resumed explicitly above. Build and publish the
      // runtime only after that activation boundary has succeeded.
      const runtime = await buildRuntime(store);
      setRuntime(runtime);
      notifyRuntimeReady(runtime);
      await feed.settled();

      const resumed = await autoResumeInterrupted(runtime, {
        cwd: ctx.cwd,
        thinkingLevel: ctx.thinkingLevel,
        resolveModel: (a) => resolveRegistryModel(ctx, a.model),
        signalToolFor: (agentId) => makeMaestroSignalTool(agentId),
      });
      if (resumed.length > 0) {
        ctx.ui.notify(`[maestro] auto-resumed ${resumed.length} specialist(s): ${resumed.join(", ")}`, "info");
      }
      await refreshFooter(ctx, runtime);
      return store.taskId;
    } catch (error) {
      feed.detach();
      feed = null;
      activeCtx = null;
      activated = false;
      await teardownRuntime();
      clearRuntime();
      throw error;
    }
  };

  registerMaestroCommands(pi, {
    activate,
    isActive: () => activated,
  });
}

/**
 * Module-level runtime state for the orchestrator session. Rebuilt on
 * `session_start` (discovery) or lazily on first tool use (auto-init §6/§10).
 * All maestro tools and commands go through here.
 */
import type { TaskStore } from "./task-store.ts";
import type { EventLog } from "./events.ts";
import type { Registry } from "./registry.ts";
import type { Consumers } from "./consumers.ts";
import type { MaestroConfig, MaestroEvent } from "./types.ts";
import type { ChildSessionHandle } from "./child-session.ts";

export interface MaestroRuntime {
  store: TaskStore;
  log: EventLog;
  registry: Registry;
  consumers: Consumers;
  config: MaestroConfig;
  /** Live embedded child sessions (disposed on shutdown). */
  children: Map<string, ChildSessionHandle>;
  /** Action signals (needs_input / finished / error) the feed has rendered but
   * the orchestrator LLM has not yet been told about. Drained by the
   * `before_agent_start` injection (Phase 2). Per-process, so a restart starts
   * fresh — unconsumed signals re-enter from the log via reconcile.
   */
  attention: MaestroEvent[];
  /** Interrupted agent ids already reported to the orchestrator LLM this process. */
  reportedInterrupted: Set<string>;
  /**
   * Action signals already delivered this process (woken or queued). Guards
   * the feed's re-scan of the (watermark, render-cursor] tail so an
   * attention-queued signal is never woken twice in one session, while a fresh
   * runtime (restart) still re-queues it from the log.
   */
  consumedSignals: Set<string>;
}

let current: MaestroRuntime | null = null;

// ── runtime-ready notification ─────────────────────────────────────────────
// Lets session-scoped wiring (the feed) attach even when the runtime is built
// lazily by a tool (auto-init §6/§10) rather than at session_start discovery.
const runtimeReadyListeners = new Set<(runtime: MaestroRuntime) => void>();

export function onRuntimeReady(fn: (runtime: MaestroRuntime) => void): () => void {
  runtimeReadyListeners.add(fn);
  return () => {
    runtimeReadyListeners.delete(fn);
  };
}

export function notifyRuntimeReady(runtime: MaestroRuntime): void {
  for (const fn of [...runtimeReadyListeners]) {
    try {
      fn(runtime);
    } catch {
      /* notification is best-effort */
    }
  }
}

export function setRuntime(runtime: MaestroRuntime): void {
  current = runtime;
}

export function getRuntime(): MaestroRuntime | null {
  return current;
}

export function clearRuntime(): void {
  current = null;
}

/** Dispose live children and drop the runtime (session_shutdown). */
export async function teardownRuntime(): Promise<void> {
  if (current) {
    for (const handle of current.children.values()) {
      try {
        handle.dispose();
      } catch { /* ignore */ }
    }
    current.children.clear();
  }
  current = null;
}

export async function buildRuntime(store: TaskStore): Promise<MaestroRuntime> {
  const { EventLog } = await import("./events.ts");
  const { Registry } = await import("./registry.ts");
  const { Consumers } = await import("./consumers.ts");
  return {
    store,
    log: await EventLog.load(store),
    registry: await Registry.load(store),
    consumers: await Consumers.load(store),
    config: await store.loadConfig(),
    children: new Map(),
    attention: [],
    reportedInterrupted: new Set(),
    consumedSignals: new Set(),
  };
}

/** Lazily ensure a runtime exists for this cwd (auto-init on first use). */
export async function ensureRuntime(cwd: string): Promise<MaestroRuntime> {
  if (current) return current;
  const { TaskStore } = await import("./task-store.ts");
  const store = (await TaskStore.discover(cwd)) ?? (await TaskStore.init(cwd));
  const runtime = await buildRuntime(store);
  setRuntime(runtime);
  notifyRuntimeReady(runtime);
  return runtime;
}

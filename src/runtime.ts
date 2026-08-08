/**
 * Module-level runtime state for the orchestrator session. Built only after
 * the user explicitly runs `/maestro init`; child/RPC paths may load an
 * existing store but never create one implicitly. All Maestro tools and
 * commands go through here.
 */
import { TaskStore } from "./task-store.ts";
import { EventLog } from "./events.ts";
import { Registry } from "./registry.ts";
import { Consumers } from "./consumers.ts";
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
// Lets session-scoped wiring (the feed) attach when an explicitly activated
// runtime is loaded after startup, while keeping the extension dormant before
// `/maestro init`.
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

/**
 * Load an existing runtime when one is already active or when an explicitly
 * activated child/RPC path needs to recover the current store.
 *
 * This function deliberately never calls `TaskStore.init()`. Creating a task
 * store is an activation boundary and is owned exclusively by `/maestro init`.
 */
export async function ensureRuntime(cwd: string): Promise<MaestroRuntime> {
  if (current) return current;
  const store = await TaskStore.discover(cwd);
  if (!store) {
    throw new Error("Maestro is inactive. Run /maestro init first.");
  }
  const runtime = await buildRuntime(store);
  setRuntime(runtime);
  notifyRuntimeReady(runtime);
  return runtime;
}

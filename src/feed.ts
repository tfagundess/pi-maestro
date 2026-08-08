/**
 * The single consumer of the event log — SignalFeed consumption rules.
 *
 * Delivery path: the feed reads `events.jsonl` in sequence order past its
 * cursors and processes each entry; an in-process callback (see events.ts
 * `onEventAppended`) is only a *notification* that new events exist — never a
 * delivery path. One consumer ⇒ no duplicates by construction; cursors advance
 * only after the entry is processed.
 *
 * Two cursors in consumer.json let the UI consumer keep its own position:
 * - `orchestrator`    — the watermark. Advances when an entry is *consumed*:
 *   informational entries (progress, commands) at render; action signals
 *   (needs_input / finished / error) when the orchestrator LLM is woken, or
 *   queued for next-turn injection (startup / non-interactive mode).
 * - `orchestrator-ui` — the render position. Advances when a card is appended.
 *   Cards persist in the session file, so a restart re-renders only entries
 *   past this cursor ("consumed ones don't re-render"; "exactly once").
 *
 * Wake policy: the orchestrator wakes on actionable signals, never progress.
 *   Wake the orchestrator on `needs_input` / `finished` / `error` addressed to
 *   it; NEVER on bare `progress`. Commands (orchestrator → agent) never wake.
 *   `requires` is a hint for what the orchestrator does once woken, not a
 *   routing trigger.
 */
import {
  ORCHESTRATOR_ID,
  UI_CONSUMER_ID,
  isSignalType,
  type MaestroEvent,
  type RegistryAgent,
} from "./types.ts";
import { onEventAppended } from "./events.ts";
import { getRuntime, type MaestroRuntime } from "./runtime.ts";
import { applySignalStatus } from "./control.ts";

/** What the feed needs from the session to do its job (index.ts supplies it). */
export interface FeedSink {
  /** May the orchestrator be woken right now? False in non-interactive modes. */
  canWake(): boolean;
  /** Render a durable card for this event (e.g. pi.appendEntry). Must complete before the cursor advances. */
  onCard(event: MaestroEvent): void | Promise<void>;
  /** Wake the orchestrator LLM with this signal's content (best-effort; per policy). */
  onWake(event: MaestroEvent): void;
  /** Refresh the footer / status line after a batch. */
  onStatusChanged(): void | Promise<void>;
}

export interface ProcessResult {
  /** Whether this run rendered, woke, or queued anything. */
  changed: boolean;
}

/** An action signal the orchestrator must be told about. */
export function needsAttention(event: MaestroEvent): boolean {
  return event.to === ORCHESTRATOR_ID && isSignalType(event.type) && event.type !== "progress";
}

export class SignalFeed {
  private chain: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private attached = false;
  private runtime: MaestroRuntime | null = null;
  private unsubs: (() => void)[] = [];

  constructor(private readonly sink: FeedSink) {}

  /**
   * Subscribe to append notifications and, if a runtime already exists, run the
   * startup pass (reconcile + process unconsumed entries) immediately.
   */
  attach(runtime: MaestroRuntime | null): void {
    if (this.attached) return;
    const generation = ++this.generation;
    this.attached = true;
    this.runtime = runtime;
    this.chain = this.chain.catch(() => {});
    this.unsubs.push(onEventAppended(() => void this.handleAppend(generation)));
    if (runtime) {
      this.chain = this.chain.then(() => {
        if (this.generation !== generation || !this.attached) return;
        return this.startup(runtime);
      });
    }
  }

  detach(): void {
    this.generation += 1;
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.attached = false;
    this.runtime = null;
  }

  /** Await any in-flight processing (test determinism; shutdown hygiene). */
  async settled(): Promise<void> {
    await this.chain;
  }

  /** Notification path: an event landed. Process the log past the cursors (wake allowed), then refresh the live footer/status line. */
  private handleAppend(generation: number): void {
    const runtime = this.runtime ?? getRuntime();
    if (!runtime || generation !== this.generation || !this.attached) return;
    this.chain = this.chain.then(async () => {
      if (generation !== this.generation || !this.attached) return;
      const result = await this.processPending(runtime, { wake: true });
      // Footer is live state (registry statuses, phase, tickets) — refresh it
      // after every batch that actually moved something (spawn commands,
      // signals, stops). Without this the status line freezes at session start.
      if (result.changed) {
        await this.safe(() => this.sink.onStatusChanged());
      }
    }).catch(() => {});
  }

  /**
   * Startup pass (reconcile on startup):
   * 1. mark agents whose process isn't alive as `interrupted`;
   * 2. surface signals past the watermark as cards; action signals queue for
   *    next-turn injection (no auto-wake at startup — avoids racing pi's own
   *    startup; the orchestrator learns on its next turn).
   */
  private async startup(runtime: MaestroRuntime): Promise<void> {
    await this.reconcile(runtime);
    await this.processPending(runtime, { wake: false });
    await this.safe(() => this.sink.onStatusChanged());
  }

  /**
   * Walk agents.json; non-terminal statuses that imply a live embedded
   * session in the previous process → `interrupted` (embedded children die
   * with the orchestrator. A `running` specialist had in-flight work; a
   * `blocked` one was mid-task waiting for an answer — neither has a live
   * session anymore, so both must be re-attached. Terminal states (`done` /
   * `stopped`) stay as the orchestrator left them.
   */
  async reconcile(runtime: MaestroRuntime): Promise<RegistryAgent[]> {
    const interrupted: RegistryAgent[] = [];
    for (const agent of runtime.registry.listAgents()) {
      if (agent.status === "running" || agent.status === "blocked") {
        runtime.registry.setStatus(agent.id, "interrupted");
        interrupted.push(agent);
      }
    }
    if (interrupted.length > 0) await runtime.registry.persist(runtime.store);
    return interrupted;
  }

  /**
   * Read `events.jsonl` in sequence order past both cursors and process:
   * render a card (advance ui cursor) for entries past the render position;
   * consume (advance watermark) informational entries at render and action
   * signals at wake / attention-queue. Serialized: every call runs after the
   * previous one, and each call re-reads the log, so rapid appends can't race
   * and no sequence number is ever processed twice.
   */
  async processPending(runtime: MaestroRuntime, opts: { wake?: boolean } = {}): Promise<ProcessResult> {
    const wake = opts.wake ?? true;
    const { consumers, log, store } = runtime;
    const from = Math.min(consumers.getCursor(UI_CONSUMER_ID), consumers.getCursor(ORCHESTRATOR_ID)) + 1;
    const events = await log.read(from);
    const result: ProcessResult = { changed: false };

    for (const event of events) {
      let changed = false;

      // Render (only entries past the render position — exactly once).
      // Cursors are re-read per event so concurrent cursor movement (e.g. the
      // before_agent_start drain) can't make this loop double-handle an entry.
      if (event.sequence > consumers.getCursor(UI_CONSUMER_ID)) {
        if (event.type === "progress") {
          // Progress is live status (footer), not a card; advance the
          // render cursor so the re-scan never re-delivers it, but never
          // append it to the session. Action signals + commands render cards.
          consumers.setCursor(UI_CONSUMER_ID, event.sequence);
          changed = true;
        } else {
          const cardOk = await this.safe(() => this.sink.onCard(event));
          if (cardOk) {
            consumers.setCursor(UI_CONSUMER_ID, event.sequence);
            changed = true;
          }
        }
      }

      // Consume (only entries past the watermark).
      if (event.sequence > consumers.getCursor(ORCHESTRATOR_ID)) {
        if (needsAttention(event)) {
          if (runtime.consumedSignals.has(event.eventId)) {
            // Rendered-and-handled earlier this session (queued or woken);
            // the re-scan of the (watermark, render-cursor] tail must not
            // wake it twice. A fresh runtime (restart) has an empty set and
            // re-queues it from the log below.
            continue;
          }
          if (wake && this.sink.canWake()) {
            const delivered = await this.safe(() => this.sink.onWake(event));
            if (delivered) {
              runtime.consumedSignals.add(event.eventId);
              await this.safe(() => applySignalStatus(runtime, event));
              consumers.setCursor(ORCHESTRATOR_ID, event.sequence);
              changed = true;
            } else {
              this.queueAttention(runtime, event);
              changed = true;
            }
          } else {
            this.queueAttention(runtime, event);
            changed = true;
          }
        } else {
          // progress / commands / history: fully handled at render.
          consumers.setCursor(ORCHESTRATOR_ID, event.sequence);
          changed = true;
        }
      }

      if (changed) {
        result.changed = true;
        await this.safe(() => consumers.persist(store));
      }
    }

    return result;
  }

  private queueAttention(runtime: MaestroRuntime, event: MaestroEvent): void {
    runtime.consumedSignals.add(event.eventId);
    void applySignalStatus(runtime, event).catch(() => {});
    if (!runtime.attention.some((a) => a.eventId === event.eventId)) {
      runtime.attention.push(event);
    }
  }

  private async safe(fn: () => unknown | Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * The event log — `events.jsonl`, the append-only record of all signals and
 * commands (§5). One envelope, one log, any number of producers.
 *
 * Ordering rules:
 * - `sequence` is the ONLY ordering key (never timestamps — clocks skew).
 * - The extension stamps `sequence`, `eventId`, `timestamp` at append time.
 * - Appends are serialized through a promise chain so sequences stay
 *   strictly increasing even across concurrent producers.
 * - Nothing is ever rewritten in place; consumption is cursor-based.
 */
import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isCommandType, type MaestroEvent } from "./types.ts";
import type { TaskStore } from "./task-store.ts";

// ── in-process append notification (§5) ─────────────────────────────────────
// An in-process callback is ONLY a *notification* that new events exist —
// never a delivery path. The feed (the single consumer) reads the log past its
// cursors; this just tells it to look.
const appendedListeners = new Set<(event: MaestroEvent) => void>();

export function onEventAppended(fn: (event: MaestroEvent) => void): () => void {
  appendedListeners.add(fn);
  return () => {
    appendedListeners.delete(fn);
  };
}

function emitAppended(event: MaestroEvent): void {
  for (const fn of [...appendedListeners]) {
    try {
      fn(event);
    } catch {
      /* notification is best-effort */
    }
  }
}

export interface NewEvent {
  from: string;
  to: string;
  type: MaestroEvent["type"];
  ticket?: string | null;
  payload: MaestroEvent["payload"];
  artifact?: string | null;
  replyTo?: string | null;
  requires?: MaestroEvent["requires"];
}

export class EventLog {
  private constructor(
    private readonly store: TaskStore,
    private nextSequence: number,
    private chain: Promise<unknown> = Promise.resolve(),
  ) {}

  /** Load the log; initialize the next sequence from the tail (restart-safe). */
  static async load(store: TaskStore): Promise<EventLog> {
    let next = 1;
    if (existsSync(store.eventsPath)) {
      const raw = await readFile(store.eventsPath, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const seq = (JSON.parse(line) as MaestroEvent).sequence;
          if (typeof seq === "number" && seq >= next) next = seq + 1;
        } catch { /* skip malformed trailing line */ }
      }
    }
    return new EventLog(store, next);
  }

  get nextSequenceValue(): number {
    return this.nextSequence;
  }

  /**
   * Append an event. Serialized per log instance: every append is queued
   * behind the previous one, so sequence is strictly increasing and the file
   * tail is always in order.
   */
  append(event: NewEvent): Promise<MaestroEvent> {
    const stamped: MaestroEvent = {
      // Commands (orchestrator → specialist) get a `cmd-` prefix; signals
      // (specialist → orchestrator) a `sig-` prefix (shared type helper).
      eventId: isCommandType(event.type) ? `cmd-${this.nextSequence}` : `sig-${this.nextSequence}`,
      sequence: this.nextSequence,
      timestamp: new Date().toISOString(),
      from: event.from,
      to: event.to,
      type: event.type,
      ticket: event.ticket ?? null,
      payload: event.payload,
      artifact: event.artifact ?? null,
      replyTo: event.replyTo ?? null,
      requires: event.requires ?? null,
    };
    this.nextSequence += 1;
    const line = JSON.stringify(stamped);

    const result = this.chain.then(async () => {
      await appendFile(this.store.eventsPath, line + "\n", "utf8");
      emitAppended(stamped);
      return stamped;
    });
    // Keep the chain alive even if an append fails.
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** Read entries with sequence >= fromSequence, in sequence order. */
  async read(fromSequence = 0, tail?: number): Promise<MaestroEvent[]> {
    const raw = await readFile(this.store.eventsPath, "utf8");
    const events: MaestroEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as MaestroEvent;
        if (evt.sequence >= fromSequence) events.push(evt);
      } catch { /* skip malformed line */ }
    }
    if (tail !== undefined && tail >= 0 && events.length > tail) {
      return events.slice(events.length - tail);
    }
    return events;
  }

  /** Highest sequence currently persisted. */
  async lastPersistedSequence(): Promise<number> {
    const events = await this.read(0, 1);
    return events.length > 0 ? events[events.length - 1]!.sequence : 0;
  }
}

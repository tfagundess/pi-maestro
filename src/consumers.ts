/**
 * Consumer cursors — consumer.json stores each consumer's lastSequence.
 * The orchestrator's entry is its watermark. The "inbox" is a derived view
 * (entries past the cursor), never a directory. One consumer ⇒ no duplicates
 * by construction.
 */
import { readFile } from "node:fs/promises";
import type { ConsumerFile } from "./types.ts";
import type { TaskStore } from "./task-store.ts";
import { writeAtomic } from "./persistence.ts";

export class Consumers {
  private constructor(private data: ConsumerFile) {}

  static async load(store: TaskStore): Promise<Consumers> {
    try {
      const parsed: unknown = JSON.parse(await readFile(store.consumersPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid consumers");
      const value = parsed as Partial<ConsumerFile>;
      const consumers: ConsumerFile["consumers"] = {};
      if (value.consumers && typeof value.consumers === "object" && !Array.isArray(value.consumers)) {
        for (const [name, cursor] of Object.entries(value.consumers)) {
          if (
            /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name) &&
            cursor &&
            typeof cursor === "object" &&
            Number.isSafeInteger((cursor as { lastSequence?: unknown }).lastSequence) &&
            (cursor as { lastSequence: number }).lastSequence >= 0
          ) {
            consumers[name] = { lastSequence: (cursor as { lastSequence: number }).lastSequence };
          }
        }
      }
      return new Consumers({ consumers });
    } catch {
      return new Consumers({ consumers: {} });
    }
  }

  /** Get a consumer's cursor, creating it at 0 if absent. */
  getCursor(name: string): number {
    return this.data.consumers[name]?.lastSequence ?? 0;
  }

  setCursor(name: string, sequence: number): void {
    this.data.consumers[name] = { lastSequence: sequence };
  }

  async persist(store: TaskStore): Promise<void> {
    await writeAtomic(store.consumersPath, JSON.stringify(this.data, null, 2) + "\n");
  }
}

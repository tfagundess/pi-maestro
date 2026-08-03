/**
 * Consumer cursors — `consumer.json`: per-consumer `lastSequence` (§3, §5).
 * The orchestrator's entry is its watermark. The "inbox" is a derived view
 * (entries past the cursor), never a directory. One consumer ⇒ no duplicates
 * by construction.
 */
import { readFile, writeFile } from "node:fs/promises";
import type { ConsumerFile } from "./types.ts";
import type { TaskStore } from "./task-store.ts";

export class Consumers {
  private constructor(private data: ConsumerFile) {}

  static async load(store: TaskStore): Promise<Consumers> {
    try {
      const parsed = JSON.parse(await readFile(store.consumersPath, "utf8")) as ConsumerFile;
      return new Consumers({ consumers: parsed.consumers ?? {} });
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
    await writeFile(store.consumersPath, JSON.stringify(this.data, null, 2) + "\n", "utf8");
  }
}

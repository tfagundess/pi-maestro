/**
 * The registry — `agents.json`: lineage + status of every specialist (§3, §6).
 * Single source of truth for re-attachment (§11). Only the extension writes it.
 */
import { readFile, writeFile } from "node:fs/promises";
import type { RegistryAgent, RegistryFile } from "./types.ts";
import type { TaskStore } from "./task-store.ts";

export class Registry {
  private constructor(private data: RegistryFile) {}

  static async load(store: TaskStore): Promise<Registry> {
    try {
      const parsed = JSON.parse(await readFile(store.registryPath, "utf8")) as RegistryFile;
      return new Registry({
        taskId: parsed.taskId ?? store.taskId,
        createdAt: parsed.createdAt ?? new Date().toISOString(),
        agents: parsed.agents ?? {},
      });
    } catch {
      return new Registry({
        taskId: store.taskId,
        createdAt: new Date().toISOString(),
        agents: {},
      });
    }
  }

  static async save(store: TaskStore, data: RegistryFile): Promise<void> {
    await writeFile(store.registryPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  listAgents(): RegistryAgent[] {
    return Object.values(this.data.agents);
  }

  getAgent(id: string): RegistryAgent | undefined {
    return this.data.agents[id];
  }

  /**
   * Unique agent id: with a name it is exactly that name (e.g. `charles`,
   * whose role can be `qa`), suffixed only on collision (`charles-2`);
   * without a name it is `<role>-1`, `<role>-2`, ... (§6). The registry key
   * is never just the role name.
   */
  nextAgentId(role: string, name?: string): string {
    const base =
      (name ?? role)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "agent";
    if (name !== undefined) {
      let id = base;
      let n = 2;
      while (this.data.agents[id]) id = `${base}-${n++}`;
      return id;
    }
    let n = 1;
    while (this.data.agents[`${base}-${n}`]) n += 1;
    return `${base}-${n}`;
  }

  /** Scope overlap check (§8 rule 4): no two agents own the same files/modules. */
  findScopeOverlap(scope: string[]): string[] {
    const existing = this.listAgents().flatMap((a) => a.scope);
    return scope.filter((s) => existing.includes(s));
  }

  addAgent(agent: RegistryAgent): void {
    this.data.agents[agent.id] = agent;
  }

  setStatus(id: string, status: RegistryAgent["status"]): void {
    const agent = this.data.agents[id];
    if (agent) agent.status = status;
  }

  setLastSignalSequence(id: string, sequence: number): void {
    const agent = this.data.agents[id];
    if (agent && sequence > (agent.lastSignalSequence ?? 0)) agent.lastSignalSequence = sequence;
  }

  async persist(store: TaskStore): Promise<void> {
    await Registry.save(store, this.data);
  }
}

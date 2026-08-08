/**
 * The registry — agents.json: lineage and status of every specialist.
 * It is the source of truth for re-attachment; only the extension writes it.
 */
import { readFile } from "node:fs/promises";
import type { RegistryAgent, RegistryFile } from "./types.ts";
import type { TaskStore } from "./task-store.ts";
import { writeAtomic } from "./persistence.ts";
import { validIdentifier } from "./paths.ts";

const STATUSES = new Set<RegistryAgent["status"]>(["running", "idle", "blocked", "done", "stopped", "interrupted"]);

function isRegistryAgent(value: unknown, id: string): value is RegistryAgent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const agent = value as Partial<RegistryAgent>;
  return (
    agent.id === id &&
    typeof agent.role === "string" &&
    typeof agent.model === "string" &&
    typeof agent.status === "string" &&
    STATUSES.has(agent.status as RegistryAgent["status"]) &&
    typeof agent.sessionFile === "string" &&
    Array.isArray(agent.scope) &&
    agent.scope.every((scope) => typeof scope === "string") &&
    typeof agent.parent === "string" &&
    typeof agent.spawnedAt === "string"
  );
}

export class Registry {
  private constructor(private data: RegistryFile) {}

  static async load(store: TaskStore): Promise<Registry> {
    try {
      const parsed: unknown = JSON.parse(await readFile(store.registryPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid registry");
      const value = parsed as Partial<RegistryFile>;
      const agents: Record<string, RegistryAgent> = {};
      if (value.agents && typeof value.agents === "object" && !Array.isArray(value.agents)) {
        for (const [id, candidate] of Object.entries(value.agents)) {
          if (validIdentifier(id) && isRegistryAgent(candidate, id)) agents[id] = candidate;
        }
      }
      return new Registry({
        taskId: store.taskId,
        createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
        agents,
      });
    } catch {
      return new Registry({
        taskId: store.taskId,
        createdAt: new Date().toISOString(),
        agents: {},
      });
    }
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
   * without a name it is `<role>-1`, `<role>-2`, ... . The registry key
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

  /** Scope overlap check: no two agents own the same files/modules. */
  findScopeOverlap(scope: string[]): string[] {
    const existing = this.listAgents().flatMap((a) => a.scope);
    return scope.filter((s) => existing.includes(s));
  }

  addAgent(agent: RegistryAgent): void {
    this.data.agents[agent.id] = agent;
  }

  deleteAgent(id: string): void {
    delete this.data.agents[id];
  }

  setStatus(id: string, status: RegistryAgent["status"]): void {
    const agent = this.data.agents[id];
    if (agent) agent.status = status;
  }

  async persist(store: TaskStore): Promise<void> {
    await writeAtomic(store.registryPath, JSON.stringify(this.data, null, 2) + "\n");
  }
}

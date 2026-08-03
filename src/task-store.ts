/**
 * The Task Store — durable state of one orchestrated task (§3).
 *
 * Layout (under `<cwd>/.pi/maestro/<task-id>/`):
 *   agents.json, consumer.json, state.md, config.json,
 *   tickets/, agents/, field-notes/, artifacts/, events.jsonl, sessions/
 */
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { DEFAULT_CONFIG, type MaestroConfig } from "./types.ts";

const MAESTRO_DIR_NAME = "maestro";
const CURRENT_POINTER = "current.txt";

export function maestroRoot(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, MAESTRO_DIR_NAME);
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "task";
}

export class TaskStore {
  /** Absolute path to `.pi/maestro/<task-id>/`. */
  readonly root: string;
  readonly taskId: string;
  readonly cwd: string;

  constructor(cwd: string, taskId: string) {
    this.cwd = cwd;
    this.taskId = taskId;
    this.root = join(maestroRoot(cwd), taskId);
  }

  // ── paths ────────────────────────────────────────────────────────────────
  get statePath() { return join(this.root, "state.md"); }
  get registryPath() { return join(this.root, "agents.json"); }
  get consumersPath() { return join(this.root, "consumer.json"); }
  get configPath() { return join(this.root, "config.json"); }
  get eventsPath() { return join(this.root, "events.jsonl"); }
  get ticketsDir() { return join(this.root, "tickets"); }
  get blueprintsDir() { return join(this.root, "agents"); }
  get fieldNotesDir() { return join(this.root, "field-notes"); }
  get artifactsDir() { return join(this.root, "artifacts"); }
  get sessionsDir() { return join(this.root, "sessions"); }

  // ── discovery / init ─────────────────────────────────────────────────────

  /** Find the current task store for this cwd: pointer file, else single dir, else none. */
  static async discover(cwd: string): Promise<TaskStore | null> {
    const root = maestroRoot(cwd);
    if (!existsSync(root)) return null;

    // Prefer the explicit pointer written at init.
    const pointer = join(root, CURRENT_POINTER);
    if (existsSync(pointer)) {
      try {
        const taskId = (await readFile(pointer, "utf8")).trim();
        if (taskId && existsSync(join(root, taskId))) return new TaskStore(cwd, taskId);
      } catch { /* fall through to scan */ }
    }

    // Fallback: a single task dir (valid = has events.jsonl).
    const dirs: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(root, entry.name, "events.jsonl"))) dirs.push(entry.name);
    }
    if (dirs.length === 1) return new TaskStore(cwd, dirs[0]!);
    if (dirs.length === 0) return null;

    // Multiple: pick the most recently modified.
    let best: TaskStore | null = null;
    let bestMtime = 0;
    for (const id of dirs) {
      const st = await stat(join(root, id, "events.jsonl")).catch(() => null);
      if (st && st.mtimeMs >= bestMtime) {
        bestMtime = st.mtimeMs;
        best = new TaskStore(cwd, id);
      }
    }
    return best;
  }

  /**
   * Create a fresh Task Store. If a store already exists for this cwd, it is
   * reused (resume), not clobbered — nothing in the Task Store is ever
   * rewritten in place.
   */
  static async init(cwd: string, taskName?: string): Promise<TaskStore> {
    const existing = await TaskStore.discover(cwd);
    if (existing) return existing;

    const root = maestroRoot(cwd);
    await mkdir(root, { recursive: true });

    let taskId = taskName ? slugify(taskName) : "task";
    let candidate = new TaskStore(cwd, taskId);
    let n = 2;
    while (existsSync(candidate.root)) {
      taskId = `${slugify(taskName ?? "task")}-${n++}`;
      candidate = new TaskStore(cwd, taskId);
    }
    const store = candidate;
    await store.createStore();
    return store;
  }

  private async createStore(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(this.ticketsDir, { recursive: true });
    await mkdir(this.blueprintsDir, { recursive: true });
    await mkdir(this.fieldNotesDir, { recursive: true });
    await mkdir(this.artifactsDir, { recursive: true });
    await mkdir(this.sessionsDir, { recursive: true });

    // state.md — five sections, orchestrator-owned dashboard.
    if (!existsSync(this.statePath)) {
      await writeFile(
        this.statePath,
        [
          "# Task State",
          "",
          "## Goal",
          "",
          "(set by the orchestrator when the human states the goal)",
          "",
          "## Current phase",
          "",
          "kickoff",
          "",
          "## Open tickets",
          "",
          "(id · title · status · owner)",
          "",
          "## Decisions",
          "",
          "(orchestrator-owned; record decisions here)",
          "",
          "## Ownership",
          "",
          "(agent id · role · scope — one line per specialist)",
          "",
        ].join("\n"),
        "utf8",
      );
    }

    // agents/ — role blueprints: built-ins seeded here; custom via maestro_define_role.
    {
      const { BUILTIN_BLUEPRINTS } = await import("./blueprints.ts");
      for (const b of BUILTIN_BLUEPRINTS) {
        const file = join(this.blueprintsDir, `${b.name}.md`);
        if (!existsSync(file)) await writeFile(file, b.content, "utf8");
      }
    }

    // config.json — policies with defaults (§8).
    if (!existsSync(this.configPath)) {
      await writeFile(this.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
    }

    // agents.json — registry (lineage + status).
    if (!existsSync(this.registryPath)) {
      const registry = {
        taskId: this.taskId,
        createdAt: new Date().toISOString(),
        agents: {},
      };
      await writeFile(this.registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
    }

    // consumer.json — per-consumer cursors; the orchestrator entry is the
    // watermark, the orchestrator-ui entry is the card render position (§3, §5).
    if (!existsSync(this.consumersPath)) {
      await writeFile(
        this.consumersPath,
        JSON.stringify(
          { consumers: { orchestrator: { lastSequence: 0 }, "orchestrator-ui": { lastSequence: 0 } } },
          null,
          2,
        ) + "\n",
        "utf8",
      );
    }

    // events.jsonl — empty, append-only.
    if (!existsSync(this.eventsPath)) {
      await writeFile(this.eventsPath, "", "utf8");
    }

    // Pointer for restart discovery.
    await writeFile(join(maestroRoot(this.cwd), CURRENT_POINTER), this.taskId + "\n", "utf8");
  }

  // ── config ───────────────────────────────────────────────────────────────
  async loadConfig(): Promise<MaestroConfig> {
    try {
      const raw = await readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<MaestroConfig>;
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  // ── state.md (orchestrator-owned dashboard) ──────────────────────────────

  /** Append a line under the `## Ownership` section of state.md (one line per specialist, §3). */
  async recordOwnership(agentId: string, role: string, scope: string[]): Promise<void> {
    const scopeText = scope.length > 0 ? ` · scope: ${scope.join(", ")}` : "";
    const line = `- ${agentId} · role: ${role}${scopeText}`;
    const current = await readFile(this.statePath, "utf8").catch(() => "");
    const section = "\n## Ownership\n";
    const idx = current.indexOf(section);
    if (idx >= 0) {
      const head = current.slice(0, idx + section.length);
      const tail = current.slice(idx + section.length);
      // Idempotent per specialist; never clobber the other entries (the old
      // implementation replaced the whole section with the last line).
      if (tail.split("\n").some((l) => l.trim().startsWith(`- ${agentId} ·`))) return;
      await writeFile(this.statePath, `${head}${line}\n${tail}`, "utf8");
    } else {
      await writeFile(this.statePath, `${current}\n${section}${line}\n`, "utf8");
    }
  }

  /** Render the shared context slice for a specialist's spawn prompt (§9). */
  async renderContextSlice(): Promise<string> {
    const parts: string[] = [];

    // The task store root anchors every relative path the specialist sees
    // (§9): state.md, tickets/, artifacts/, field-notes/ are all relative to
    // this directory — NOT to the child's cwd.
    parts.push(`Task store root: ${this.root} — paths below are relative to it (state.md, tickets/, artifacts/, field-notes/).`);

    const state = await readFile(this.statePath, "utf8").catch(() => "# Task State\n(empty)");
    parts.push(stateDigest(state.trimEnd()));

    // Tickets — compact list of schema-backed ticket files.
    const ticketFiles = await readdir(this.ticketsDir).catch(() => [] as string[]);
    if (ticketFiles.length > 0) {
      const rows: string[] = [];
      for (const f of ticketFiles.sort()) {
        if (!f.endsWith(".md")) continue;
        const raw = await readFile(join(this.ticketsDir, f), "utf8").catch(() => "");
        const firstLine = raw.split("\n").find((l) => l.startsWith("# "));
        rows.push(`- ${f.replace(/\.md$/, "")}: ${(firstLine ?? raw.slice(0, 80)).replace(/^#\s*/, "")}`);
      }
      parts.push(`## Tickets\n\n${rows.join("\n")}`);
    }

    // Artifacts — listing only; the specialist reads what it needs.
    const artifactFiles = await readdir(this.artifactsDir).catch(() => [] as string[]);
    if (artifactFiles.length > 0) {
      parts.push(`## Artifacts\n\n${artifactFiles.sort().map((f) => `- artifacts/${f}`).join("\n")}`);
    }

    return parts.join("\n\n");
  }

  /** Path of an artifact resolved safely against the artifacts dir. */
  artifactPath(path: string): string {
    const resolved = join(this.artifactsDir, path);
    const rel = relative(this.artifactsDir, resolved);
    if (rel.startsWith("..") || rel.includes(".." + "/")) {
      throw new Error(`Artifact path escapes the artifacts dir: ${path}`);
    }
    return resolved;
  }

  /**
   * Create the per-agent field-notes stub (§8): the specialist appends things
   * learned / architecture notes / pitfalls / useful commands as it works.
   * Idempotent — never overwrites what the agent recorded.
   */
  async createFieldNotes(agentId: string, role: string): Promise<void> {
    const file = join(this.fieldNotesDir, `${agentId}.md`);
    if (existsSync(file)) return;
    await writeFile(file, `# Field notes — ${agentId} (${role})\n`, "utf8");
  }
}

/**
 * Digest of state.md for the injected context slice (§9): the compact,
 * orchestrator-maintained sections (Goal, Current phase, Open tickets,
 * Ownership) pass through verbatim; long-lived sections (Decisions) are capped
 * so the slice stays lean as the dashboard grows. Falls back to the full file
 * when the section structure isn't recognizable.
 */
function stateDigest(state: string): string {
  if (!/^## /m.test(state)) return state;

  const lines = state.split("\n");
  const head: string[] = [];
  const sections: Array<{ header: string; body: string[] }> = [];
  let cur: { header: string; body: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(/^## (.+)$/);
    if (m) {
      cur = { header: m[1]!, body: [] };
      sections.push(cur);
    } else if (cur) {
      cur.body.push(line);
    } else {
      head.push(line); // lines before the first section (e.g. the # Task State title)
    }
  }

  const MAX_DECISIONS = 5;
  const out: string[] = [...head];
  for (const s of sections) {
    out.push(`## ${s.header}`);
    const body = s.body.map((l) => (l.length > 200 ? `${l.slice(0, 197)}…` : l));
    if (s.header === "Decisions") {
      const kept = body.map((l) => l.trimEnd()).filter(Boolean).slice(-MAX_DECISIONS);
      const total = body.map((l) => l.trimEnd()).filter(Boolean).length;
      if (kept.length === 0) {
        out.push("(none)");
      } else {
        for (const l of kept) out.push(l);
        if (total > kept.length) out.push(`(+${total - kept.length} older decision(s) — see state.md)`);
      }
    } else {
      out.push(...body);
    }
  }
  return out.join("\n");
}

/** Resolve an artifact path that may be absolute or relative to cwd. */
export function resolveArtifact(store: TaskStore, path: string): string {
  if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) {
    const rel = relative(store.artifactsDir, path);
    if (rel.startsWith("..")) throw new Error(`Artifact outside the task store: ${path}`);
    return path;
  }
  return store.artifactPath(path);
}

/** Read a role blueprint (built-in or user-authored) from the store. */
export async function readBlueprint(store: TaskStore, role: string): Promise<string | null> {
  if (role.includes("/") || role.includes("..")) return null;
  const custom = join(store.blueprintsDir, `${role}.md`);
  if (existsSync(custom)) return readFile(custom, "utf8");
  return null;
}
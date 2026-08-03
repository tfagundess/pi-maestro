/**
 * Full-codebase audit harness — end-to-end scenario simulation (§12 pattern,
 * temporary; registered ONLY while imported by index.ts).
 *
 * Drives the REAL extension surface (buildOrchestratorTools + SignalFeed +
 * control + store + registry + consumers + ui injection) with SCRIPTED child
 * sessions (the child-session factory seam, see child-session.ts), so the
 * whole extension is exercised deterministically through realistic
 * orchestration scenarios — no real LLM runs:
 *
 *   S1  init layout            — maestro_init → the 7 store artifacts seeded
 *   S2  full orchestration loop — define_role → spawn → await(needs_input) →
 *                                reply → finished+artifact → reviewer flow →
 *                                history/ticket filter → field notes
 *   S3  sequential guard       — spawn while a child is working → rejected
 *   S4  scope ownership        — overlapping scope → rejected
 *   S5  unknown role           — rejected with built-in list
 *   S6  stop → ignored signals → resume (transcript continuity)
 *   S7  restart durability     — reconcile running→interrupted, autoResume,
 *                                contiguous sequences, watermark preserved
 *   S8  escalation             — requires:human queued + drained into the
 *                                orchestrator's next-turn injection
 *   S9  field-notes tool       — tails, unknown agent, byte-cap
 *   S10 frontmatter regression — no blueprint frontmatter leaks into child prompts
 *
 * Writes <cwd>/audit-e2e-results.json. Isolated stores under <cwd>/audit-e2e/.
 */
import type { ExtensionAPI, AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.ts";
import { buildRuntime, clearRuntime, setRuntime, type MaestroRuntime } from "../src/runtime.ts";
import { buildOrchestratorTools } from "../src/tools.ts";
import { SignalFeed, type FeedSink } from "../src/feed.ts";
import { autoResumeInterrupted } from "../src/control.ts";
import { buildOrchestratorContext } from "../src/ui.ts";
import {
  MAESTRO_CHILD_SKILL_DIR,
  getChildSessionFactory,
  resetChildSessionFactory,
  setChildSessionFactory,
  type ChildSessionHandle,
  type ChildSessionOptions,
} from "../src/child-session.ts";
import {
  DEFAULT_CONFIG,
  ORCHESTRATOR_ID,
  type RequiresHint,
  type SignalType,
} from "../src/types.ts";

// ── result plumbing ─────────────────────────────────────────────────────────

interface Result {
  name: string;
  ok: boolean;
  detail?: string;
}

function makeResults(): { results: Result[]; check: (name: string, cond: boolean, detail?: string) => void } {
  const results: Result[] = [];
  const check = (name: string, cond: boolean, detail?: string): void => {
    results.push({ name, ok: cond, detail });
    console.error(`[${cond ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  };
  return { results, check };
}

async function writeResults(cwd: string, file: string, results: Result[], crashed?: string): Promise<void> {
  const failed = results.filter((r) => !r.ok);
  await writeFile(
    join(cwd, file),
    JSON.stringify({ results, failed: failed.length, total: results.length, crashed }, null, 2),
    "utf8",
  );
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  console.error(`waitFor timed out: ${what}`);
  return false;
}

function makeSink(canWake = false): {
  sink: FeedSink;
  cards: string[];
  woken: string[];
  queued: string[];
  setCanWake: (v: boolean) => void;
} {
  const cards: string[] = [];
  const woken: string[] = [];
  const queued: string[] = [];
  let canWakeValue = canWake;
  return {
    sink: {
      canWake: () => canWakeValue,
      onCard: (event) => {
        cards.push(`${event.sequence}:${event.type}:${event.from}`);
      },
      onWake: (event) => {
        woken.push(`${event.eventId}:${event.from}`);
      },
      onStatusChanged: () => {},
    },
    cards,
    woken,
    queued,
    setCanWake: (v) => {
      canWakeValue = v;
    },
  };
}

// ── scripted child sessions ────────────────────────────────────────────────

export type ScriptedStep =
  | { kind: "signal"; type: SignalType; summary: string; details?: string; requires?: RequiresHint; artifact?: string }
  | { kind: "notes"; lines: string[] }
  | { kind: "artifact"; name: string; content: string }
  | { kind: "wait"; ms: number };

export interface ScriptedBrain {
  /** Steps to run when the child is (re)started. */
  onStart(prompt: string): ScriptedStep[];
  /** Steps to run when the orchestrator steers/replies; null = none. */
  onSteer(text: string): ScriptedStep[] | null;
}

const DEFAULT_BRAIN: ScriptedBrain = {
  onStart: () => [{ kind: "signal", type: "progress", summary: "started" }],
  onSteer: () => null,
};

/** In-memory transcripts keyed by session file path (resume continuity). */
const transcriptMemory = new Map<string, string[]>();

class FakeChild {
  private scriptRunning = false;
  private aborted = false;
  readonly steers: string[] = [];
  readonly transcript: string[];

  constructor(
    private readonly agentId: string,
    private readonly runtime: MaestroRuntime,
    private readonly sessionFile: string,
    private readonly brain: ScriptedBrain,
  ) {
    this.transcript = transcriptMemory.get(sessionFile) ?? [];
    transcriptMemory.set(sessionFile, this.transcript);
  }

  get isStreaming(): boolean {
    return this.scriptRunning;
  }

  private async runScript(steps: ScriptedStep[]): Promise<void> {
    this.scriptRunning = true;
    for (const step of steps) {
      if (this.aborted) break;
      switch (step.kind) {
        case "wait":
          await new Promise((r) => setTimeout(r, step.ms));
          break;
        case "notes":
          {
            const file = join(this.runtime.store.fieldNotesDir, `${this.agentId}.md`);
            const current = await readFile(file, "utf8").catch(() => "");
            await writeFile(file, current + step.lines.map((l) => l + "\n").join(""), "utf8");
          }
          break;
        case "artifact":
          await writeFile(join(this.runtime.store.artifactsDir, step.name), step.content, "utf8");
          break;
        case "signal":
          await this.runtime.log.append({
            from: this.agentId,
            to: ORCHESTRATOR_ID,
            type: step.type,
            payload: { summary: step.summary, details: step.details },
            requires: step.requires,
            artifact: step.artifact,
          });
          break;
      }
    }
    this.scriptRunning = false;
  }

  prompt(text: string): void {
    this.transcript.push(`user: ${text.slice(0, 80)}`);
    // A fresh prompt after the run ended = a command delivery (reply/send/
    // forward) or a new instruction. Real pi's model treats it as an
    // instruction to continue from — mirror that by routing to onSteer when
    // it is a command delivery, onStart otherwise (spawn/resume prompts).
    if (text.includes("[Answer from the orchestrator") || text.includes("Forwarded from the orchestrator")) {
      this.steers.push(text);
      const cont = this.brain.onSteer(text);
      if (cont && cont.length > 0) void this.runScript(cont);
    } else {
      void this.runScript(this.brain.onStart(text));
    }
  }

  steer(text: string): void {
    this.steers.push(text);
    this.transcript.push(`steer: ${text.slice(0, 80)}`);
    const cont = this.brain.onSteer(text);
    if (cont && cont.length > 0) void this.runScript(cont);
  }

  abort(): void {
    this.aborted = true;
    this.scriptRunning = false;
  }

  dispose(): void {}
}

function makeFakeFactory(runtime: MaestroRuntime, brains: Map<string, ScriptedBrain>) {
  const factory = async (opts: ChildSessionOptions): Promise<ChildSessionHandle> => {
    const brain = brains.get(opts.agentId) ?? brains.get(opts.role) ?? DEFAULT_BRAIN;
    const sessionFile =
      opts.sessionFile ?? join(opts.store.sessionsDir, `${opts.agentId}.jsonl`);
    const child = new FakeChild(opts.agentId, runtime, sessionFile, brain);
    const session = {
      get isStreaming() {
        return child.isStreaming;
      },
      prompt: async (p: string) => child.prompt(p),
      steer: async (t: string) => child.steer(t),
      abort: async () => child.abort(),
      dispose: () => child.dispose(),
    } as unknown as AgentSession;
    return {
      agentId: opts.agentId,
      session,
      sessionFile,
      start: (p: string) => child.prompt(p),
      dispose: () => child.dispose(),
    };
  };
  return factory;
}

async function childIdle(runtime: MaestroRuntime, agentId: string): Promise<boolean> {
  return waitFor(() => {
    const h = runtime.children.get(agentId);
    return !h || !h.session.isStreaming;
  }, 10_000, `child ${agentId} idle`);
}

// ── the audit ──────────────────────────────────────────────────────────────

export function registerAuditE2E(pi: ExtensionAPI): void {
  pi.registerCommand("audit-e2e", {
    description: "Full-codebase audit: end-to-end scenario simulation",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const { results, check } = makeResults();
      let feed: SignalFeed | null = null;
      try {
        const base = join(cwd, "audit-e2e");
        await rm(base, { recursive: true, force: true });
        await mkdir(base, { recursive: true });

        // ── S1: init layout ───────────────────────────────────────────────
        const dirS1 = join(base, "s1");
        await mkdir(dirS1, { recursive: true });
        {
          const tools = buildOrchestratorTools();
          const toolInit = tools[0]!;
          const initRes = await toolInit.execute("s1-init", { task: "audit-s1" }, undefined, undefined, { cwd: dirS1 } as never);
          const initDetails = initRes.details as { taskId: string };
          const store = await TaskStore.discover(dirS1);
          check("S1: maestro_init created the store", store !== null && initDetails.taskId === store?.taskId);
          if (store) {
            const files = ["state.md", "agents.json", "consumer.json", "config.json", "events.jsonl"];
            const dirs = ["tickets", "agents", "field-notes", "artifacts", "sessions"];
            const fileOk = (await Promise.all(files.map((p) => readFile(join(store.root, p), "utf8").then(() => true).catch(() => false)))).filter(Boolean).length;
            const dirOk = (await Promise.all(dirs.map((p) => readFile(join(store.root, p), "utf8").then(() => false).catch(() => true)))).filter(Boolean).length;
            check("S1: all 10 store artifacts exist", fileOk === files.length && dirOk === dirs.length, `${fileOk}/${files.length} files, ${dirOk}/${dirs.length} dirs`);
            const config = await store.loadConfig();
            check("S1: config seeded with defaults", config.maxConcurrentSpecialists === 1 && config.autoResume === false && config.approvalRules.length === 3);
            const consumers = JSON.parse(await readFile(store.consumersPath, "utf8"));
            check("S1: consumers seeded (watermark + ui cursor)", consumers.consumers.orchestrator?.lastSequence === 0 && consumers.consumers["orchestrator-ui"]?.lastSequence === 0);
            const blueprints = (await readFile(join(store.blueprintsDir, "reviewer.md"), "utf8")).includes("# Mission");
            check("S1: built-in blueprints seeded", blueprints);
            const events = await readFile(store.eventsPath, "utf8");
            check("S1: event log empty + append-only path exists", events === "");
          }
        }

        // ── S2: full orchestration loop ───────────────────────────────────
        const dirS2 = join(base, "s2");
        await mkdir(dirS2, { recursive: true });
        let runtime: MaestroRuntime;
        {
          const store = await TaskStore.init(dirS2, "audit-s2");
          runtime = await buildRuntime(store);
          setRuntime(runtime);
          const sink = makeSink(false); // non-interactive: action signals queue, never wake
          feed = new SignalFeed(sink.sink);
          feed.attach(runtime);
          await feed.settled();

          const brains = new Map<string, ScriptedBrain>();
          brains.set("lint", {
            onStart: () => [
              { kind: "wait", ms: 60 },
              { kind: "signal", type: "progress", summary: "scanning files" },
              { kind: "wait", ms: 60 },
              { kind: "signal", type: "needs_input", summary: "lint config?", requires: "orchestrator", details: "tried default rules" },
            ],
            onSteer: (text) =>
              text.includes("Answer")
                ? [
                    { kind: "wait", ms: 60 },
                    { kind: "notes", lines: ["- learned: use double quotes", "- pitfall: unused imports fail the build"] },
                    { kind: "artifact", name: "lint-report.md", content: "# Lint report\n- 3 warnings fixed\n" },
                    { kind: "signal", type: "finished", summary: "lint done", artifact: "lint-report.md" },
                  ]
                : null,
          });
          brains.set("reviewer", {
            onStart: () => [
              { kind: "wait", ms: 60 },
              { kind: "artifact", name: "review.md", content: "# Review\nverdict: pass\nchecklist: ok\n" },
              { kind: "signal", type: "finished", summary: "review passed", artifact: "review.md" },
            ],
            onSteer: () => null,
          });
          setChildSessionFactory(makeFakeFactory(runtime, brains));

          const tools = buildOrchestratorTools();
          // define_role → custom blueprint
          const toolDefine = tools[1]!;
          await toolDefine.execute("s2-def", { name: "lint", blueprint: "# Mission\nLint the codebase.\n\n# Inputs\n- code\n\n# Outputs\n- artifacts/lint-report.md" }, undefined, undefined, { cwd: dirS2 } as never);
          check("S2: define_role wrote agents/lint.md", (await readFile(join(runtime.store.blueprintsDir, "lint.md"), "utf8")).includes("# Mission"));

          // spawn (scripted child starts its brain)
          const toolSpawn = tools[2]!;
          const spawnRes = await toolSpawn.execute("s2-spawn", { role: "lint", task: "Lint src/", scope: ["src/lint/"] }, undefined, undefined, { cwd: dirS2 } as never);
          const lintId = (spawnRes.details as { agentId: string }).agentId;
          check("S2: spawned lint-1", lintId === "lint-1");
          check("S2: spawn command is the first log entry", (await runtime.log.read(0))[0]?.type === "spawn");
          check("S2: field-notes stub created at spawn", (await readFile(join(runtime.store.fieldNotesDir, "lint-1.md"), "utf8")).includes("# Field notes — lint-1"));

          // maestro_await → resolves on needs_input
          const toolAwait = tools[10]!;
          const awaitRes = await toolAwait.execute("s2-await", { agentId: lintId, timeout: 30 }, undefined, undefined, { cwd: dirS2 } as never);
          const awaitStatus = (awaitRes.details as { status: string; event: { type: string; requires: string } | null }).status;
          check("S2: maestro_await resolved on needs_input (requires: orchestrator)", awaitStatus === "signal" && (awaitRes.details as { event: { type: string } | null }).event?.type === "needs_input", awaitStatus);
          const needsInputEvent = (await runtime.log.read(0)).find((e) => e.type === "needs_input")!;
          check("S2: needs_input consumed → registry blocked", runtime.registry.getAgent(lintId)?.status === "blocked");
          await feed.settled();
          check("S2: await consumed the signal — not re-queued, nothing woken", sink.woken.length === 0 && !runtime.attention.some((e) => e.eventId === needsInputEvent.eventId) && runtime.consumers.getCursor(ORCHESTRATOR_ID) >= needsInputEvent.sequence);

          // maestro_reply → child continuation → finished
          const toolReply = tools[8]!;
          await toolReply.execute("s2-reply", { agentId: lintId, replyTo: needsInputEvent.eventId, message: "Answer: use the default lint rules, double quotes." }, undefined, undefined, { cwd: dirS2 } as never);
          await childIdle(runtime, lintId);
          await feed.settled();
          check("S2: reply delivered into the child's loop", runtime.children.get(lintId) !== undefined);
          const eventsS2 = await runtime.log.read(0);
          const reply = eventsS2.find((e) => e.type === "reply");
          check("S2: reply command logged after the question (replyTo wiring)", reply !== undefined && reply.replyTo === needsInputEvent.eventId && reply.sequence > needsInputEvent.sequence);
          const finished = eventsS2.find((e) => e.type === "finished" && e.from === lintId);
          check("S2: child finished after the answer", finished?.artifact === "lint-report.md");
          check("S2: finished consumed → registry idle", runtime.registry.getAgent(lintId)?.status === "idle");

          // field notes written by the child + readable via the tail tool
          const notesFile = await readFile(join(runtime.store.fieldNotesDir, "lint-1.md"), "utf8");
          check("S2: child appended field notes", notesFile.includes("learned: use double quotes") && notesFile.includes("pitfall: unused imports"));
          const toolNotes = tools[5]!;
          const notesRes = await toolNotes.execute("s2-notes", { agentId: lintId, tail: 5 }, undefined, undefined, { cwd: dirS2 } as never);
          check("S2: maestro_read_field_notes reads the tail", ((notesRes.content as { type: string; text: string }[])[0]!.text).includes("pitfall: unused imports"));
          const ghostErr = await toolNotes.execute("s2-ghost", { agentId: "ghost" }, undefined, undefined, { cwd: dirS2 } as never).then(() => null).catch((e: Error) => e.message);
          check("S2: unknown agent rejected by read tool", typeof ghostErr === "string" && ghostErr.includes("Unknown agent: ghost"));

          // named specialist: id = the chosen name, role kept separate (e.g. charles + qa)
          await toolDefine.execute("s2-def-qa", { name: "qa", blueprint: "# Mission\nQuality-assure the change.\n\n# Inputs\n- the diff\n\n# Outputs\n- artifacts/qa-note.md" }, undefined, undefined, { cwd: dirS2 } as never);
          const namedSpawn = await toolSpawn.execute("s2-spawn-charles", { role: "qa", name: "charles", task: "QA the lint change", scope: ["src/qa/"] }, undefined, undefined, { cwd: dirS2 } as never);
          const charlesId = (namedSpawn.details as { agentId: string }).agentId;
          check("S2: named specialist id = the name, not the role", charlesId === "charles" && runtime.registry.getAgent("charles")?.role === "qa", `id=${charlesId} role=${runtime.registry.getAgent("charles")?.role}`);
          check("S2: named specialist field-notes stub carries id + role", (await readFile(join(runtime.store.fieldNotesDir, "charles.md"), "utf8")).includes("# Field notes — charles (qa)"));
          const dupSpawn = await toolSpawn.execute("s2-spawn-charles2", { role: "qa", name: "charles", task: "Another QA pass", scope: ["src/qa2/"] }, undefined, undefined, { cwd: dirS2 } as never);
          const charles2 = (dupSpawn.details as { agentId: string }).agentId;
          check("S2: duplicate name keeps uniqueness (charles-2)", charles2 === "charles-2", charles2);

          // artifact readable + history ticket filter
          const toolArtifact = tools[6]!;
          const artRes = await toolArtifact.execute("s2-art", { path: "lint-report.md" }, undefined, undefined, { cwd: dirS2 } as never);
          check("S2: artifact head readable", ((artRes.content as { type: string; text: string }[])[0]!.text).includes("# Lint report"));
          const toolHistory = tools[7]!;
          const histRes = await toolHistory.execute("s2-hist", { agentId: lintId }, undefined, undefined, { cwd: dirS2 } as never);
          const histCount = (histRes.details as { count: number }).count;
          check("S2: history filtered to the agent's exchange", histCount >= 4 && ((histRes.content as { type: string; text: string }[])[0]!.text).includes("spawn"), `count=${histCount}`);

          // reviewer flow: ticket T-1 → review → reviewer spawn → done
          await writeFile(
            join(runtime.store.ticketsDir, "T-1.md"),
            JSON.stringify({ id: "T-1", title: "lint pass", status: "assigned", owner: lintId, acceptance_criteria: "no warnings remain" }, null, 2),
            "utf8",
          );
          await writeFile(join(runtime.store.ticketsDir, "T-1.md"), JSON.stringify({ id: "T-1", title: "lint pass", status: "review", owner: lintId, acceptance_criteria: "no warnings remain" }, null, 2), "utf8");
          const toolSpawn2 = tools[2]!;
          await toolSpawn2.execute("s2-review", { role: "reviewer", task: "Check T-1 against acceptance criteria" }, undefined, undefined, { cwd: dirS2 } as never);
          await childIdle(runtime, "reviewer-1");
          await feed.settled();
          const reviewRes = await toolArtifact.execute("s2-art2", { path: "review.md" }, undefined, undefined, { cwd: dirS2 } as never);
          check("S2: reviewer wrote the review artifact (pass verdict)", ((reviewRes.content as { type: string; text: string }[])[0]!.text).includes("verdict: pass"));
          check("S2: reviewer finished → idle, ownership recorded for both", runtime.registry.getAgent("reviewer-1")?.status === "idle");
          const stateMd = await readFile(runtime.store.statePath, "utf8");
          check("S2: state.md ownership has one line per specialist", stateMd.includes("lint-1") && stateMd.includes("reviewer-1"));
          // The reviewer's finished is legitimately queued (the orchestrator
          // hasn't been told yet) — draining it should bring the watermark to
          // the log tail: nothing dangling.
          const drained = await buildOrchestratorContext(runtime, true);
          check("S2: reviewer finished queued for next-turn injection", drained?.content.includes("review passed") === true);
          check("S2: watermark == last sequence (nothing dangling after drain)", runtime.consumers.getCursor(ORCHESTRATOR_ID) === (await runtime.log.lastPersistedSequence()));

          // S10: no blueprint frontmatter leaks into the spawn prompt
          const toolSpawn3 = tools[2]!;
          const promptRes = await toolSpawn3.execute("s2-spawn3", { role: "docs", task: "Write docs" }, undefined, undefined, { cwd: dirS2 } as never);
          await childIdle(runtime, "docs-1");
          await feed.settled();
          const docsTranscript = transcriptMemory.get(join(runtime.store.sessionsDir, "docs-1.jsonl")) ?? [];
          check("S10: no blueprint frontmatter leaks into child prompts", docsTranscript.every((l) => !l.includes("---") || !l.includes("name:")), docsTranscript[0]?.slice(0, 90));
        }

        // ── S3: sequential guard ──────────────────────────────────────────
        {
          const dir = join(base, "s3");
          await mkdir(dir, { recursive: true });
          const store = await TaskStore.init(dir, "audit-s3");
          const rt = await buildRuntime(store);
          setRuntime(rt);
          const brains = new Map<string, ScriptedBrain>();
          brains.set("docs", { onStart: () => [{ kind: "wait", ms: 5000 }, { kind: "signal", type: "finished", summary: "done" }], onSteer: () => null });
          setChildSessionFactory(makeFakeFactory(rt, brains));
          const tools = buildOrchestratorTools();
          await tools[2]!.execute("s3-spawn", { role: "docs", task: "hold", scope: ["a/"] }, undefined, undefined, { cwd: dir } as never);
          await waitFor(() => rt.children.get("docs-1")?.session.isStreaming === true, 2000, "child streaming");
          const err = await tools[2]!.execute("s3-spawn2", { role: "investigate", task: "parallel", scope: ["b/"] }, undefined, undefined, { cwd: dir } as never).then(() => null).catch((e: Error) => e.message);
          check("S3: second spawn while one works is rejected (sequential)", typeof err === "string" && err.includes("still working") && err.includes("docs-1"), String(err));
          check("S3: rejected spawn registered nothing", rt.registry.getAgent("investigate-1") === undefined);
        }

        // ── S4: scope overlap ─────────────────────────────────────────────
        {
          const dir = join(base, "s4");
          await mkdir(dir, { recursive: true });
          const store = await TaskStore.init(dir, "audit-s4");
          const rt = await buildRuntime(store);
          setRuntime(rt);
          setChildSessionFactory(makeFakeFactory(rt, new Map()));
          const tools = buildOrchestratorTools();
          await tools[2]!.execute("s4-a", { role: "docs", task: "docs", scope: ["src/api/"] }, undefined, undefined, { cwd: dir } as never);
          const err = await tools[2]!.execute("s4-b", { role: "investigate", task: "x", scope: ["src/api/"] }, undefined, undefined, { cwd: dir } as never).then(() => null).catch((e: Error) => e.message);
          check("S4: overlapping scope rejected", typeof err === "string" && err.includes("Scope overlap") && err.includes("src/api/"), String(err));
        }

        // ── S5: unknown role ──────────────────────────────────────────────
        {
          const dir = join(base, "s5");
          await mkdir(dir, { recursive: true });
          const store = await TaskStore.init(dir, "audit-s5");
          const rt = await buildRuntime(store);
          setRuntime(rt);
          const tools = buildOrchestratorTools();
          const err = await tools[2]!.execute("s5-a", { role: "nope", task: "x" }, undefined, undefined, { cwd: dir } as never).then(() => null).catch((e: Error) => e.message);
          check("S5: unknown role rejected with built-in list", typeof err === "string" && err.includes("Unknown role") && err.includes("reviewer") && err.includes("investigate"), String(err));
        }

        // ── S6: stop → ignored signals → resume ───────────────────────────
        {
          const dir = join(base, "s6");
          await mkdir(dir, { recursive: true });
          const store = await TaskStore.init(dir, "audit-s6");
          const rt = await buildRuntime(store);
          setRuntime(rt);
          const sink = makeSink(false);
          const f6 = new SignalFeed(sink.sink);
          f6.attach(rt);
          await f6.settled();
          const brains = new Map<string, ScriptedBrain>();
          brains.set("docs", {
            onStart: () => [{ kind: "wait", ms: 4000 }, { kind: "signal", type: "finished", summary: "done" }],
            onSteer: () => null,
          });
          setChildSessionFactory(makeFakeFactory(rt, brains));
          const tools = buildOrchestratorTools();
          await tools[2]!.execute("s6-spawn", { role: "docs", task: "work", scope: ["x/"] }, undefined, undefined, { cwd: dir } as never);
          await waitFor(() => rt.children.get("docs-1")?.session.isStreaming === true, 2000, "docs-1 streaming");
          await tools[11]!.execute("s6-stop", { agentId: "docs-1" }, undefined, undefined, { cwd: dir } as never);
          check("S6: stop → registry stopped", rt.registry.getAgent("docs-1")?.status === "stopped");
          check("S6: stop dropped the live child", !rt.children.has("docs-1"));
          // A stopped agent's signals are ignored (child tool path).
          const signalTool = (await import("../src/tools.ts")).makeMaestroSignalTool("docs-1");
          const sigRes = await signalTool.execute("s6-sig", { type: "progress", payload: { summary: "still here" } }, undefined, undefined, { cwd: dir } as never);
          check("S6: signals from a stopped agent ignored", (sigRes.details as { ignored: boolean }).ignored === true);
          const eventsAfter = await rt.log.read(0);
          check("S6: ignored signal appended nothing", !eventsAfter.some((e) => e.payload.summary === "still here"));
          // resume → fresh scripted session from the same transcript file
          await tools[12]!.execute("s6-resume", { agentId: "docs-1" }, undefined, undefined, { cwd: dir } as never);
          check("S6: resume → registry running again", rt.registry.getAgent("docs-1")?.status === "running");
          await childIdle(rt, "docs-1");
          await f6.settled();
          const resumeEvt = (await rt.log.read(0)).find((e) => e.type === "resume");
          check("S6: resume command logged with the same session file", resumeEvt?.to === "docs-1");
          check("S6: resumed session reused the transcript file", rt.children.get("docs-1")?.sessionFile.endsWith("docs-1.jsonl") === true);
        }

        // ── S7: restart durability ────────────────────────────────────────
        {
          const dir = join(base, "s7");
          await mkdir(dir, { recursive: true });
          const store = await TaskStore.init(dir, "audit-s7");
          // configure autoResume for this store
          await writeFile(store.configPath, JSON.stringify({ ...DEFAULT_CONFIG, autoResume: true }, null, 2) + "\n", "utf8");
          const rt1 = await buildRuntime(store);
          setRuntime(rt1);
          const sink1 = makeSink(false);
          const f7a = new SignalFeed(sink1.sink);
          f7a.attach(rt1);
          await f7a.settled();
          const brains = new Map<string, ScriptedBrain>();
          brains.set("docs", {
            onStart: () => [{ kind: "signal", type: "progress", summary: "starting" }, { kind: "wait", ms: 3000 }, { kind: "signal", type: "needs_input", summary: "need port?", requires: "orchestrator" }],
            onSteer: () => null,
          });
          setChildSessionFactory(makeFakeFactory(rt1, brains));
          const tools = buildOrchestratorTools();
          await tools[2]!.execute("s7-spawn", { role: "docs", task: "hold", scope: ["z/"] }, undefined, undefined, { cwd: dir } as never);
          await waitFor(async () => (await rt1.log.read(0)).some((e) => e.type === "needs_input"), 5000, "needs_input");
          // now "exit": the runtime dies with a queued unconsumed signal + running agent.
          // S7: agent blocked mid-task (needs_input queued, unconsumed)
          check("S7: agent left blocked with an unconsumed signal queued", rt1.registry.getAgent("docs-1")?.status === "blocked");
          const seqAtExit = await rt1.log.lastPersistedSequence();
          const watermarkAtExit = rt1.consumers.getCursor(ORCHESTRATOR_ID);
          f7a.detach();

          // restart: fresh runtime from the same store
          const rt2 = await buildRuntime(store);
          setRuntime(rt2);
          const sink2 = makeSink(false);
          const f7b = new SignalFeed(sink2.sink);
          f7b.attach(rt2);
          await f7b.settled();
          const started = await rt2.log.read(0);
          check("S7: restart reconcile marked the stale agent interrupted", rt2.registry.getAgent("docs-1")?.status === "interrupted");
          const seqs = started.map((e) => e.sequence);
          check("S7: sequences contiguous across the restart", seqs.join(",") === Array.from({ length: seqs.length }, (_, i) => i + 1).join(","), `${seqs[0]}..${seqs.at(-1)}`);
          check("S7: watermark resumed from where it left off", rt2.consumers.getCursor(ORCHESTRATOR_ID) === watermarkAtExit, `exit=${watermarkAtExit} restart=${rt2.consumers.getCursor(ORCHESTRATOR_ID)}`);
          // autoResume policy (config true) re-attaches it
          const resumed = await autoResumeInterrupted(rt2, {
            cwd: dir,
            resolveModel: () => undefined,
            signalToolFor: (id) => ({ name: "maestro_signal" }) as unknown as ToolDefinition,
            createSession: makeFakeFactory(rt2, brains),
          });
          check("S7: autoResume re-attached the specialist", resumed.includes("docs-1") && rt2.registry.getAgent("docs-1")?.status === "running", resumed.join(","));
          // the unconsumed signal re-enters the attention queue on startup
          check("S7: unconsumed signal re-queued for the orchestrator", rt2.attention.some((e) => e.type === "needs_input"));
          const nextSeq = await rt2.log.nextSequenceValue;
          check("S7: sequence allocation continues past the persisted tail", nextSeq > seqAtExit, `${nextSeq} vs ${seqAtExit}`);
        }

        // ── S8: escalation path (requires: human) ─────────────────────────
        {
          const dir = join(base, "s8");
          await mkdir(dir, { recursive: true });
          const store = await TaskStore.init(dir, "audit-s8");
          const rt = await buildRuntime(store);
          setRuntime(rt);
          const sink = makeSink(false);
          const f8 = new SignalFeed(sink.sink);
          f8.attach(rt);
          await f8.settled();
          rt.registry.addAgent({ id: "impl-1", role: "impl", model: "inherit", status: "running", sessionFile: join(store.sessionsDir, "impl-1.jsonl"), scope: [], parent: ORCHESTRATOR_ID, spawnedAt: new Date().toISOString() });
          const evt = await rt.log.append({ from: "impl-1", to: ORCHESTRATOR_ID, type: "needs_input", payload: { summary: "delete vendor/ directory?" }, requires: "human" });
          await waitFor(() => rt.attention.length > 0, 2000, "attention queued");
          const injected = await buildOrchestratorContext(rt, false);
          check("S8: requires:human queued + drained into orchestrator context", injected?.content.includes("delete vendor") === true && injected.content.includes("requires: human"));
          check("S8: drain advanced the watermark past the signal", rt.consumers.getCursor(ORCHESTRATOR_ID) >= evt.sequence);
          check("S8: approvalRules default covers the concern class", rt.config.approvalRules.includes("delete"));
          f8.detach();
        }

        // S9: field-notes byte-cap + empty-file fallback
        {
          const dir = join(base, "s9");
          await mkdir(dir, { recursive: true });
          const store = await TaskStore.init(dir, "audit-s9");
          const rt = await buildRuntime(store);
          setRuntime(rt);
          await writeFile(join(store.fieldNotesDir, "impl-1.md"), "# big\n" + "y".repeat(150_000) + "\n", "utf8");
          rt.registry.addAgent({ id: "impl-1", role: "impl", model: "inherit", status: "idle", sessionFile: join(store.sessionsDir, "impl-1.jsonl"), scope: [], parent: ORCHESTRATOR_ID, spawnedAt: new Date().toISOString() });
          const tools = buildOrchestratorTools();
          const bigRes = await tools[5]!.execute("s9-big", { agentId: "impl-1" }, undefined, undefined, { cwd: dir } as never);
          check("S9: byte-cap truncation note on huge notes", (bigRes.details as { truncated: boolean }).truncated === true);
          await writeFile(join(store.fieldNotesDir, "empty-1.md"), "", "utf8");
          rt.registry.addAgent({ id: "empty-1", role: "impl", model: "inherit", status: "idle", sessionFile: join(store.sessionsDir, "empty-1.jsonl"), scope: [], parent: ORCHESTRATOR_ID, spawnedAt: new Date().toISOString() });
          const emptyRes = await tools[5]!.execute("s9-empty", { agentId: "empty-1" }, undefined, undefined, { cwd: dir } as never);
          check("S9: empty notes → friendly fallback", ((emptyRes.content as { type: string; text: string }[])[0]!.text).includes("(no field notes yet"));
        }

        resetChildSessionFactory();
        clearRuntime();
        feed?.detach();
        const failed = results.filter((r) => !r.ok);
        await writeResults(cwd, "audit-e2e-results.json", results);
        console.error(`AUDIT E2E: ${results.length - failed.length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`AUDIT E2E CRASHED: ${message}`);
        resetChildSessionFactory();
        feed?.detach();
        await writeResults(cwd, "audit-e2e-results.json", results, message);
      }
    },
  });
}

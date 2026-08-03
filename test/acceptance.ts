/**
 * Cross-cutting end-to-end acceptance walkthrough (Phase 6, §12 pattern).
 * TEMP: registered ONLY while imported by index.ts — remove after verification.
 *
 * Three commands, run as real `pi -p` sessions:
 *
 *   /accept-1      (fresh scratch dir)
 *     — static checks: design-doc cross-check (§6 tools, §5 envelope,
 *       status enum, §3 layout), terminology, no stale terms, log-audit
 *       replay logic.
 *     — deterministic in-process scenarios (scripted children via the
 *       child-session factory seam): failure path (unknown model → clean
 *       error; scripted child emits `error` → log + registry idle, no
 *       crash) and escalation isolation (requires:"human" → orchestrator
 *       queue/injection only, never a child→human channel).
 *     — REAL happy path (real LLM children): init → state.md goal + open
 *       ticket T-1 → maestro_define_role (custom "auditor") → spawn impl-1
 *       → progress → needs_input(requires:orchestrator) → maestro_reply →
 *       finished + artifact → reviewer-1 → finished → T-1 done → log audit.
 *
 *   /accept-duar    (fresh scratch dir)
 *     — durability setup: spawn a real child that parks on needs_input;
 *       write duar-ready.txt (with the exact persisted watermark), then hold
 *       the process open so the driver can SIGKILL pi mid-run.
 *
 *   /accept-2       (same dir, after SIGKILL)
 *     — reconcile marks the stale agent interrupted; watermark resumes
 *       exactly (no duplicate/lost events); autoResume=false → surfaced not
 *       auto-resumed; maestro_resume → fresh transcript continuity + new
 *       sequence; field notes intact; log audit replay from 0.
 *
 * Results: <cwd>/accept-1-results.json / accept-2-results.json
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore } from "../src/task-store.ts";
import { buildRuntime, clearRuntime, ensureRuntime, getRuntime, setRuntime, type MaestroRuntime } from "../src/runtime.ts";
import { SignalFeed, type FeedSink } from "../src/feed.ts";
import { buildOrchestratorTools } from "../src/tools.ts";
import { setChildSessionFactory, resetChildSessionFactory, type ChildSessionHandle, type ChildSessionOptions } from "../src/child-session.ts";
import { ORCHESTRATOR_ID, type AgentStatus } from "../src/types.ts";

const EXT_ROOT = fileURLToPath(new URL("..", import.meta.url));

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
  await writeFile(join(cwd, file), JSON.stringify({ results, failed: failed.length, total: results.length, crashed }, null, 2), "utf8");
}
async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, what: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error(`waitFor timed out: ${what}`);
  return false;
}

// ── static helpers ─────────────────────────────────────────────────────────

async function readAll(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "test") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs, join(rel, entry.name));
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".md") || entry.name.endsWith(".json")) {
        out.set(join(rel, entry.name), await readFile(abs, "utf8"));
      }
    }
  };
  await walk(root, "");
  return out;
}

const DOC_TOOLS = ["maestro_init", "maestro_define_role", "maestro_spawn", "maestro_send", "maestro_reply", "maestro_status", "maestro_history", "maestro_read_transcript", "maestro_read_field_notes", "maestro_read_artifact", "maestro_await", "maestro_stop", "maestro_resume"];
const DOC_ENVELOPE = ["eventId", "sequence", "timestamp", "from", "to", "type", "ticket", "payload", "artifact", "replyTo", "requires"];
const DOC_STATUSES: AgentStatus[] = ["running", "idle", "blocked", "done", "stopped", "interrupted"];
const DOC_LAYOUT = ["state.md", "tickets", "config.json", "agents.json", "consumer.json", "events.jsonl", "artifacts", "field-notes", "agents", "sessions"];

async function staticChecks(check: (n: string, c: boolean, d?: string) => void): Promise<void> {
  const files = await readAll(EXT_ROOT);
  const doc = files.get("pi-maestro-extension.md") ?? "";
  const skills = files.get("skills/maestro/SKILL.md") ?? "";
  const childSkill = files.get("skills/maestro-child/SKILL.md") ?? "";
  const allSrc = [...files.entries()].filter(([rel]) => rel.startsWith("src/") || rel === "index.ts").map(([, c]) => c).join("\n");
  const allMd = [doc, skills, childSkill].join("\n");

  // ── no stale terms (extension or docs) ──
  for (const term of ["traycer", "a2a", "headless"]) {
    check(`static: no stale term "${term}"`, !allSrc.toLowerCase().includes(term) && !allMd.toLowerCase().includes(term));
  }

  // ── terminology ──
  check("term: dir name field-notes/ in code, prose 'field notes' in skills", allSrc.includes("field-notes") && skills.includes("field notes"));
  // The maintainer design doc is intentionally not shipped in this package;
  // when present, cross-check its terminology, otherwise verify the code side.
  check("term: 'watermark' in doc + code", allSrc.includes("watermark") && (!doc || doc.includes("watermark")));
  check("term: consumer.json in doc + code", allSrc.includes("consumer.json") && (!doc || doc.includes("consumer.json")));
  check("term: events.jsonl in doc + code", allSrc.includes("events.jsonl") && (!doc || doc.includes("events.jsonl")));
  check("term: 'specialist' persona in skills, 'child' = session map in runtime", (skills + childSkill).includes("specialist") && allSrc.includes("children"));

  // ── design-doc §6 tool table vs registered tools ──
  const codeTools = buildOrchestratorTools().map((t) => t.name);
  const missingInCode = DOC_TOOLS.filter((n) => !codeTools.includes(n) && n !== "maestro_signal");
  const missingInDoc = codeTools.filter((n) => !DOC_TOOLS.includes(n));
  check("doc§6: every documented tool is registered", missingInCode.length === 0, missingInCode.join(","));
  check("doc§6: every registered orchestrator tool is documented", missingInDoc.length === 0, missingInDoc.join(","));

  // ── design-doc §5 envelope vs MaestroEvent ──
  const typesSrc = files.get("src/types.ts") ?? "";
  const iface = typesSrc.slice(typesSrc.indexOf("export interface MaestroEvent"), typesSrc.indexOf("}", typesSrc.indexOf("export interface MaestroEvent")));
  const codeFields = [...iface.matchAll(/^\s*(\w+)(?:\?)?:/gm)].map((m) => m[1]!);
  check("doc§5: envelope fields match types.ts", DOC_ENVELOPE.every((f) => codeFields.includes(f)) && codeFields.every((f) => DOC_ENVELOPE.includes(f)), codeFields.join(","));

  // ── status enum ──
  const statusOk = DOC_STATUSES.every((s) => typesSrc.includes(`"${s}"`)) && (!doc || doc.match(/running \/ idle \/ blocked \/ done \/ stopped \/ interrupted/) !== null);
  check("doc§6: status enum matches AgentStatus", statusOk);

  // ── §3 layout vs task-store ──
  const ts = files.get("src/task-store.ts") ?? "";
  const layoutOk = DOC_LAYOUT.every((f) => ts.includes(f));
  check("doc§3: store layout matches task-store.ts", layoutOk, DOC_LAYOUT.filter((f) => !ts.includes(f)).join(","));
}

/** Log-audit: contiguous sequences, unique eventIds, required envelope fields. */
async function logAudit(store: TaskStore, check: (n: string, c: boolean, d?: string) => void): Promise<void> {
  const events = JSON.parse(await readFile(store.eventsPath, "utf8").then((s) => `[${s.trim().split("\n").filter(Boolean).join(",")}]`)) as Array<Record<string, unknown>>;
  const seqs = events.map((e) => e.sequence as number);
  check("log: sequences contiguous 1..N", seqs.length === 0 || (seqs.join(",") === Array.from({ length: seqs.length }, (_, i) => i + 1).join(",")), `${seqs[0] ?? "-"}..${seqs.at(-1) ?? "-"}`);
  const ids = events.map((e) => String(e.eventId));
  check("log: eventIds unique", new Set(ids).size === ids.length);
  const required = ["eventId", "sequence", "timestamp", "from", "to", "type", "payload"];
  const bad = events.filter((e) => required.some((k) => e[k] === undefined));
  check("log: every entry has the envelope's required fields", bad.length === 0, bad.map((e) => String(e.eventId)).join(","));
}

// ── minimal scripted child for the deterministic scenarios ────────────────

interface BrainStep {
  waitMs?: number;
  signal?: { type: "progress" | "needs_input" | "finished" | "error"; summary: string; requires?: string };
}
type Brain = (startPrompt: string) => BrainStep[];

async function scriptedScenario(check: (n: string, c: boolean, d?: string) => void, cwd: string, dirName: string, brain: Brain): Promise<MaestroRuntime> {
  const dir = join(cwd, dirName);
  await mkdir(dir, { recursive: true });
  const store = await TaskStore.init(dir, dirName);
  const runtime = await buildRuntime(store);
  setRuntime(runtime);
  const sink: FeedSink = { canWake: () => false, onCard: async () => {}, onWake: () => {}, onStatusChanged: () => {} };
  const feed = new SignalFeed(sink);
  feed.attach(runtime);
  await feed.settled();

  setChildSessionFactory(async (opts: ChildSessionOptions): Promise<ChildSessionHandle> => {
    const agentId = opts.agentId;
    const sessionFile = join(opts.store.sessionsDir, `${agentId}.jsonl`);
    const steps = brain("");
    let streaming = false;
    let stepIdx = 0;
    const session = {
      get isStreaming() {
        return streaming;
      },
      prompt: async () => { /* orchestrator messages to this child: no-op */ },
      steer: async () => { /* no-op */ },
      abort: async () => { streaming = false; },
      dispose: () => { streaming = false; },
    } as never;
    return {
      agentId,
      session,
      sessionFile,
      start: (p: string) => {
        void (async () => {
          streaming = true;
          for (const step of steps) {
            if (step.waitMs) await new Promise((r) => setTimeout(r, step.waitMs));
            if (step.signal) {
              await opts.log.append({
                from: agentId,
                to: ORCHESTRATOR_ID,
                type: step.signal.type,
                payload: { summary: step.signal.summary },
                requires: step.signal.requires as "none" | "orchestrator" | "human" | undefined,
              });
            }
            stepIdx++;
            if (stepIdx >= steps.length) streaming = false;
          }
          streaming = false;
        })();
        void p;
      },
      dispose: () => { streaming = false; },
    };
  });

  const tools = buildOrchestratorTools();
  const spawnRes = await tools[2]!.execute("ac-spawn", { role: "investigate", task: "scripted", scope: ["src/scenario/"] }, undefined, undefined, { cwd: dir } as never);
  const agentId = (spawnRes.details as { agentId: string }).agentId;
  await waitFor(async () => (await runtime.log.read(0)).some((e) => e.from === agentId && (e.type === "error" || e.type === "needs_input" || e.type === "finished")), 15_000, `scripted ${dirName} signal`);
  await feed.settled();
  check(`${dirName}: scripted child signalled`, true, agentId);
  resetChildSessionFactory();
  return runtime;
}

// ── commands ───────────────────────────────────────────────────────────────

export function registerAcceptance(pi: ExtensionAPI): void {
  // ── /accept-1 — static + deterministic + real happy path ────────────────
  pi.registerCommand("accept-1", {
    description: "Acceptance: static checks + failure path + real happy path",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const { results, check } = makeResults();
      try {
        // ── 1. static checks (design-doc cross-check + terminology) ──────
        await staticChecks(check);

        // ── 2. deterministic failure path: unknown model → clean error ────
        {
          const dir = join(cwd, "ac-fail-model");
          await mkdir(dir, { recursive: true });
          const store = await TaskStore.init(dir, "ac-fail-model");
          const runtime = await buildRuntime(store);
          setRuntime(runtime);
          const tools = buildOrchestratorTools();
          // real ctx so ctx.modelRegistry exists; the tool's ensureRuntime keeps
          // the fail-model runtime (already set) for this store
          const err = await tools[2]!.execute("ac-bad", { role: "investigate", task: "x", model: "opencode/does-not-exist-xyz" }, undefined, undefined, ctx as never)
            .then(() => null)
            .catch((e: Error) => e.message);
          check("fail: unknown model → clean tool error, no crash", typeof err === "string" && err.includes("Unknown model"), String(err));
          check("fail: no agent registered on failure", runtime.registry.listAgents().length === 0);
        }

        // ── 3. deterministic failure path: child emits error → log + idle ──
        {
          const rt = await scriptedScenario(check, cwd, "ac-fail-run", () => [{ waitMs: 80 }, { signal: { type: "error", summary: "Specialist run failed" } }]);
          const errEvent = (await rt.log.read(0)).find((e) => e.type === "error");
          check("fail: error event landed in the log", Boolean(errEvent), String(errEvent?.payload?.summary));
          check("fail: registry marked the errored agent idle", rt.registry.listAgents().find((a) => a.role === "investigate")?.status === "idle", rt.registry.listAgents().map((a) => `${a.id}:${a.status}`).join(","));
          // action signals are queued (non-interactive) — the watermark advances
          // only when drained; what matters: the error is surfaced and handled
          const surfaced = rt.attention.some((a) => a.eventId === errEvent?.eventId) || rt.consumers.getCursor(ORCHESTRATOR_ID) >= (errEvent?.sequence ?? -1);
          check("fail: error surfaced to the orchestrator (attention/watermark), no crash", surfaced, `attention=${rt.attention.length} w=${rt.consumers.getCursor(ORCHESTRATOR_ID)}`);
        }

        // ── 4. deterministic escalation isolation: requires:"human" ───────
        {
          const rt = await scriptedScenario(check, cwd, "ac-escalate", () => [{ waitMs: 80 }, { signal: { type: "needs_input", summary: "human-only escalation", requires: "human" } }]);
          const evt = (await rt.log.read(0)).find((e) => e.type === "needs_input")!;
          check("esc: escalation addressed to the orchestrator, requires human", evt.to === ORCHESTRATOR_ID && evt.requires === "human", `${evt.to}/${evt.requires}`);
          check("esc: queued in the orchestrator's attention (never delivered to a human sink)", rt.attention.some((a) => a.eventId === evt.eventId), `attention=${rt.attention.length}`);
          const { buildPendingContent } = await import("../src/ui.ts");
          const injected = buildPendingContent(rt.attention, []);
          check("esc: orchestrator injection carries the escalation", injected.includes("human-only escalation"), injected.slice(0, 60));
        }

        // ── 5. REAL happy path (real LLM children) ────────────────────────
        {
          const store = await TaskStore.init(cwd, "accept-happy");
          // clear any scenario runtime left behind so the live tools build
          // (and the real extension feed latches onto) the happy-store runtime
          clearRuntime();
          const runtime = await ensureRuntime(cwd);
          runtime.config = await store.loadConfig();
          const tools = buildOrchestratorTools();

          // orchestrator's plan work: goal + open ticket T-1 in state.md
          let stateText = await readFile(store.statePath, "utf8");
          stateText = stateText.replace("## Goal\n\n", "## Goal\n\nCross-cutting acceptance walkthrough: prove the whole orchestration loop with real agents.\n");
          stateText = stateText.replace("(id · title · status · owner)", "T-1 · acceptance walkthrough · open · orchestrator");
          await writeFile(store.statePath, stateText, "utf8");
          check("happy: state.md has goal + open ticket T-1", (await readFile(store.statePath, "utf8")).includes("T-1 · acceptance walkthrough · open") );

          // custom role blueprint
          const defineRes = await tools[1]!.execute("ac-def", { name: "auditor", blueprint: "# Mission\nRun the acceptance audit for this task.\n\n# Inputs\n- the task store root + shared task state\n\n# Outputs\n- artifacts/accept-note.md\n- a finished signal" }, undefined, undefined, ctx as never);
          check("happy: define_role → agents/auditor.md", (await readFile(join(store.blueprintsDir, "auditor.md"), "utf8")).includes("# Mission"));

          // spawn impl-1 (auditor)
          const TASK =
            "ACCEPTANCE WALKTHROUGH — SPECIALIST SCRIPT. Follow exactly, in order:\n" +
            "1) maestro_signal type 'progress', summary 'accept-started'.\n" +
            "2) maestro_signal type 'needs_input', requires 'orchestrator', summary 'Scope question: should the acceptance also cover the SKILL.md files?', details 'Reply with a short decision; I will then finish.'\n" +
            "3) Now STOP and wait. The orchestrator will answer you. Emit nothing until the answer arrives.\n" +
            "4) After the orchestrator's answer appears in your context, use bash to write artifacts/accept-note.md (relative to the task store root in your shared task state) containing your decision, then maestro_signal type 'finished', summary 'accept-done', artifact 'accept-note.md'.\n" +
            "5) Stop after that; emit nothing more.";
          // spawn charles — the auditor role with its own name: id = name, role kept separate
          const spawnRes = await tools[2]!.execute("ac-spawn", { role: "auditor", name: "charles", task: TASK, model: "opencode-go/deepseek-v4-flash", scope: ["src/accept/"] }, undefined, undefined, ctx as never);
          const implId = (spawnRes.details as { agentId: string }).agentId;
          check("happy: named specialist spawned (charles, role auditor)", implId === "charles" && runtime.registry.getAgent("charles")?.role === "auditor", implId);

          // needs_input roundtrip
          const qGot = await waitFor(async () => (await runtime.log.read(0)).some((e) => e.type === "needs_input" && e.from === implId), 480_000, "charles needs_input");
          check("happy: child asked a scoped question (needs_input)", qGot);
          const q = (await runtime.log.read(0)).find((e) => e.type === "needs_input" && e.from === implId);
          check("happy: question addressed to the orchestrator only", q?.to === ORCHESTRATOR_ID, q?.to);
          const replyRes = await tools[8]!.execute("ac-reply", { agentId: implId, replyTo: q!.eventId, message: "Decision: yes — the acceptance covers the SKILL.md files too." }, undefined, undefined, ctx as never);
          check("happy: maestro_reply delivered into the specialist's turn loop", (replyRes.details as { delivered: boolean }).delivered === true, String((replyRes.details as { delivered: boolean }).delivered));

          // finished + artifact
          const fGot = await waitFor(async () => (await runtime.log.read(0)).some((e) => e.type === "finished" && e.from === implId), 480_000, "charles finished");
          check("happy: child finished after the answer", fGot);
          const artifact = await readFile(join(store.artifactsDir, "accept-note.md"), "utf8").catch(() => "");
          check("happy: artifact written", artifact.length > 0, artifact.slice(0, 40));
          const idleGot = await waitFor(async () => runtime.registry.getAgent(implId)?.status === "idle", 30_000, "charles idle (feed applies status)");
          check("happy: charles idle after finished", idleGot, runtime.registry.getAgent(implId)?.status);

          // reviewer flow
          const REVIEW = "ACCEPTANCE REVIEW. Read artifacts/accept-note.md, then maestro_signal type 'progress', summary 'review-started'; then maestro_signal type 'finished', summary 'review-done'. Stop after that.";
          const revRes = await tools[2]!.execute("ac-rev", { role: "reviewer", task: REVIEW, model: "opencode-go/deepseek-v4-flash", scope: ["src/accept/review/"] }, undefined, undefined, ctx as never);
          const revId = (revRes.details as { agentId: string }).agentId;
          check("happy: reviewer-1 spawned", revId === "reviewer-1", revId);
          const revGot = await waitFor(async () => (await runtime.log.read(0)).some((e) => e.type === "finished" && e.from === revId), 480_000, "reviewer finished");
          check("happy: reviewer finished", revGot);

          // T-1 → done
          stateText = (await readFile(store.statePath, "utf8")).replace("T-1 · acceptance walkthrough · open", "T-1 · acceptance walkthrough · done");
          await writeFile(store.statePath, stateText, "utf8");
          check("happy: T-1 marked done", (await readFile(store.statePath, "utf8")).includes("T-1 · acceptance walkthrough · done"));

          // log audit on the real run
          await logAudit(store, check);
        }

        await writeResults(cwd, "accept-1-results.json", results);
        console.error(`ACCEPTANCE 1: ${results.filter((r) => r.ok).length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`ACCEPTANCE 1 CRASHED: ${message}`);
        await writeResults(cwd, "accept-1-results.json", results, message);
      }
    },
  });

  // ── /accept-duar — durability setup (spawn + park + hold for SIGKILL) ───
  pi.registerCommand("accept-duar", {
    description: "Acceptance durability setup: spawn a parked child, hold for SIGKILL",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      try {
        const store = await TaskStore.init(cwd, "accept-duar");
        const runtime = await ensureRuntime(cwd);
        runtime.config = await store.loadConfig();
        const tools = buildOrchestratorTools();
        const TASK =
          "DURABILITY SETUP. 1) maestro_signal type 'progress', summary 'durability-started'. " +
          "2) maestro_signal type 'needs_input', requires 'orchestrator', summary 'parked, waiting for the orchestrator'. " +
          "3) Then STOP and wait for the orchestrator. Emit nothing more until you are resumed.";
        const spawnRes = await tools[2]!.execute("duar-spawn", { role: "investigate", name: "sheila", task: TASK, model: "opencode-go/deepseek-v4-flash", scope: ["src/duar/"] }, undefined, undefined, ctx as never);
        const agentId = (spawnRes.details as { agentId: string }).agentId;
        const parked = await waitFor(async () => (await runtime.log.read(0)).some((e) => e.type === "needs_input" && e.from === agentId), 480_000, "duar parked");
        const wm = runtime.consumers.getCursor(ORCHESTRATOR_ID);
        const events = await runtime.log.read(0);
        await writeFile(join(cwd, "duar-ready.txt"), JSON.stringify({ parked, agentId, watermark: wm, lastSeq: events.at(-1)?.sequence ?? 0, count: events.length }), "utf8");
        console.error(`DUAR SETUP: parked=${parked} agent=${agentId} watermark=${wm} seq=${events.at(-1)?.sequence}`);
        // hold the process open so the driver can SIGKILL pi mid-run
        await new Promise((r) => setTimeout(r, 300_000));
      } catch (err) {
        console.error(`DUAR SETUP CRASHED: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  // ── /accept-2 — post-SIGKILL durability assertions ───────────────────────
  pi.registerCommand("accept-2", {
    description: "Acceptance: post-kill restart durability checks",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const { results, check } = makeResults();
      try {
        const ready = JSON.parse(await readFile(join(cwd, "duar-ready.txt"), "utf8")) as { parked: boolean; agentId: string; watermark: number; lastSeq: number; count: number };
        check("duar: setup had parked the child", ready.parked === true);

        const store = (await TaskStore.discover(cwd))!;
        const runtime = getRuntime() ?? (await ensureRuntime(cwd));
        runtime.config = await store.loadConfig();

        const agent = runtime.registry.getAgent(ready.agentId);
        check("duar: stale agent reconciled → interrupted", agent?.status === "interrupted", agent?.status);
        check("duar: autoResume=false (default) → not auto-resumed", agent?.status === "interrupted", "still interrupted");

        const events = await runtime.log.read(0);
        const seqs = events.map((e) => e.sequence);
        check("duar: sequences contiguous, exactly as killed (no dup, no loss)", seqs.join(",") === Array.from({ length: seqs.length }, (_, i) => i + 1).join(",") && events.length === ready.count, `${events.length} vs ${ready.count}`);
        check("duar: watermark resumes exactly where it left off", runtime.consumers.getCursor(ORCHESTRATOR_ID) === ready.watermark, `w=${runtime.consumers.getCursor(ORCHESTRATOR_ID)} vs ${ready.watermark}`);
        check("duar: queued needs_input re-surfaced in attention", runtime.attention.some((a) => a.type === "needs_input" && a.from === ready.agentId), `attention=${runtime.attention.length}`);

        // field notes survive the kill
        const notes = await readFile(join(store.fieldNotesDir, `${ready.agentId}.md`), "utf8").catch(() => "");
        check("duar: field notes survived", notes.length > 0, notes.slice(0, 30));

        // resume → fresh session from transcript → post-resume signal
        const tools = buildOrchestratorTools();
        const resumeRes = await tools[12]!.execute("ac-resume", { agentId: ready.agentId }, undefined, undefined, ctx as never);
        check("duar: maestro_resume → running", (resumeRes.details as { status: string }).status === "running");
        const contGot = await waitFor(async () => {
          const after = (await runtime.log.read(0)).filter((e) => e.from === ready.agentId && e.sequence > ready.lastSeq);
          return after.length > 0;
        }, 480_000, "resumed child signal");
        check("duar: resumed child emitted a fresh signal (sequence continues)", contGot);
        const last = (await runtime.log.read(0)).at(-1)!;
        check("duar: new sequence continues past the killed tail", last.sequence > ready.lastSeq, `${last.sequence} vs ${ready.lastSeq}`);

        await logAudit(store, check);
        await writeResults(cwd, "accept-2-results.json", results);
        console.error(`ACCEPTANCE 2: ${results.filter((r) => r.ok).length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`ACCEPTANCE 2 CRASHED: ${message}`);
        await writeResults(cwd, "accept-2-results.json", results, message);
      }
    },
  });
}

// settle the real feed (the extension's own SignalFeed processes appends asynchronously)

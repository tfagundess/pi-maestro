/**
 * Phase 3 test harness — unit checks for answering & control (reply / send /
 * forward / stop / resume / await, ticket cancellation, command wiring).
 *
 * Temporary; registered as `/test-phase3` ONLY while imported by index.ts
 * (the live-wiring graph must be shared — the await subscription and the
 * feed share the same `onEventAppended` set). Removed from index.ts after
 * verification. Writes results to <cwd>/test-results.json.
 *
 * Isolated stores under <cwd>/phase3-unit/; no real LLM, no real child —
 * fake child sessions capture delivery (prompt vs steer) and lifecycle.
 */
import type { ExtensionAPI, AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.ts";
import { Registry } from "../src/registry.ts";
import { Consumers } from "../src/consumers.ts";
import { buildRuntime, clearRuntime, setRuntime } from "../src/runtime.ts";
import { buildOrchestratorTools, makeMaestroSignalTool } from "../src/tools.ts";
import { awaitAgent, replyToAgent, resumeAgent, sendToAgent, stopAgent, applySignalStatus } from "../src/control.ts";
import type { ChildSessionHandle } from "../src/child-session.ts";
import { ORCHESTRATOR_ID } from "../src/types.ts";

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

interface FakeChild {
  handle: ChildSessionHandle;
  calls: { kind: string; text: string }[];
  setStreaming: (v: boolean) => void;
  readonly disposed: boolean;
}

/** Fake child session: captures prompt/steer/abort/dispose; isStreaming controllable. */
function makeFakeChild(agentId: string, opts: { streaming?: boolean } = {}): FakeChild {
  const calls: { kind: string; text: string }[] = [];
  let streaming = opts.streaming ?? false;
  let wasDisposed = false;
  const session = {
    get isStreaming() {
      return streaming;
    },
    prompt: async (t: string) => {
      calls.push({ kind: "prompt", text: t });
    },
    steer: async (t: string) => {
      calls.push({ kind: "steer", text: t });
    },
    abort: async () => {
      calls.push({ kind: "abort", text: "" });
      streaming = false;
    },
    dispose: () => {
      wasDisposed = true;
    },
  } as unknown as AgentSession;
  const handle = {
    agentId,
    session,
    sessionFile: `/tmp/${agentId}.jsonl`,
    start: () => {},
    dispose: () => {
      wasDisposed = true;
    },
  } as ChildSessionHandle;
  return {
    handle,
    calls,
    setStreaming: (v: boolean) => {
      streaming = v;
    },
    get disposed() {
      return wasDisposed;
    },
  };
}

async function writeResults(cwd: string, file: string, results: Result[], crashed?: string): Promise<void> {
  const failed = results.filter((r) => !r.ok);
  await writeFile(
    join(cwd, file),
    JSON.stringify({ results, failed: failed.length, total: results.length, crashed }, null, 2),
    "utf8",
  );
}

export function registerPhase3Unit(pi: ExtensionAPI): void {
  pi.registerCommand("test-phase3", {
    description: "Phase 3 unit checks: reply/send/forward/stop/resume/await, ticket cancellation",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const { results, check } = makeResults();
      try {
        const base = join(cwd, "phase3-unit");
        await rm(base, { recursive: true, force: true });
        await mkdir(base, { recursive: true });

        // ── store: the main isolated runtime ──────────────────────────────
        const dirA = join(base, "a");
        await mkdir(dirA, { recursive: true });
        const storeA = await TaskStore.init(dirA, "control");
        const runtimeA = await buildRuntime(storeA);

        const agent = {
          id: "impl-1",
          role: "impl",
          model: "opencode-go/deepseek-v4-flash",
          status: "running" as const,
          sessionFile: "/tmp/impl-1.jsonl",
          scope: ["src/a/"],
          parent: "orchestrator",
          spawnedAt: new Date().toISOString(),
        };
        runtimeA.registry.addAgent(agent);
        await runtimeA.registry.persist(storeA);

        const fake = makeFakeChild("impl-1");
        runtimeA.children.set("impl-1", fake.handle);

        // ── maestro_reply ─────────────────────────────────────────────────
        const question = await runtimeA.log.append({
          from: "impl-1", to: "orchestrator", type: "needs_input",
          payload: { summary: "port 3000 taken", details: "tried 3001-3005" }, requires: "orchestrator",
        });
        const reply = await replyToAgent(runtimeA, "impl-1", question.eventId, "use port 3001");
        check("reply: command recorded (from orchestrator, to agent)", reply.event.from === ORCHESTRATOR_ID && reply.event.to === "impl-1");
        check("reply: replyTo = the signal's eventId", reply.event.replyTo === question.eventId);
        check("reply: sequence after the question it answers", reply.event.sequence > question.sequence);
        check("reply: delivered to the idle child via prompt", fake.calls.some((c) => c.kind === "prompt" && c.text.includes("use port 3001")), fake.calls.map((c) => c.kind).join(","));
        check("reply: delivered text correlates the answer", fake.calls.some((c) => c.text.includes(`Answer from the orchestrator to ${question.eventId}`)));
        const badReply = await replyToAgent(runtimeA, "impl-1", "sig-999", "x").then(() => null).catch((e: Error) => e.message);
        check("reply: rejects unknown replyTo", typeof badReply === "string" && badReply.includes("Unknown replyTo"));

        // ── reply while streaming → steer, not prompt ─────────────────────
        const fake2 = makeFakeChild("impl-1", { streaming: true });
        const old = runtimeA.children.get("impl-1")!;
        runtimeA.children.set("impl-1", fake2.handle);
        await replyToAgent(runtimeA, "impl-1", question.eventId, "use 3002");
        check("reply (streaming): delivered via steer, not prompt", fake2.calls.some((c) => c.kind === "steer") && !fake2.calls.some((c) => c.kind === "prompt"), fake2.calls.map((c) => c.kind).join(","));
        runtimeA.children.set("impl-1", old);

        // ── maestro_send / forward ────────────────────────────────────────
        const send = await sendToAgent(runtimeA, "impl-1", "check the diff");
        check("send: 'send' command in the log", send.event.type === "send" && send.event.to === "impl-1");
        check("send: delivered", send.delivered && fake.calls.some((c) => c.kind === "prompt" && c.text === "check the diff"));
        const fwd = await sendToAgent(runtimeA, "impl-1", "review found a leak", true);
        check("forward: 'forward' command in the log", fwd.event.type === "forward");
        check("forward: delivered as a relay", fake.calls.some((c) => c.text.includes("Forwarded from the orchestrator:") && c.text.includes("review found a leak")));
        const allLog = await runtimeA.log.read(0);
        const seqs = allLog.map((e) => e.sequence);
        check("log: events and commands interleaved in sequence order", seqs.join(",") === Array.from({ length: seqs.length }, (_, i) => i + 1).join(","), seqs.join(","));

        // ── registry status follows consumed signals (§3) ────────────────
        const finEvt = await runtimeA.log.append({ from: "impl-1", to: "orchestrator", type: "finished", payload: { summary: "t1 done" } });
        await applySignalStatus(runtimeA, finEvt);
        check("status: finished signal → idle (reusable)", runtimeA.registry.getAgent("impl-1")?.status === "idle");
        const needEvt = await runtimeA.log.append({ from: "impl-1", to: "orchestrator", type: "needs_input", payload: { summary: "q" }, requires: "orchestrator" });
        await applySignalStatus(runtimeA, needEvt);
        check("status: needs_input signal → blocked", runtimeA.registry.getAgent("impl-1")?.status === "blocked");
        runtimeA.registry.setStatus("impl-1", "interrupted");
        await applySignalStatus(runtimeA, finEvt);
        check("status: interrupted wins over signal status (restart surfacing)", runtimeA.registry.getAgent("impl-1")?.status === "interrupted");
        runtimeA.registry.setStatus("impl-1", "running");
        await runtimeA.registry.persist(storeA);

        // ── maestro_stop ──────────────────────────────────────────────────
        const stopFake = makeFakeChild("impl-1", { streaming: true });
        runtimeA.children.set("impl-1", stopFake.handle);
        const stopRes = await stopAgent(runtimeA, "impl-1");
        check("stop: registry → stopped", runtimeA.registry.getAgent("impl-1")?.status === "stopped");
        check("stop: 'stop' command in the log", stopRes.event?.type === "stop" && stopRes.event.to === "impl-1");
        check("stop: in-flight run aborted", stopFake.calls.some((c) => c.kind === "abort"));
        check("stop: child disposed and dropped", stopFake.disposed && !runtimeA.children.has("impl-1"));
        const stopAgain = await stopAgent(runtimeA, "impl-1");
        check("stop: idempotent (no duplicate command)", stopAgain.event === null);

        // signals from a stopped agent are ignored (§6) — via the child tool.
        const signalTool = makeMaestroSignalTool("impl-1");
        const sigRes = await signalTool.execute("tc-sig", { type: "progress", payload: { summary: "still here" } }, undefined, undefined, { cwd: dirA } as never);
        check("stopped: later child signals ignored", (sigRes.details as { ignored: boolean }).ignored === true);
        const afterIgnore = await runtimeA.log.read(0);
        check("stopped: no event appended for the ignored signal", !afterIgnore.some((e) => e.payload.summary === "still here"));

        // ── ticket cancellation ───────────────────────────────────────────
        // Orchestrator updates the ticket (orchestrator-owned) + records the
        // corresponding command in the log (§3): redirect via send, stop via stop.
        runtimeA.registry.setStatus("impl-1", "running");
        await runtimeA.registry.persist(storeA);
        await writeFile(join(storeA.ticketsDir, "T-1.md"), JSON.stringify({ id: "T-1", title: "add oauth", status: "cancelled", owner: "impl-1" }), "utf8");
        const cancel = await stopAgent(runtimeA, "impl-1", "T-1");
        check("cancel: ticket file updated to cancelled", JSON.parse(await readFile(join(storeA.ticketsDir, "T-1.md"), "utf8")).status === "cancelled");
        check("cancel: log contains the corresponding command with ticket", cancel.event?.type === "stop" && cancel.event.ticket === "T-1", JSON.stringify(cancel.event));

        // ── maestro_resume (injected session factory) ─────────────────────
        const resumeStarts: string[] = [];
        let factorySessionFile: string | undefined;
        const fakeFactory = (async (opts: { sessionFile?: string }) => {
          factorySessionFile = opts.sessionFile;
          const h = makeFakeChild("impl-1");
          return {
            ...h.handle,
            start: (p: string) => {
              resumeStarts.push(p);
            },
            dispose: () => {},
          } as ChildSessionHandle;
        }) as never;

        runtimeA.registry.setStatus("impl-1", "stopped");
        await runtimeA.registry.persist(storeA);
        const resumeRes = await resumeAgent(runtimeA, "impl-1", {
          cwd: dirA,
          signalTool: makeMaestroSignalTool("impl-1"),
          createSession: fakeFactory as never,
        });
        check("resume: registry → running", runtimeA.registry.getAgent("impl-1")?.status === "running");
        check("resume: 'resume' command in the log", resumeRes.event.type === "resume" && resumeRes.event.to === "impl-1");
        check("resume: fresh session loaded from the transcript file", factorySessionFile === "/tmp/impl-1.jsonl", factorySessionFile);
        check("resume: child started with 'continue from your transcript'", resumeStarts.some((p) => p.includes("continue from your transcript")));
        check("resume: child in runtime.children", runtimeA.children.has("impl-1"));

        // ── maestro_await ─────────────────────────────────────────────────
        // Simulate prior consumption: the orchestrator has already handled
        // everything up to the resume command (wake/drain advances the
        // watermark), so the "next signal" is what follows.
        runtimeA.registry.setStatus("impl-1", "running");
        await runtimeA.registry.persist(storeA);
        runtimeA.consumers.setCursor(ORCHESTRATOR_ID, resumeRes.event.sequence);
        await runtimeA.consumers.persist(storeA);

        // cross-check path: signal already in the log past the watermark — a
        // child can signal before the await subscribes.
        const finished = await runtimeA.log.append({
          from: "impl-1", to: "orchestrator", type: "finished",
          payload: { summary: "done" }, artifact: "impl-notes.md",
        });
        const awa1 = await awaitAgent(runtimeA, "impl-1", 5000);
        check("await: cross-check resolves on finished already in log", awa1.status === "signal" && awa1.event?.eventId === finished.eventId, `${awa1.status} ${awa1.event?.eventId ?? ""}`);
        check("await: watermark advanced past the reported signal", (await Consumers.load(storeA)).getCursor(ORCHESTRATOR_ID) >= finished.sequence);

        // subscription path: needs_input appended after the await subscribes;
        // a streaming child keeps the idle check from short-circuiting.
        const streamFake = makeFakeChild("impl-1", { streaming: true });
        runtimeA.children.set("impl-1", streamFake.handle);
        const p2 = awaitAgent(runtimeA, "impl-1", 5000);
        await runtimeA.log.append({ from: "impl-1", to: "orchestrator", type: "needs_input", payload: { summary: "need answer" }, requires: "orchestrator" });
        const awa2 = await p2;
        check("await: resolves on needs_input (no deadlock)", awa2.status === "signal" && awa2.event?.type === "needs_input", `${awa2.status} ${awa2.event?.type ?? ""}`);

        // progress alone never resolves; timeout fires instead.
        const fakeStreaming = makeFakeChild("impl-1", { streaming: true });
        runtimeA.children.set("impl-1", fakeStreaming.handle);
        const p3 = awaitAgent(runtimeA, "impl-1", 400);
        await runtimeA.log.append({ from: "impl-1", to: "orchestrator", type: "progress", payload: { summary: "working" } });
        const awa3 = await p3;
        check("await: progress never resolves; times out", awa3.status === "timeout", awa3.status);

        // idle child (run ended, nothing pending) → idle, not a hang.
        const idleFake = makeFakeChild("impl-1");
        runtimeA.children.set("impl-1", idleFake.handle);
        const awa4 = await awaitAgent(runtimeA, "impl-1", 5000);
        check("await: idle child reported instead of hanging", awa4.status === "idle", awa4.status);

        // stopped / interrupted shortcuts.
        runtimeA.registry.setStatus("impl-1", "stopped");
        const awa5 = await awaitAgent(runtimeA, "impl-1", 5000);
        check("await: stopped agent reported immediately", awa5.status === "stopped");
        runtimeA.registry.setStatus("impl-1", "interrupted");
        runtimeA.children.delete("impl-1");
        const awa6 = await awaitAgent(runtimeA, "impl-1", 5000);
        check("await: interrupted agent reported immediately", awa6.status === "interrupted");
        const awa7 = await awaitAgent(runtimeA, "ghost-1", 100);
        check("await: unknown agent reported", awa7.status === "missing");

        // ── tool wiring smoke test (maestro_reply via the registered tool) ─
        setRuntime(runtimeA);
        runtimeA.registry.setStatus("impl-1", "running");
        await runtimeA.registry.persist(storeA);
        const toolFake = makeFakeChild("impl-1");
        runtimeA.children.set("impl-1", toolFake.handle);
        const q2 = await runtimeA.log.append({ from: "impl-1", to: "orchestrator", type: "needs_input", payload: { summary: "q2" }, requires: "orchestrator" });
        const tools = buildOrchestratorTools();
        const toolReply = tools[8]!; // maestro_reply
        const tr = await toolReply.execute("t1", { agentId: "impl-1", replyTo: q2.eventId, message: "tool answer" }, undefined, undefined, { cwd: dirA } as never);
        check("tool: maestro_reply records + delivers", (tr.content[0] as { text: string }).text.includes("Reply command recorded") && toolFake.calls.some((c) => c.text.includes("tool answer")));
        const tools2 = buildOrchestratorTools();
        const toolStop = tools2[11]!; // maestro_stop
        const ts = await toolStop.execute("t2", { agentId: "impl-1" }, undefined, undefined, { cwd: dirA } as never);
        check("tool: maestro_stop marks stopped", (ts.details as { status: string }).status === "stopped");
        const regAfterStop = await Registry.load(storeA);
        check("tool: /maestro stop path → registry stopped", regAfterStop.getAgent("impl-1")?.status === "stopped");

        clearRuntime();
        const failed = results.filter((r) => !r.ok);
        await writeResults(cwd, "test-results.json", results);
        console.error(`PHASE 3 UNIT: ${results.length - failed.length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`PHASE 3 UNIT CRASHED: ${message}`);
        await writeResults(cwd, "test-results.json", results, message);
      }
    },
  });
}

/**
 * Phase 3 — Answering & control (§5, §6, §7, §11).
 *
 * The orchestrator's command surface: reply / send / forward / stop / resume /
 * await. Every command is recorded in the SAME events.jsonl as events — the
 * log is the complete, replayable conversation in both directions — and then
 * delivered into the child's turn loop (steer while streaming, a fresh prompt
 * when idle; both fire-and-forget, mirroring spawn's run handling). Delivery
 * is best-effort: the log entry is the source of truth; a child that isn't
 * live (interrupted / stopped) simply receives the command on resume.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ORCHESTRATOR_ID, isSignalType, type MaestroEvent, type RegistryAgent } from "./types.ts";
import { onEventAppended } from "./events.ts";
import type { MaestroRuntime } from "./runtime.ts";
import { buildResumePrompt, createChildSession, type ChildSessionHandle } from "./child-session.ts";
import { readBlueprint } from "./task-store.ts";
import { builtinBlueprint } from "./blueprints.ts";

// ── delivery into the child's turn loop (§14) ──────────────────────────────

/**
 * Deliver a message to a specialist. Streaming → `steer` (queued at the next
 * tool boundary, before the next LLM call); idle → a fresh fire-and-forget
 * `prompt` (starts a new turn without blocking the caller). Failures surface
 * as `error` signals so the orchestrator learns, not crashes.
 */
export function deliverToChild(runtime: MaestroRuntime, agentId: string, text: string): boolean {
  const handle = runtime.children.get(agentId);
  if (!handle) return false;

  const fail = (err: unknown): void => {
    // A stopped agent's signals are ignored (§6) — including delivery errors.
    if (runtime.registry.getAgent(agentId)?.status === "stopped") return;
    const message = err instanceof Error ? err.message : String(err);
    void runtime.log
      .append({
        from: agentId,
        to: ORCHESTRATOR_ID,
        type: "error",
        payload: { summary: "Command delivery failed", details: message },
      })
      .catch(() => {});
  };

  if (handle.session.isStreaming) {
    void handle.session.steer(text).catch(fail);
  } else {
    // `streamingBehavior` is only read while streaming; idle turns start fresh.
    void handle.session.prompt(text, { streamingBehavior: "steer" }).catch(fail);
  }
  return true;
}

/** Look up a signal by eventId (for replyTo validation). */
async function findEvent(runtime: MaestroRuntime, eventId: string): Promise<MaestroEvent | null> {
  const events = await runtime.log.read(0);
  return events.find((e) => e.eventId === eventId) ?? null;
}

// ── commands ───────────────────────────────────────────────────────────────

export interface CommandResult {
  event: MaestroEvent;
  /** Whether the message was delivered to a live child session. */
  delivered: boolean;
  /** Registry status of the recipient at delivery time. */
  status: string;
}

/**
 * `maestro_reply(agentId, replyTo, message)` — answer a specialist's
 * needs_input / unblock it. The command carries `replyTo` = the signal's
 * eventId and lands in the log with a sequence after the question it answers.
 */
export async function replyToAgent(
  runtime: MaestroRuntime,
  agentId: string,
  replyTo: string,
  message: string,
  ticket?: string,
): Promise<CommandResult> {
  const agent = runtime.registry.getAgent(agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  const target = await findEvent(runtime, replyTo);
  if (!target) {
    throw new Error(`Unknown replyTo eventId "${replyTo}" — use the eventId of the signal you are answering (see maestro_history).`);
  }
  const event = await runtime.log.append({
    from: ORCHESTRATOR_ID,
    to: agentId,
    type: "reply",
    replyTo,
    ticket: ticket ?? null,
    payload: { summary: message },
  });
  const delivered = deliverToChild(runtime, agentId, `[Answer from the orchestrator to ${replyTo}]\n${message}`);
  return { event, delivered, status: agent.status };
}

/**
 * `maestro_send(agentId, message, {forward?})` — send instructions; with
 * `forward: true` the command is recorded as a `forward` (relaying a sibling
 * agent's message, §5/§6).
 */
export async function sendToAgent(
  runtime: MaestroRuntime,
  agentId: string,
  message: string,
  forward = false,
  ticket?: string,
): Promise<CommandResult> {
  const agent = runtime.registry.getAgent(agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  const event = await runtime.log.append({
    from: ORCHESTRATOR_ID,
    to: agentId,
    type: forward ? "forward" : "send",
    ticket: ticket ?? null,
    payload: {
      summary: message,
      details: forward ? "Forwarded via maestro_send(forward: true)" : undefined,
    },
  });
  const text = forward ? `Forwarded from the orchestrator:\n${message}` : message;
  const delivered = deliverToChild(runtime, agentId, text);
  return { event, delivered, status: agent.status };
}

/**
 * `maestro_stop(agentId)` — registry → `stopped`, terminate the run (abort
 * in-flight generation where the platform allows; otherwise the run ends at
 * the next signal boundary). Signals from a stopped agent are ignored until
 * it is explicitly resumed (§6, §11).
 */
export async function stopAgent(
  runtime: MaestroRuntime,
  agentId: string,
  ticket?: string,
): Promise<{ event: MaestroEvent | null; agentId: string; status: string }> {
  const agent = runtime.registry.getAgent(agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);

  if (agent.status === "stopped") {
    return { event: null, agentId, status: "stopped" }; // idempotent
  }

  const event = await runtime.log.append({
    from: ORCHESTRATOR_ID,
    to: agentId,
    type: "stop",
    ticket: ticket ?? null,
    payload: {
      summary: `Stopped ${agentId}`,
      details: ticket ? `ticket ${ticket} cancelled` : undefined,
    },
  });

  const handle = runtime.children.get(agentId);
  if (handle) {
    try {
      // Abort in-flight generation (waits for the run to become idle); a
      // safety timeout keeps stop from hanging on a stuck platform.
      if (handle.session.isStreaming) {
        await Promise.race([
          handle.session.abort(),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
      }
    } catch { /* abort is best-effort */ }
    handle.dispose();
    runtime.children.delete(agentId);
  }

  runtime.registry.setStatus(agentId, "stopped");
  await runtime.registry.persist(runtime.store);
  return { event, agentId, status: "stopped" };
}

/** Options for resumeAgent (resolved by the caller from the registry + ctx). */
export interface ResumeOptions {
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  cwd: string;
  signalTool: ToolDefinition;
  /** Test seam: the child-session factory (defaults to createChildSession). */
  createSession?: typeof createChildSession;
}

/**
 * `maestro_resume(agentId)` — fresh embedded session loaded from the agent's
 * transcript (`SessionManager.open(sessionFile)`), prompted with the field
 * notes + "continue from your transcript". Registry → `running` (§11).
 */
export async function resumeAgent(
  runtime: MaestroRuntime,
  agentId: string,
  opts: ResumeOptions,
): Promise<{ event: MaestroEvent; agentId: string; sessionFile: string; status: string }> {
  const agent = runtime.registry.getAgent(agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  if (runtime.children.has(agentId)) {
    throw new Error(`${agentId} is already running (status: ${agent.status}) — no resume needed.`);
  }

  const event = await runtime.log.append({
    from: ORCHESTRATOR_ID,
    to: agentId,
    type: "resume",
    payload: { summary: `Resumed ${agentId}` },
  });

  const blueprint =
    (await readBlueprint(runtime.store, agent.role)) ?? builtinBlueprint(agent.role) ?? "";
  const fieldNotes = await readFile(join(runtime.store.fieldNotesDir, `${agentId}.md`), "utf8").catch(() => "");
  const prompt = await buildResumePrompt({
    store: runtime.store,
    agentId,
    role: agent.role,
    blueprint,
    fieldNotes,
  });

  const createSession = opts.createSession ?? createChildSession;
  const handle = await createSession({
    store: runtime.store,
    agentId,
    role: agent.role,
    blueprint,
    task: "", // resume does not re-inject the task — the transcript has it
    log: runtime.log,
    signalTool: opts.signalTool,
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    cwd: opts.cwd,
    sessionFile: agent.sessionFile,
    resumePrompt: prompt,
  });
  runtime.children.set(agentId, handle);

  runtime.registry.addAgent({ ...agent, status: "running", sessionFile: handle.sessionFile });
  await runtime.registry.persist(runtime.store);

  handle.start(prompt);
  return { event, agentId, sessionFile: handle.sessionFile, status: "running" };
}

/** Options for autoResumeInterrupted (the autoResume policy, §8). */
export interface AutoResumeOptions {
  cwd: string;
  thinkingLevel?: ThinkingLevel;
  /** Resolve each agent's model from its registry label (e.g. "inherit" → orchestrator model). */
  resolveModel: (agent: RegistryAgent) => Model<any> | undefined;
  /** Per-agent signal tool (the child's only maestro tool carries its id). */
  signalToolFor: (agentId: string) => ToolDefinition;
  /** Test seam: the child-session factory (defaults to createChildSession). */
  createSession?: typeof createChildSession;
}

/**
 * Policy `autoResume` (§8): when config.autoResume is true, explicit Maestro
 * activation re-attaches interrupted specialists automatically — fresh embedded sessions
 * from their transcripts, no asking. When false (default) it is a no-op and
 * the orchestrator decides on its next turn (the pending injection surfaces
 * them). Best-effort per agent: a failure leaves the agent `interrupted` for
 * the orchestrator to handle.
 */
export async function autoResumeInterrupted(
  runtime: MaestroRuntime,
  opts: AutoResumeOptions,
): Promise<string[]> {
  if (!runtime.config.autoResume) return [];
  const interrupted = runtime.registry.listAgents().filter((a) => a.status === "interrupted");
  const resumed: string[] = [];
  for (const agent of interrupted) {
    try {
      await resumeAgent(runtime, agent.id, {
        model: opts.resolveModel(agent),
        thinkingLevel: opts.thinkingLevel,
        cwd: opts.cwd,
        signalTool: opts.signalToolFor(agent.id),
        createSession: opts.createSession,
      });
      resumed.push(agent.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[maestro] auto-resume of ${agent.id} failed: ${message}`);
    }
  }
  return resumed;
}

// ── maestro_await (§6) ─────────────────────────────────────────────────────

export interface AwaitResult {
  status: "signal" | "timeout" | "idle" | "stopped" | "interrupted" | "missing";
  event?: MaestroEvent;
  waitedMs: number;
  note?: string;
}

/**
 * Advance the orchestrator watermark to an event and de-duplicate it: an
 * action signal the await reports must not also sit in the attention queue or
 * be re-woken by the feed's re-scan.
 */
async function markConsumed(runtime: MaestroRuntime, event: MaestroEvent): Promise<void> {
  runtime.consumedSignals.add(event.eventId);
  runtime.attention = runtime.attention.filter((a) => a.eventId !== event.eventId);
  await applySignalStatus(runtime, event);
  const watermark = runtime.consumers.getCursor(ORCHESTRATOR_ID);
  if (event.sequence > watermark) {
    runtime.consumers.setCursor(ORCHESTRATOR_ID, event.sequence);
    await runtime.consumers.persist(runtime.store);
  }
}

/**
 * Registry status follows what the orchestrator has *consumed* (§3: the
 * registry owns status): a `finished`/`error` specialist is `idle` (alive,
 * available for follow-ups — reuse before respawn), a `needs_input` one is
 * `blocked` (waiting for an answer). Lifecycle statuses (`interrupted` /
 * `stopped`) win over work status — a restarted session must still surface
 * as interrupted so the orchestrator decides whether to resume.
 */
export async function applySignalStatus(runtime: MaestroRuntime, event: MaestroEvent): Promise<void> {
  const agent = runtime.registry.getAgent(event.from);
  if (!agent || agent.status === "interrupted" || agent.status === "stopped") return;
  let status: RegistryAgent["status"] | null = null;
  if (event.type === "finished" || event.type === "error") status = "idle";
  else if (event.type === "needs_input") status = "blocked";
  if (status && agent.status !== status) {
    runtime.registry.setStatus(agent.id, status);
    await runtime.registry.persist(runtime.store);
  }
}

function isActionSignal(event: MaestroEvent, agentId: string): boolean {
  return (
    event.from === agentId &&
    event.to === ORCHESTRATOR_ID &&
    isSignalType(event.type) &&
    event.type !== "progress"
  );
}

/**
 * Wait for a specialist's next actionable signal (needs_input / finished /
 * error; bare progress never resolves it). Resolves immediately when one is
 * already in the log past the orchestrator watermark — a child can signal
 * before the await subscribes — and reports `idle` instead of hanging when
 * the child's run has ended with nothing pending (transcript cross-check).
 */
export function awaitAgent(runtime: MaestroRuntime, agentId: string, timeoutMs: number): Promise<AwaitResult> {
  const agent: RegistryAgent | undefined = runtime.registry.getAgent(agentId);
  if (!agent) {
    return Promise.resolve({ status: "missing", waitedMs: 0, note: `Unknown agent: ${agentId}` });
  }
  if (agent.status === "stopped") {
    return Promise.resolve({ status: "stopped", waitedMs: 0, note: `${agentId} is stopped; resume it to continue.` });
  }
  if (agent.status === "interrupted" && !runtime.children.has(agentId)) {
    return Promise.resolve({ status: "interrupted", waitedMs: 0, note: `${agentId} is interrupted; resume it to continue.` });
  }

  const started = Date.now();
  return new Promise<AwaitResult>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsub: (() => void) | undefined;

    const finish = (r: AwaitResult): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      unsub?.();
      resolve(r);
    };

    // Subscribe FIRST, then cross-check — no gap for a signal to slip in
    // between the log read and the subscription (§6 cross-check path).
    unsub = onEventAppended((event) => {
      if (!isActionSignal(event, agentId)) return;
      void markConsumed(runtime, event).finally(() =>
        finish({ status: "signal", event, waitedMs: Date.now() - started }),
      );
    });

    timer = setTimeout(() => {
      finish({
        status: "timeout",
        waitedMs: Date.now() - started,
        note: `No actionable signal within ${timeoutMs}ms. The specialist is still working — re-await, check maestro_status, or read its transcript.`,
      });
    }, timeoutMs);

    void (async () => {
      const watermark = runtime.consumers.getCursor(ORCHESTRATOR_ID);
      const events = await runtime.log.read(watermark + 1);
      const pending = events.find((e) => isActionSignal(e, agentId));
      if (pending) {
        await markConsumed(runtime, pending);
        finish({ status: "signal", event: pending, waitedMs: Date.now() - started });
        return;
      }
      // Transcript/session cross-check: the child's run ended with nothing
      // pending — report idle rather than deadlock.
      const handle: ChildSessionHandle | undefined = runtime.children.get(agentId);
      if (!handle) {
        const s: AwaitResult["status"] =
          agent.status === "stopped" ? "stopped" : agent.status === "interrupted" ? "interrupted" : "idle";
        finish({
          status: s,
          waitedMs: Date.now() - started,
          note: `No live session for ${agentId} (registry status: ${agent.status}). Resume it or check maestro_status.`,
        });
        return;
      }
      if (!handle.session.isStreaming) {
        // Grace period: a reply just delivered may still be starting its turn
        // (deliverToChild fires the prompt asynchronously). If the run is
        // streaming after the grace, keep waiting on the subscription; only
        // report idle when the run has truly ended with nothing pending.
        const wait = new Promise<void>((r) => setTimeout(r, 3000));
        void wait.then(() => {
          if (handle.session.isStreaming || done) return; // still waiting
          finish({
            status: "idle",
            waitedMs: Date.now() - started,
            note: `${agentId}'s run has ended without a pending actionable signal — read its transcript tail to see what happened, then reply or re-await.`,
          });
        });
      }
    })();
  });
}

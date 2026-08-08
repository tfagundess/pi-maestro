/**
 * Maestro tools (§6) — orchestrator toolset + the child's single tool.
 *
 * Orchestrator session: the full set below.
 * Child session (embedded): exactly one maestro tool — `maestro_signal`
 * (plus the standard coding tools so it can actually work, §8/§11).
 */
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  defineTool,
  truncateHead,
  truncateTail,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  ORCHESTRATOR_ID,
  isCommandType,
  isSignalType,
  type AgentStatus,
  type MaestroEvent,
  type RegistryAgent,
} from "./types.ts";
import { TaskStore, readBlueprint, resolveArtifact } from "./task-store.ts";
import { builtinBlueprint, listBlueprintNames } from "./blueprints.ts";
import { ensureRuntime, getRuntime, type MaestroRuntime } from "./runtime.ts";
import { buildSpawnPrompt, createChildSession, type ChildSessionHandle } from "./child-session.ts";
import { awaitAgent, replyToAgent, resumeAgent, sendToAgent, stopAgent } from "./control.ts";

// ── helpers ────────────────────────────────────────────────────────────────

function textContent(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function resolveModel(ctx: ExtensionContext, modelParam?: string): Model<any> | undefined {
  if (!modelParam) return ctx.model; // inherit the orchestrator's model settings (§11)
  const idx = modelParam.indexOf("/");
  if (idx <= 0 || idx === modelParam.length - 1) {
    const found = ctx.modelRegistry.getAvailable().find((m) => m.id === modelParam);
    if (found) return found;
    throw new Error(`Unknown model: ${modelParam} (use provider/modelId)`);
  }
  const provider = modelParam.slice(0, idx);
  const id = modelParam.slice(idx + 1);
  const found = ctx.modelRegistry.find(provider, id);
  if (!found) throw new Error(`Unknown model: ${modelParam}`);
  return found;
}

/** Resolve the model a specialist was spawned with (registry label → Model). */
export function resolveRegistryModel(ctx: ExtensionContext, label: string): Model<any> | undefined {
  if (!label || label === "inherit") return ctx.model;
  const idx = label.indexOf("/");
  if (idx <= 0 || idx === label.length - 1) return ctx.model;
  const provider = label.slice(0, idx);
  const id = label.slice(idx + 1);
  const found = ctx.modelRegistry.find(provider, id);
  return found ?? ctx.model;
}

function statusLine(agent: { id: string; role: string; status: AgentStatus; scope: string[] }): string {
  const scope = agent.scope.length > 0 ? ` · scope: ${agent.scope.join(", ")}` : "";
  return `- ${agent.id} · ${agent.role} · ${agent.status}${scope}`;
}

function renderSignal(e: MaestroEvent): string {
  const req = e.requires && e.requires !== "none" ? ` (requires: ${e.requires})` : "";
  const art = e.artifact ? ` · artifact: ${e.artifact}` : "";
  return `[${e.type}] ${e.from} (${e.eventId})${req}: "${e.payload.summary}"${art}`;
}

/**
 * Shared status rendering for maestro_status and `/maestro status` (§6):
 * agents + orchestrator watermark + pending signals past the watermark.
 */
async function renderStatus(runtime: MaestroRuntime): Promise<{
  text: string;
  agents: RegistryAgent[];
  pending: MaestroEvent[];
  watermark: number;
}> {
  const { store, registry, consumers, log } = runtime;
  const watermark = consumers.getCursor(ORCHESTRATOR_ID);
  const events = await log.read(watermark + 1);
  const pending = events.filter((e) => e.to === ORCHESTRATOR_ID && isSignalType(e.type));
  const agents = registry.listAgents();
  const lines: string[] = [
    `Agents (${agents.length}):`,
    ...(agents.length > 0 ? agents.map(statusLine) : ["- (none)"]),
    `Orchestrator watermark: ${watermark}`,
    `Pending signals (${pending.length} past watermark):`,
    ...(pending.length > 0 ? pending.map(renderSignal) : ["- (none)"]),
  ];
  if (store.taskId) lines.push(`Task store: ${store.taskId}`);
  return { text: lines.join("\n"), agents, pending, watermark };
}

/** Timeline line for maestro_history: sequence · type · direction · payload. */
function renderTimelineLine(e: MaestroEvent): string {
  const req = e.requires && e.requires !== "none" ? ` (requires: ${e.requires})` : "";
  const ticket = e.ticket ? ` · ticket: ${e.ticket}` : "";
  const art = e.artifact ? ` · artifact: ${e.artifact}` : "";
  return `seq ${e.sequence} · [${e.type}] ${e.from} → ${e.to} (${e.eventId})${ticket}${req}: "${e.payload.summary}"${art}`;
}

// ── orchestrator tools ─────────────────────────────────────────────────────

/** Build the full orchestrator toolset (callable by the LLM or tests). */
export function buildOrchestratorTools(): ToolDefinition[] {
  // maestro_init(task?) — create the Task Store (§3, §6, §10).
  const maestroInit = defineTool({
    name: "maestro_init",
    label: "Maestro Init",
    description:
      "Initialize (or resume) the Maestro task store for this project: " +
      "state.md, tickets/, agents/ blueprints, config.json, agents.json, " +
      "consumer.json, events.jsonl. Safe to call repeatedly; never destroys existing state.",
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "Optional task name used for the store id" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const previous = await TaskStore.discover(ctx.cwd);
      const store = await TaskStore.init(ctx.cwd, params.task ?? undefined);
      const runtime = await ensureRuntime(ctx.cwd);
      const existed = previous?.taskId === store.taskId;
      const config = await store.loadConfig();
      return {
        content: [
          {
            type: "text",
            text: [
              existed ? `Task store resumed: ${store.taskId}` : `Task store created: ${store.taskId}`,
              `Location: ${store.root}`,
              `Policy: maxConcurrentSpecialists=${config.maxConcurrentSpecialists} autoResume=${config.autoResume}`,
            ].join("\n"),
          },
        ],
        details: { taskId: store.taskId, root: store.root, created: !existed },
      };
    },
  });

  // maestro_define_role(name, blueprint) — author a reusable role (§6, §9).
  const maestroDefineRole = defineTool({
    name: "maestro_define_role",
    label: "Maestro Define Role",
    description:
      "Author/save a reusable role blueprint (mission, inputs, outputs) from a description. " +
      "Saved to agents/<name>.md in the task store; later maestro_spawn calls reuse it. " +
      "Ask the human for any specifics the description leaves open (model, thinking level, constraints).",
    parameters: Type.Object({
      name: Type.String({ description: "Role name (lowercase, e.g. impl, reviewer, docs)" }),
      blueprint: Type.String({
        description:
          "Markdown blueprint: # Mission / # Inputs / # Outputs (and any constraints or preferences)",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = await ensureRuntime(ctx.cwd);
      const name = params.name.trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
        throw new Error(`Invalid role name: "${name}" (letters, digits, - and _ only)`);
      }
      const body = params.blueprint.trim();
      const content = body.startsWith("---\n")
        ? body
        : `---\nname: ${name}\n---\n\n${body}`;
      const file = join(runtime.store.blueprintsDir, `${name}.md`);
      await mkdir(runtime.store.blueprintsDir, { recursive: true });
      await writeFile(file, content, "utf8");
      return {
        content: [{ type: "text", text: `Role blueprint saved: agents/${name}.md` }],
        details: { role: name, path: file },
      };
    },
  });

  // maestro_spawn(role, task, model?, scope?) — register + start a specialist (§6, §8, §9).
  const maestroSpawn = defineTool({
    name: "maestro_spawn",
    label: "Maestro Spawn",
    description:
      "Spawn a specialist agent from a role blueprint. Assigns a unique id: an optional " +
      "name (e.g. `charles` — the specialist's own identity) or, when omitted, `<role>-1`, " +
      "`<role>-2`, ... The role is kept separate from the id (a specialist named `charles` " +
      "can have role `qa`; the child is told \"You are charles — a qa specialist\"). " +
      "Creates an embedded session with its own transcript/model/thinking level, injects " +
      "the persona + shared task state + maestro-child protocol, and starts its run. " +
      "Returns the agent id; the agent communicates via maestro_signal. Spawn deliberately " +
      "(see spawn discipline): reuse existing specialists for follow-ups; spawn only for " +
      "substantial, multi-step, async, or independent work. Scope: files/modules this agent owns " +
      "(no two agents may have overlapping scope).",
    parameters: Type.Object({
      role: Type.String({
        description:
          "Role to spawn. Built-ins: reviewer, docs, investigate. Custom roles: any blueprint in agents/.",
      }),
      name: Type.Optional(
        Type.String({
          description:
            "Optional personal name for the specialist (e.g. \"charles\"). When omitted, the id is derived from the role (`<role>-1`).",
        }),
      ),
      task: Type.String({ description: "The task/instruction for this specialist" }),
      model: Type.Optional(
        Type.String({ description: "Optional model as provider/modelId (e.g. opencode/claude-haiku-4-5). Omit to inherit the orchestrator's model." }),
      ),
      scope: Type.Optional(
        Type.Array(Type.String(), {
          description: "Files/modules this specialist owns. Must not overlap any other agent's scope.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = await ensureRuntime(ctx.cwd);
      const { store, log, registry, config } = runtime;

      // Blueprint: built-in or user-authored (§9).
      let blueprint = (await readBlueprint(store, params.role)) ?? builtinBlueprint(params.role);
      if (!blueprint) {
        const builtins = listBlueprintNames().join(", ");
        throw new Error(
          `Unknown role "${params.role}". Built-ins: ${builtins}. Custom roles live in agents/ (use maestro_define_role).`,
        );
      }

      // Unique id + scope ownership (§8 rule 4): an explicit name (e.g.
      // charles with role qa) or the role-derived `<role>-N` when unnamed.
      const agentId = registry.nextAgentId(params.role, params.name);
      const scope = (params.scope ?? []).map((s) => s.trim()).filter(Boolean);
      const overlap = registry.findScopeOverlap(scope);
      if (overlap.length > 0) {
        throw new Error(
          `Scope overlap with an existing agent: ${overlap.join(", ")}. Assign disjoint files/modules or reuse the owning specialist.`,
        );
      }
      // "Sequential" constrains *activity*, not object count (§11). A child is
      // "active" only while it is generating AND has un-finished work: a
      // command (spawn/send/reply/forward/resume) since its last
      // finished/error/needs_input boundary. A child that just emitted
      // `finished` is still wrapping up its trailing turn for a few seconds —
      // it must not block the next spawn.
      const events = await runtime.log.read(0);
      const active: string[] = [];
      for (const h of runtime.children.values()) {
        if (!h.session.isStreaming) continue;
        let working = false;
        for (const e of events) {
          if (e.to === h.agentId && isCommandType(e.type)) working = true;
          else if (
            e.from === h.agentId &&
            (e.type === "finished" || e.type === "error" || e.type === "needs_input")
          ) {
            working = false;
          }
        }
        if (working) active.push(h.agentId);
      }
      if (active.length > 0 && config.maxConcurrentSpecialists === 1) {
        throw new Error(
          `A specialist is still working (${active.join(", ")}) and maxConcurrentSpecialists=1 (sequential model). ` +
            `Wait for its signal (maestro_await) before spawning the next.`,
        );
      }

      // Model + thinking level: explicit or inherited (§11).
      const model = resolveModel(ctx, params.model);
      const modelLabel = model ? `${model.provider}/${model.id}` : "inherit";
      const thinkingLevel = ctx.thinkingLevel;

      const signalTool = makeMaestroSignalTool(agentId);
      const handle: ChildSessionHandle = await createChildSession({
        store,
        agentId,
        role: params.role,
        blueprint,
        task: params.task,
        log,
        signalTool,
        model,
        thinkingLevel,
        cwd: ctx.cwd,
      });
      runtime.children.set(agentId, handle);

      // Registry bookkeeping (§3).
      registry.addAgent({
        id: agentId,
        role: params.role,
        model: modelLabel,
        status: "running",
        sessionFile: handle.sessionFile,
        scope,
        parent: ORCHESTRATOR_ID,
        spawnedAt: new Date().toISOString(),
      });
      await registry.persist(store);

      // Field-notes stub (§8): the specialist appends as it works (things
      // learned, architecture notes, pitfalls, useful commands). Created at
      // spawn so the orchestrator's tail reads always resolve and the stub
      // rides into the spawn prompt's field-notes section.
      await store.createFieldNotes(agentId, params.role);

      // Spawn command lands in the same log as events (§5) — before the
      // child's run starts, so log order is deterministic.
      await log.append({
        from: ORCHESTRATOR_ID,
        to: agentId,
        type: "spawn",
        payload: {
          summary: `Spawned ${agentId} (${params.role})`,
          details: params.task,
          metadata: { model: modelLabel, scope },
        },
      });

      // Ownership dashboard line (state.md is orchestrator-owned; registry owns status).
      await store.recordOwnership(agentId, params.role, scope);

      // Start the run: persona + shared state + task + protocol.
      const prompt = await buildSpawnPrompt({ store, agentId, role: params.role, blueprint, task: params.task });
      handle.start(prompt);

      return {
        content: [
          {
            type: "text",
            text: [
              `Spawned ${agentId} (${params.role})`,
              `model: ${modelLabel}${thinkingLevel ? ` · thinking: ${thinkingLevel}` : ""}`,
              `session: ${handle.sessionFile}`,
              `task: ${params.task}`,
            ].join("\n"),
          },
        ],
        details: { agentId, role: params.role, sessionFile: handle.sessionFile },
      };
    },
  });

  // maestro_status() — agents + pending signals past the watermark (§6).
  const maestroStatus = defineTool({
    name: "maestro_status",
    label: "Maestro Status",
    description:
      "List specialists: role, status (running/idle/blocked/done/stopped/interrupted), scope, " +
      "and any pending signals (events past the orchestrator's watermark, §5).",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const runtime = await ensureRuntime(ctx.cwd);
      const st = await renderStatus(runtime);
      return {
        content: [{ type: "text", text: st.text }],
        details: { agents: st.agents, pendingSignals: st.pending, watermark: st.watermark },
      };
    },
  });

  // maestro_read_transcript(agentId, {tail?}) — read any specialist's session file (§6, §11).
  const maestroReadTranscript = defineTool({
    name: "maestro_read_transcript",
    label: "Maestro Read Transcript",
    description:
      "Read a specialist's durable session file (JSONL transcript on local disk — always possible). " +
      "Use tail to read only recent entries and protect orchestrator context. Output is capped.",
    parameters: Type.Object({
      agentId: Type.String({ description: "Agent id (e.g. impl-1)" }),
      tail: Type.Optional(
        Type.Integer({ minimum: 1, description: "Only the last N transcript entries (default 40)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = await ensureRuntime(ctx.cwd);
      const agent = runtime.registry.getAgent(params.agentId);
      if (!agent) throw new Error(`Unknown agent: ${params.agentId}`);
      const raw = await readFile(agent.sessionFile, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const tail = params.tail ?? 40;
      const slice = lines.slice(Math.max(0, lines.length - tail));

      const rendered = slice
        .map((line) => {
          try {
            const entry = JSON.parse(line) as {
              type?: string;
              customType?: string;
              message?: { role?: string; toolName?: string; content?: unknown };
              data?: unknown;
            };
            if (entry.type === "session") return null;
            if (entry.type === "message" && entry.message) {
              const m = entry.message;
              const text = textContent(m);
              const prefix =
                m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : `tool:${m.toolName ?? "?"}`;
              return `[${prefix}] ${text}`;
            }
            if (entry.type === "custom") {
              return `[custom:${entry.customType ?? "?"}] ${JSON.stringify(entry.data ?? "")}`;
            }
            return null;
          } catch {
            return line;
          }
        })
        .filter((l): l is string => l !== null)
        .join("\n");

      const truncated = truncateTail(rendered, { maxBytes: DEFAULT_MAX_BYTES });
      let note = "";
      if (truncated.truncated) {
        note = `\n\n[Transcript truncated: ${truncated.outputBytes}/${truncated.totalBytes} bytes]`;
      }
      return {
        content: [{ type: "text", text: `${truncated.content}${note}` }],
        details: { agentId: params.agentId, entries: slice.length, truncated: truncated.truncated },
      };
    },
  });

  // maestro_read_field_notes(agentId, {tail?}) — read a specialist's notebook tail (§8).
  const maestroReadFieldNotes = defineTool({
    name: "maestro_read_field_notes",
    label: "Maestro Read Field Notes",
    description:
      "Read a specialist's field notes (field-notes/<agentId>.md — its in-the-moment notebook: " +
      "things learned, architecture notes, pitfalls, useful commands). Reads a tail (last N lines, " +
      "byte-capped) to protect orchestrator context — never whole histories (§8).",
    parameters: Type.Object({
      agentId: Type.String({ description: "Agent id (e.g. impl-1)" }),
      tail: Type.Optional(
        Type.Integer({ minimum: 1, description: "Only the last N lines (default 40)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = await ensureRuntime(ctx.cwd);
      const agent = runtime.registry.getAgent(params.agentId);
      if (!agent) throw new Error(`Unknown agent: ${params.agentId}`);
      const file = join(runtime.store.fieldNotesDir, `${params.agentId}.md`);
      const raw = await readFile(file, "utf8").catch(() => "");
      const lines = raw.split("\n").filter(Boolean);
      const tail = params.tail ?? 40;
      const slice = lines.slice(Math.max(0, lines.length - tail));
      if (slice.length === 0) {
        return {
          content: [{ type: "text", text: `(no field notes yet for ${params.agentId})` }],
          details: { agentId: params.agentId, lines: 0, truncated: false },
        };
      }
      const truncated = truncateTail(slice.join("\n"), { maxBytes: DEFAULT_MAX_BYTES });
      let note = "";
      if (truncated.truncated) {
        note = `\n\n[Field notes truncated: ${truncated.outputBytes}/${truncated.totalBytes} bytes]`;
      }
      return {
        content: [{ type: "text", text: `${truncated.content}${note}` }],
        details: { agentId: params.agentId, lines: slice.length, bytes: truncated.totalBytes, truncated: truncated.truncated },
      };
    },
  });

  // maestro_read_artifact(agentId?, path) — read artifacts produced by agents (§6).
  const maestroReadArtifact = defineTool({
    name: "maestro_read_artifact",
    label: "Maestro Read Artifact",
    description:
      "Read an artifact produced by a specialist (from artifacts/ in the task store). " +
      "Reads the head of the file (cap applied); use for specs, reviews, plans, execution notes.",
    parameters: Type.Object({
      path: Type.String({ description: "Artifact path relative to artifacts/ (e.g. review.md)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = await ensureRuntime(ctx.cwd);
      const file = resolveArtifact(runtime.store, params.path);
      const raw = await readFile(file, "utf8");
      const truncated = truncateHead(raw, { maxBytes: DEFAULT_MAX_BYTES });
      let note = "";
      if (truncated.truncated) {
        note = `\n\n[Artifact truncated: ${truncated.outputBytes}/${truncated.totalBytes} bytes]`;
      }
      return {
        content: [{ type: "text", text: `${truncated.content}${note}` }],
        details: { path: params.path, bytes: truncated.totalBytes, truncated: truncated.truncated },
      };
    },
  });

  // maestro_history(agentId?, ticket?, {tail?}) — the audit view of the event log (§6).
  // Sequence-ordered timeline of the complete conversation (events + commands),
  // optionally filtered by agent (either direction) or ticket, with a tail limit.
  const maestroHistory = defineTool({
    name: "maestro_history",
    label: "Maestro History",
    description:
      "Render the event log as a timeline — sequence-ordered, the complete conversation " +
      "in both directions (signals + commands). Optionally filter by agent (any event where " +
      "the agent is sender or recipient) or by ticket; use tail to read only the last N entries " +
      "and protect orchestrator context. The audit view of orchestration behavior.",
    parameters: Type.Object({
      agentId: Type.Optional(
        Type.String({ description: "Filter to one specialist's exchange (from OR to that agent id)" }),
      ),
      ticket: Type.Optional(Type.String({ description: "Filter to entries linked to a ticket (e.g. T-4)" })),
      tail: Type.Optional(
        Type.Integer({ minimum: 1, description: "Only the last N entries of the filtered timeline" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = await ensureRuntime(ctx.cwd);
      let events = await runtime.log.read(0); // full log, in sequence order
      if (params.agentId) {
        events = events.filter((e) => e.from === params.agentId || e.to === params.agentId);
      }
      if (params.ticket) {
        events = events.filter((e) => e.ticket === params.ticket);
      }
      // Guardrail: a default tail + byte cap protect orchestrator context even
      // when the caller omits `tail` (the persona's token-hygiene rule made
      // mechanical — the same pattern as maestro_read_field_notes).
      const tail = params.tail ?? 100;
      if (events.length > tail) events = events.slice(events.length - tail);
      const lines = events.map(renderTimelineLine);
      const text: string[] = [];
      let bytes = 0;
      let dropped = 0;
      for (const l of lines) {
        if (bytes + l.length + 1 > 8000) {
          dropped = lines.length - text.length;
          break;
        }
        text.push(l);
        bytes += l.length + 1;
      }
      if (dropped > 0) {
        text.push(`…and ${dropped} more — narrow with agentId/ticket.`);
      }
      return {
        content: [
          {
            type: "text",
            text: text.length > 0 ? text.join("\n") : "(no events match the filter)",
          },
        ],
        details: {
          count: events.length,
          agentId: params.agentId ?? null,
          ticket: params.ticket ?? null,
          tail: tail,
          truncated: dropped > 0,
        },
      };
    },
  });

  // maestro_reply(agentId, replyTo, message) — answer a needs_input / unblock (§5, §6).
  const maestroReply = defineTool({
    name: "maestro_reply",
    label: "Maestro Reply",
    description:
      "Answer a specialist's question / unblock it. Appends a 'reply' command to the event log " +
      "(to: <agentId>, replyTo = the signal's eventId, sequence after the question it answers) " +
      "and delivers the answer into the specialist's turn loop. replyTo is the eventId of the " +
      "needs_input signal you are answering (from maestro_status / maestro_history).",
    parameters: Type.Object({
      agentId: Type.String({ description: "Agent id (e.g. impl-1)" }),
      replyTo: Type.String({ description: "The eventId of the signal you are answering (e.g. sig-3)" }),
      message: Type.String({ description: "Your answer / instruction" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = await ensureRuntime(ctx.cwd);
      const { event, delivered } = await replyToAgent(runtime, params.agentId, params.replyTo, params.message);
      return {
        content: [
          {
            type: "text",
            text: [
              `Reply command recorded (${event.eventId}, sequence ${event.sequence}) → ${params.agentId}`,
              delivered
                ? "Delivered into the specialist's turn loop."
                : `NOT delivered — ${params.agentId} has no live session (check maestro_status; the reply is recorded and will be delivered on resume).`,
            ].join("\n"),
          },
        ],
        details: { command: event, delivered },
      };
    },
  });

  // maestro_send(agentId, message, {forward?}) — instructions / sibling relay (§5, §6).
  const maestroSend = defineTool({
    name: "maestro_send",
    label: "Maestro Send",
    description:
      "Send instructions to a specialist. Appends a 'send' command to the event log and delivers " +
      "the message into the specialist's turn loop. forward: true relays another specialist's " +
      "message and records it as a 'forward' command (route sibling concerns through the " +
      "orchestrator — agents never message each other directly).",
    parameters: Type.Object({
      agentId: Type.String({ description: "Recipient agent id (e.g. review-1)" }),
      message: Type.String({ description: "The instruction or relayed message" }),
      forward: Type.Optional(
        Type.Boolean({ description: "Relay a sibling agent's message (recorded as a forward command)" }),
      ),
      ticket: Type.Optional(Type.String({ description: "Optional ticket this command concerns (e.g. T-4)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = await ensureRuntime(ctx.cwd);
      const { event, delivered } = await sendToAgent(runtime, params.agentId, params.message, params.forward ?? false, params.ticket);
      return {
        content: [
          {
            type: "text",
            text: [
              `${event.type} command recorded (${event.eventId}, sequence ${event.sequence}) → ${params.agentId}`,
              delivered
                ? "Delivered into the specialist's turn loop."
                : `NOT delivered — ${params.agentId} has no live session (check maestro_status; the command is recorded and will be delivered on resume).`,
            ].join("\n"),
          },
        ],
        details: { command: event, delivered },
      };
    },
  });

  // maestro_await(agentId, {timeout}) — wait for the next actionable signal (§6).
  const maestroAwait = defineTool({
    name: "maestro_await",
    label: "Maestro Await",
    description:
      "Wait for a specialist's next actionable signal. Resolves on needs_input / finished / error " +
      "(never bare progress) so you respond instead of deadlocking. Cross-checks the event log past " +
      "the watermark first — a child can signal before the await subscribes — and reports idle if the " +
      "child's run has ended with nothing pending. Use after maestro_spawn / maestro_reply to block " +
      "until the child reports.",
    parameters: Type.Object({
      agentId: Type.String({ description: "Agent id to wait on (e.g. impl-1)" }),
      timeout: Type.Optional(
        Type.Integer({ minimum: 1, description: "Seconds to wait (default 600)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = await ensureRuntime(ctx.cwd);
      const timeoutMs = (params.timeout ?? 600) * 1000;
      const result = await awaitAgent(runtime, params.agentId, timeoutMs);
      const e = result.event;
      const lines: string[] = [`await result: ${result.status}${e ? ` (${e.eventId}, seq ${e.sequence})` : ""} · waited ${result.waitedMs}ms`];
      if (e) {
        const req = e.requires && e.requires !== "none" ? ` (requires: ${e.requires})` : "";
        const art = e.artifact ? ` · artifact: ${e.artifact}` : "";
        lines.push(`type: ${e.type}${req}`, `from: ${e.from}`, `summary: "${e.payload.summary}"${art}`);
        if (e.payload.details) lines.push(`details: ${e.payload.details}`);
      }
      if (result.note) lines.push(result.note);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { status: result.status, event: e ?? null, waitedMs: result.waitedMs, note: result.note ?? null },
      };
    },
  });

  // maestro_stop(agentId) — terminate a run, registry → stopped (§6, §11).
  const maestroStop = defineTool({
    name: "maestro_stop",
    label: "Maestro Stop",
    description:
      "Stop a specialist: registry entry → stopped, the run is terminated (in-flight generation " +
      "aborted where the platform allows, otherwise the run ends at the next signal boundary). " +
      "Signals from a stopped agent are ignored until it is explicitly resumed (maestro_resume). " +
      "Use with a ticket to record a ticket cancellation.",
    parameters: Type.Object({
      agentId: Type.String({ description: "Agent id to stop (e.g. impl-1)" }),
      ticket: Type.Optional(Type.String({ description: "Optional ticket this stop concerns (e.g. T-4, cancelled)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = await ensureRuntime(ctx.cwd);
      const result = await stopAgent(runtime, params.agentId, params.ticket);
      const lines = [`${params.agentId}: ${result.status}${result.event ? ` (${result.event.eventId}, seq ${result.event.sequence})` : " (already stopped)"}`];
      if (result.event && params.ticket) lines.push(`ticket ${params.ticket} cancellation recorded in the log.`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result,
      };
    },
  });

  // maestro_resume(agentId) — fresh embedded session from the transcript (§11).
  const maestroResume = defineTool({
    name: "maestro_resume",
    label: "Maestro Resume",
    description:
      "Resume a stopped or interrupted specialist: loads its session file into a fresh embedded " +
      "session (transcript intact), prompts it with its field notes + 'continue from your " +
      "transcript', and marks the registry entry running. Use after a restart (interrupted) or " +
      "after a deliberate stop.",
    parameters: Type.Object({
      agentId: Type.String({ description: "Agent id to resume (e.g. impl-1)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = await ensureRuntime(ctx.cwd);
      const agent = runtime.registry.getAgent(params.agentId);
      if (!agent) throw new Error(`Unknown agent: ${params.agentId}`);
      const result = await resumeAgent(runtime, params.agentId, {
        model: resolveRegistryModel(ctx, agent.model),
        thinkingLevel: ctx.thinkingLevel,
        cwd: ctx.cwd,
        signalTool: makeMaestroSignalTool(params.agentId),
      });
      return {
        content: [
          {
            type: "text",
            text: [
              `Resumed ${params.agentId} (${agent.role})`,
              `resume command: ${result.event.eventId} (seq ${result.event.sequence})`,
              `session: ${result.sessionFile}`,
              `model: ${agent.model}`,
            ].join("\n"),
          },
        ],
        details: result,
      };
    },
  });

  return [
    maestroInit,
    maestroDefineRole,
    maestroSpawn,
    maestroStatus,
    maestroReadTranscript,
    maestroReadFieldNotes,
    maestroReadArtifact,
    maestroHistory,
    maestroReply,
    maestroSend,
    maestroAwait,
    maestroStop,
    maestroResume,
  ];
}

export function registerMaestroTools(pi: ExtensionAPI): void {
  for (const tool of buildOrchestratorTools()) {
    pi.registerTool(tool);
  }
}

// ── child tool: maestro_signal ─────────────────────────────────────────────

export function makeMaestroSignalTool(agentId: string): ToolDefinition {
  return defineTool({
    name: "maestro_signal",
    label: "Maestro Signal",
    description:
      "Emit a structured signal to the orchestrator. Types: progress (informational update), " +
      "needs_input (you cannot continue without an answer — say what you tried in payload.details " +
      "and set requires), finished (your work on the ticket is done — reference your artifacts), " +
      "error (failed — say what you tried). Never talk to the human; never wait on a sibling.",
    parameters: Type.Object({
      type: StringEnum(["progress", "needs_input", "finished", "error"] as const, {
        description: "What happened (factual)",
      }),
      payload: Type.Object({
        summary: Type.String({ description: "One-line summary of what happened" }),
        details: Type.Optional(
          Type.String({ description: "Details: what you tried, context, what you need" }),
        ),
        metadata: Type.Optional(
          Type.Object({
            files: Type.Optional(Type.Array(Type.String(), { description: "Files touched or referenced" })),
          }),
        ),
      }),
      artifact: Type.Optional(
        Type.String({ description: "Artifact path you wrote, relative to artifacts/ (e.g. impl-notes.md)" }),
      ),
      requires: Type.Optional(
        StringEnum(["none", "orchestrator", "human"] as const, {
          description: "Hint: who must answer (orchestrator owns the final call). Default none.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let runtime: MaestroRuntime | null = getRuntime();
      if (!runtime) runtime = await ensureRuntime(ctx.cwd); // RPC transport fallback
      // Signals from a stopped agent are ignored until it is explicitly resumed (§6, §11).
      if (runtime.registry.getAgent(agentId)?.status === "stopped") {
        return {
          content: [
            {
              type: "text",
              text: `Signal ignored: ${agentId} is stopped. Resume via maestro_resume before emitting further signals.`,
            },
          ],
          details: { ignored: true },
        };
      }
      const event = await runtime.log.append({
        from: agentId,
        to: ORCHESTRATOR_ID,
        type: params.type,
        payload: {
          summary: params.payload.summary,
          details: params.payload.details,
          metadata: params.payload.metadata,
        },
        artifact: params.artifact,
        requires: params.requires,
      });
      return {
        content: [
          {
            type: "text",
            text: `Signal recorded (${event.eventId}, sequence ${event.sequence}). Continue working; report again when something changes or you need input.`,
          },
        ],
        details: { eventId: event.eventId, sequence: event.sequence, type: event.type },
      };
    },
  });
}

// ── commands ───────────────────────────────────────────────────────────────

export interface MaestroCommandHooks {
  /** Explicitly create/resume and activate the current orchestrator runtime. */
  activate: (ctx: ExtensionContext, taskName?: string) => Promise<string>;
  /** Whether `/maestro init` has activated Maestro in this Pi session. */
  isActive: () => boolean;
}

export function registerMaestroCommands(pi: ExtensionAPI, hooks: MaestroCommandHooks): void {
  // One command name (pi parses `/maestro init` as name "maestro", args "init").
  pi.registerCommand("maestro", {
    description: "Maestro control: init | status | stop <agentId>",
    handler: async (args, ctx) => {
      const [sub, ...rest] = (args ?? "").trim().split(/\s+/);
      switch (sub) {
        case "init": {
          const taskId = await hooks.activate(ctx, rest.join(" ") || undefined);
          ctx.ui.notify(`Maestro task store ready: ${taskId}`, "info");
          break;
        }
        case "status": {
          if (!hooks.isActive()) {
            ctx.ui.notify("Maestro is inactive. Run /maestro init first.", "warning");
            break;
          }
          const runtime = getRuntime();
          if (!runtime) {
            ctx.ui.notify("Maestro is inactive. Run /maestro init first.", "warning");
            break;
          }
          const st = await renderStatus(runtime);
          ctx.ui.notify(st.text, "info");
          break;
        }
        case "stop": {
          const agentId = rest[0];
          if (!agentId) {
            ctx.ui.notify("Usage: /maestro stop <agentId>", "warning");
            break;
          }
          if (!hooks.isActive()) {
            ctx.ui.notify("Maestro is inactive. Run /maestro init first.", "warning");
            break;
          }
          const runtime = getRuntime();
          if (!runtime) {
            ctx.ui.notify("Maestro is inactive. Run /maestro init first.", "warning");
            break;
          }
          const result = await stopAgent(runtime, agentId);
          ctx.ui.notify(
            `${agentId}: ${result.status}${result.event ? ` (${result.event.eventId}, seq ${result.event.sequence})` : " (already stopped)"}`,
            result.status === "stopped" && result.event ? "info" : "warning",
          );
          break;
        }
        default: {
          ctx.ui.notify(
            "maestro commands: /maestro init [task-name] · /maestro status · /maestro stop <agentId>",
            "info",
          );
        }
      }
    },
  });
}

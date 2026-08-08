/**
 * Shared types for the pi Maestro orchestrator extension.
 * Defines the envelope, registry, and config schemas used by the extension.
 */

/** Structured signals a specialist emits (event → orchestrator). */
export type SignalType = "progress" | "needs_input" | "finished" | "error";

/** Commands the orchestrator issues (→ specialist). Recorded in the same log. */
export type CommandType = "spawn" | "send" | "reply" | "stop" | "resume" | "forward";

export type EventType = SignalType | CommandType;

/** `requires` hint: who the specialist thinks must answer. Orchestrator owns the final call. */
export type RequiresHint = "none" | "orchestrator" | "human";

/** Registry status lifecycle (agents.json). */
export type AgentStatus = "running" | "idle" | "blocked" | "done" | "stopped" | "interrupted";

export const SIGNAL_TYPES = new Set<SignalType>(["progress", "needs_input", "finished", "error"]);
export const COMMAND_TYPES = new Set<CommandType>(["spawn", "send", "reply", "stop", "resume", "forward"]);

export function isSignalType(t: string): boolean {
  return SIGNAL_TYPES.has(t as SignalType);
}

export function isCommandType(t: string): boolean {
  return COMMAND_TYPES.has(t as CommandType);
}

export interface SignalPayload {
  summary: string;
  details?: string;
  metadata?: { files?: string[]; [key: string]: unknown };
}

/**
 * The envelope. `sequence`, `eventId`, `timestamp`, `ticket` are stamped by
 * the extension at append time — producers (specialists) construct none of them.
 */
export interface MaestroEvent {
  eventId: string;
  sequence: number;
  timestamp: string;
  /** Agent id for events ("impl-1"); "orchestrator" for commands. */
  from: string;
  /** "orchestrator" for events; the target agent id for commands. */
  to: string;
  type: EventType;
  ticket?: string | null;
  payload: SignalPayload;
  artifact?: string | null;
  replyTo?: string | null;
  requires?: RequiresHint | null;
}

/** One agent in the registry (agents.json). */
export interface RegistryAgent {
  id: string;
  role: string;
  model: string;
  status: AgentStatus;
  /** Absolute path to the child's durable pi session file (JSONL). */
  sessionFile: string;
  /** Files/modules the specialist owns; never overlaps another agent's scope. */
  scope: string[];
  /** Always "orchestrator" in the current design (agent→agent is an extension, §13). */
  parent: string;
  spawnedAt: string;
}

export interface RegistryFile {
  taskId: string;
  createdAt: string;
  agents: Record<string, RegistryAgent>;
}

/** Policies (config.json) — defaults match the skill rules (§8). */
export interface MaestroConfig {
  /** 1 = the sequential model; raising it is an extension (§13). */
  maxConcurrentSpecialists: number;
  /** Startup re-attach: false = orchestrator surfaces interrupted agents and asks. */
  autoResume: boolean;
  /** Ticket concerns that gate on a reviewer ("review" state). */
  reviewRequired: string[];
  /** needs_input concerns that must reach the human (matches maestro-child rules). */
  approvalRules: string[];
  /** The do-it-yourself vs. spawn line (a hint for the orchestrator LLM). */
  spawnThreshold: string;
}

export const DEFAULT_CONFIG: MaestroConfig = {
  maxConcurrentSpecialists: 1,
  autoResume: false,
  reviewRequired: [],
  approvalRules: ["delete", "api_change", "wide_diff"],
  spawnThreshold:
    "Do quick fixes, single-file changes, and anything answerable from current context yourself. " +
    "Spawn a specialist only for substantial multi-step work, work that needs its own " +
    "transcript/context, or async work (review, investigation, docs). Reuse an existing " +
    "specialist before respawning one.",
};

/** consumer.json — per-consumer cursors; the orchestrator's entry is its watermark. */
export interface ConsumerFile {
  consumers: Record<string, { lastSequence: number }>;
}

export const ORCHESTRATOR_ID = "orchestrator";

/**
 * The feed's render cursor (§3: UI consumers get their own cursor). Cards are
 * appended once per event (persisted in the session file) and never re-rendered;
 * the watermark (orchestrator) governs *consumption* — what the orchestrator LLM
 * has been told about. Two cursors, one monotonic feed.
 */
export const UI_CONSUMER_ID = "orchestrator-ui";

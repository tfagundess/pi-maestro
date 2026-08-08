/**
 * TUI surface for the agent feed (§4) — the passive channel.
 *
 * - Cards: `pi.registerEntryRenderer("maestro-card", ...)` renders every event
 *   (signals + commands) past the render cursor as a card in the transcript.
 *   `needs_input` flagged (warning), `finished`/`error` styled, commands
 *   shown as orchestrator → specialist. Cards persist in the session file and
 *   never re-render (feed governs exactly-once via the ui cursor).
 * - Footer: `ctx.ui.setStatus` — current phase · specialist status · ticket
 *   progress · blocked work.
 * - Pending injection: `drainPendingInjection` builds the message the
 *   `before_agent_start` hook injects into orchestrator context — unconsumed
 *   action signals + interrupted specialists (token-hygiene tails, capped).
 */
import { Box, Text } from "@earendil-works/pi-tui";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  isCommandType,
  ORCHESTRATOR_ID,
  type EventType,
  type MaestroEvent,
  type RegistryAgent,
} from "./types.ts";
import type { MaestroRuntime } from "./runtime.ts";
import { MAESTRO_SKILL_DIR } from "./child-session.ts";

// ── cards ───────────────────────────────────────────────────────────────────

export interface MaestroCardData {
  sequence: number;
  eventId: string;
  type: EventType;
  from: string;
  to: string;
  summary: string;
  details: string | null;
  requires: string | null;
  artifact: string | null;
  ticket: string | null;
  timestamp: string;
}

/** Durable card payload (stored in the session entry). */
export function toCardData(event: MaestroEvent): MaestroCardData {
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    type: event.type,
    from: event.from,
    to: event.to,
    summary: event.payload.summary,
    details: event.payload.details ?? null,
    requires: event.requires && event.requires !== "none" ? event.requires : null,
    artifact: event.artifact ?? null,
    ticket: event.ticket ?? null,
    timestamp: event.timestamp,
  };
}

function cardStyle(type: string): { icon: string; color: ThemeColor } {
  switch (type) {
    case "progress":
      return { icon: "📊", color: "dim" };
    case "needs_input":
      return { icon: "❓", color: "warning" };
    case "finished":
      return { icon: "✅", color: "success" };
    case "error":
      return { icon: "❌", color: "error" };
    default:
      return { icon: "▶", color: "accent" };
  }
}

export function registerMaestroCards(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<MaestroCardData>("maestro-card", (entry, { expanded }, theme) => {
    const d = entry.data ?? ({} as Partial<MaestroCardData>);
    const style = cardStyle(d.type ?? "unknown");
    const command = d.type ? isCommandType(d.type) : false;
    const direction = command ? ` ${d.from} → ${d.to}` : ` ${d.from}`;
    const requires = d.requires ? ` (requires: ${d.requires})` : "";

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(
      new Text(
        theme.fg(style.color, `${style.icon} ${d.type ?? "unknown"}${direction}: "${d.summary ?? ""}"${requires}`),
        0,
        0,
      ),
    );

    if (expanded) {
      if (d.details) box.addChild(new Text(theme.fg("dim", d.details), 0, 0));
      const meta: string[] = [];
      if (d.ticket) meta.push(`ticket: ${d.ticket}`);
      if (d.artifact) meta.push(`artifact: ${d.artifact}`);
      if (d.eventId) meta.push(`eventId: ${d.eventId}`);
      if (typeof d.sequence === "number") meta.push(`sequence: ${d.sequence}`);
      if (d.timestamp) meta.push(new Date(d.timestamp).toISOString());
      if (meta.length > 0) box.addChild(new Text(theme.fg("muted", meta.join(" · ")), 0, 0));
    }

    return box;
  });
}

// ── footer (§4 status line) ─────────────────────────────────────────────────

/** current phase · specialist status · ticket progress · blocked work. */
export async function buildFooterText(runtime: MaestroRuntime): Promise<string> {
  const store = runtime.store;

  let phase = "kickoff";
  try {
    const state = await readFile(store.statePath, "utf8");
    const m = state.match(/## Current phase\s*\n([^\n#]+)/);
    const value = m?.[1]?.trim();
    if (value) phase = value;
  } catch { /* no state.md yet */ }

  const agents = runtime.registry.listAgents();
  const counts = new Map<string, number>();
  for (const a of agents) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
  const statusBits = ["running", "interrupted", "blocked", "done", "stopped", "idle"]
    .filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`);

  let total = 0;
  let done = 0;
  let waiting = 0;
  try {
    const files = await readdir(store.ticketsDir).catch(() => [] as string[]);
    for (const f of files) {
      if (!/\.(md|json)$/.test(f)) continue;
      total += 1;
      const raw = await readFile(join(store.ticketsDir, f), "utf8").catch(() => "");
      let status = "";
      try {
        status = (JSON.parse(raw) as { status?: string })?.status ?? "";
      } catch {
        const m = raw.match(/status\s*[:=]\s*"?([a-z_]+)"?/i);
        status = m?.[1] ?? "";
      }
      if (status === "done") done += 1;
      if (status === "waiting_input") waiting += 1;
    }
  } catch { /* no tickets dir */ }

  const blockedAgents = counts.get("blocked") ?? 0;

  // Live per-agent state for non-terminal specialists: their latest signal
  // summary from the log tail (bounded read), so progress never needs a card.
  const live: string[] = [];
  if (agents.length > 0) {
    const tail = await runtime.log.read(0, 25);
    const lastByAgent = new Map<string, MaestroEvent>();
    for (const e of tail) {
      if (e.from !== ORCHESTRATOR_ID && !isCommandType(e.type)) lastByAgent.set(e.from, e);
    }
    for (const a of agents) {
      if (a.status !== "running" && a.status !== "blocked" && a.status !== "interrupted") continue;
      const last = lastByAgent.get(a.id);
      const summary = last ? `: ${last.payload.summary.slice(0, 60)}` : "";
      live.push(`${a.id}:${a.status}${summary}`);
    }
  }

  const bits: string[] = [`phase: ${phase}`];
  if (agents.length > 0) bits.push(`specialists: ${statusBits.join(", ") || "0 active"}`);
  if (total > 0) {
    bits.push(`tickets: ${done}/${total} done${waiting > 0 ? ` · ${waiting} waiting` : ""}`);
  }
  if (waiting > 0 || blockedAgents > 0) bits.push(`blocked: ${waiting + blockedAgents}`);
  if (live.length > 0) bits.push(`live: ${live.join(" · ")}`);
  return `maestro · ${bits.join(" · ")}`;
}

export async function refreshFooter(ctx: ExtensionContext, runtime: MaestroRuntime | null): Promise<void> {
  if (!ctx.hasUI) return;
  if (!runtime) {
    ctx.ui.setStatus("maestro", undefined);
    return;
  }
  ctx.ui.setStatus("maestro", await buildFooterText(runtime));
}

// ── orchestrator wake / pending injection (§4 channel 2, §11) ───────────────

/** Content of the wake message sent to the orchestrator LLM on an action signal. */
export function wakeMessage(event: MaestroEvent): string {
  const requires = event.requires && event.requires !== "none" ? ` (requires: ${event.requires})` : "";
  const ticket = event.ticket ? ` · ticket ${event.ticket}` : "";
  return (
    `[maestro] ${event.from} sent ${event.type} (${event.eventId}${ticket}): ` +
    `"${event.payload.summary}"${requires}. Resolve it from task state, route it, or escalate — never leave it dangling.`
  );
}

const MAX_INJECT = 10; // agent groups per turn, not individual signals (roll-up)

/**
 * Build the next-turn injection for the orchestrator LLM (unconsumed signals
 * + interrupted specialists). Signals are rolled up per specialist and ordered
 * by severity (error > needs_input > finished) so the orchestrator handles
 * failures first; one line per agent keeps the injection compact.
 */
export function buildPendingContent(attention: MaestroEvent[], interrupted: RegistryAgent[]): string {
  const lines: string[] = [];
  const SEVERITY = { error: 0, needs_input: 1, finished: 2 } as const;

  const groups = new Map<string, MaestroEvent[]>();
  for (const e of attention) {
    const arr = groups.get(e.from) ?? [];
    arr.push(e);
    groups.set(e.from, arr);
  }
  const ordered = [...groups.entries()].sort((a, b) => {
    const sa = SEVERITY[a[1][0]!.type as keyof typeof SEVERITY] ?? 3;
    const sb = SEVERITY[b[1][0]!.type as keyof typeof SEVERITY] ?? 3;
    return sa - sb || a[1][0]!.sequence - b[1][0]!.sequence;
  });
  const shown = ordered.slice(0, MAX_INJECT);

  if (shown.length > 0) {
    lines.push("Unconsumed specialist signals — handle each (answer, route, or resume the specialist):");
    for (const [agent, evs] of shown) {
      const e = evs[0]!;
      const requires = e.requires && e.requires !== "none" ? ` (requires: ${e.requires})` : "";
      const ticket = e.ticket ? `, ticket ${e.ticket}` : "";
      const more = evs.length > 1 ? ` (+${evs.length - 1} more)` : "";
      lines.push(`- [${e.type}] ${agent} (${e.eventId}${ticket}): ${e.payload.summary}${requires}${more}`);
    }
    if (ordered.length > shown.length) {
      lines.push(`- …and ${ordered.length - shown.length} more specialist(s) with unconsumed signals — use maestro_history to audit.`);
    }
  }
  if (interrupted.length > 0) {
    lines.push(
      `Interrupted specialists (state persisted, not running — decide whether to resume): ` +
        interrupted.map((a) => `${a.id} (${a.role})`).join(", "),
    );
  }
  return `[maestro] ${lines.join("\n")}`;
}

/**
 * Drain the per-process attention queue into a message for the orchestrator's
 * next turn, advancing the watermark (consumption happens here when the wake
 * path isn't used: startup reconcile, non-interactive mode). Returns null when
 * there is nothing to tell the orchestrator.
 */
export async function drainPendingInjection(runtime: MaestroRuntime): Promise<{ content: string } | null> {
  const attention = runtime.attention;
  const interrupted = runtime.registry
    .listAgents()
    .filter((a) => a.status === "interrupted" && !runtime.reportedInterrupted.has(a.id));
  if (attention.length === 0 && interrupted.length === 0) return null;

  const content = buildPendingContent(attention, interrupted);

  if (attention.length > 0) {
    const maxSeq = attention[attention.length - 1]!.sequence;
    const watermark = runtime.consumers.getCursor(ORCHESTRATOR_ID);
    if (maxSeq > watermark) {
      runtime.consumers.setCursor(ORCHESTRATOR_ID, maxSeq);
      await runtime.consumers.persist(runtime.store);
    }
    runtime.attention = [];
  }
  for (const agent of interrupted) runtime.reportedInterrupted.add(agent.id);
  return { content };
}

// ── persona arming (§14: pi skills are progressive disclosure — the model may
//    not load the maestro skill on its own, so the core rules are injected via
//    before_agent_start, not only via SKILL.md) ──────────────────────────────

/**
 * Inject the shipped persona directly because skills are progressive disclosure;
 * append only the task's effective policies and fresh-store onboarding.
 */
export async function buildPersonaArming(runtime: MaestroRuntime): Promise<string> {
  const config = runtime.config;
  const skill = await readFile(join(MAESTRO_SKILL_DIR, "SKILL.md"), "utf8").catch(() => "");
  const persona = skill.replace(/^---[\s\S]*?---\s*(?:[\r\n]+)?/, "").trim();
  const lines = [
    "[maestro] You are the orchestrator:",
    persona,
    "",
    "Effective policies (config.json in the task store — the human may edit; behavior follows these):",
    `- maxConcurrentSpecialists: ${config.maxConcurrentSpecialists}`,
    `- autoResume: ${config.autoResume}`,
    `- reviewRequired: ${config.reviewRequired.length > 0 ? config.reviewRequired.join(", ") : "(none)"}`,
    `- approvalRules: ${config.approvalRules.length > 0 ? config.approvalRules.join(", ") : "(none)"}`,
    `- spawnThreshold: ${config.spawnThreshold}`,
  ];
  if (runtime.registry.listAgents().length === 0) {
    lines.push(
      "",
      "The task store is new. Greet the human as their orchestrator (\"I'm your orchestrator. Tell me the goal and I'll break it into tickets — then we'll decide which ones need an agent.\"), then propose a ticket breakdown and wait for approval before spawning.",
    );
  }
  return lines.join("\n");
}

/**
 * The per-turn orchestrator context: the persona (once per process — the model
 * may not load the skill on its own, §14) + the pending-signal injection.
 * Returns null when there is nothing to inject.
 */
export async function buildOrchestratorContext(
  runtime: MaestroRuntime,
  personaArmed: boolean,
): Promise<{ content: string; personaArmed: boolean } | null> {
  const parts: string[] = [];
  let armed = personaArmed;
  if (!personaArmed) {
    parts.push(await buildPersonaArming(runtime));
    armed = true;
  }
  const pending = await drainPendingInjection(runtime);
  if (pending) parts.push(pending.content);
  if (parts.length === 0) return null;
  return { content: parts.join("\n\n"), personaArmed: armed };
}

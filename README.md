# pi Maestro — Orchestrator Extension

**Version 1.0**

Maestro turns pi into a small team of AI agents.

You keep talking to **one** assistant — the *orchestrator*, your normal pi
session. It plans the work, delegates to specialist agents, answers their
questions, and only bothers you when a decision is genuinely yours.

Each specialist is its own pi session with its own transcript, model, and
files. They report back with short, structured messages — *working*, *need an
answer*, *done*, *failed* — never free-form chatter. Everything is recorded to
disk, so the whole team survives restarts: kill pi mid-task, come back, resume
where it left off.

Same machine only. No cloud, no accounts, no servers.

## What it looks like

```
You ── chat ──> Orchestrator (the main pi session)
                    │  spawns / manages / routes
        ┌──────────┬┴─────────────┬──────────┐
      builder-1    reviewer-1    docs-1   ...   (specialists, own sessions)
```

You say "build this feature". The orchestrator breaks it into tickets, spawns
a builder and a reviewer, routes their questions back and forth, and keeps
you informed. You stay in one conversation the whole time.

## Why you'd use it

- **One conversation, many agents.** You manage a team, not helper processes —
  the orchestrator holds the plan, you hold the steering wheel.
- **Specialists remember.** Each keeps *field notes* (what it learned) and
  *artifacts* (what it produced) between tickets. A specialist stays the
  expert in its area across the whole task.
- **It survives crashes.** An append-only event log with per-consumer
  watermarks means no lost or duplicated work — verified with real SIGKILL
  tests, not just in theory.
- **You're only interrupted when it matters.** Routine progress goes to a
  status line, not your chat. Only genuinely human decisions wake you.
- **Everything is inspectable.** The log, registry, artifacts, and notes are
  plain files — `cat events.jsonl` tells you exactly what happened.

### Good to know

- **Sequential by default** — one specialist working at a time (a strict
  guard; no hard cap above that).
- A specialist's `scope` is advisory — it declares files it owns, but nothing
  enforces it.
- Tickets are lines in `state.md` maintained by the orchestrator; there is no
  separate ticket tool.
- Free-tier model providers can be flaky — a child may occasionally skip a
  detail. That's model behavior, not an extension bug.

## Install

1. Install the package:

   ```sh
   pi install npm:pi-maestro
   ```

   OR

   ```sh
   pi install git:github.com/tfagundess/pi-maestro
   ```

2. Restart pi — or type `/reload` to load it without restarting.

3. Check it works: run `/maestro init <task-name>` (use any name, e.g.
   `my-project`). You should see the footer say `maestro · phase: kickoff`.

## Try it in 5 minutes

1. **Create a task:**

   ```
   /maestro init my-project
   ```

2. **Define a role** — tell the orchestrator what a specialist is for. Type:

   > Define a role `builder` with blueprint: implement the requested change,
   > write a summary to `artifacts/result.md`, then signal finished.

   (You choose the role name — it becomes the specialist's id prefix.)

3. **Spawn a specialist:**

   > Spawn `builder-1` to add a line to `result.md` in the current task.

   A child session starts. Watch the footer: `specialists: 1 running`.
   Progress stays in the status line — it never floods your chat.

4. **When it finishes**, look at what it did:

   ```sh
   cat .pi/maestro/my-project/events.jsonl          # the whole exchange
   cat .pi/maestro/my-project/artifacts/result.md   # its output
   cat .pi/maestro/my-project/field-notes/builder-1.md # what it learned
   ```

## Day to day

### Commands

| Command | What it does |
|---|---|
| `/maestro init <name>` | Create a task store here (no name → defaults to `task`) |
| `/maestro status` | Current phase, specialists, tickets, blocked work |
| `/maestro stop <agentId>` | Pause a specialist (it can be resumed later) |

### What the orchestrator can do

The orchestrator LLM has these tools (you can mention them in your prompts):

| Tool | Purpose |
|---|---|
| `maestro_spawn` | Start a specialist (role, task, model, scope — plus an optional `name`) |
| `maestro_define_role` | Save a reusable role definition |
| `maestro_reply` / `maestro_send` | Answer a specialist's question / send it an instruction |
| `maestro_await` | Wait for a specialist's next signal |
| `maestro_stop` / `maestro_resume` | Pause and restart a specialist |
| `maestro_status` | What's happening right now |
| `maestro_history` / `maestro_read_transcript` / `maestro_read_field_notes` / `maestro_read_artifact` | Audit anything: event log, transcripts, notes, artifacts |
| `maestro_init` | Create/resume the task store |

### What a specialist can do

Exactly one thing: **`maestro_signal`** — one of:

- `progress` — a status update (footer only, never wakes you)
- `needs_input` — *"I can't continue without an answer"* (to you, or to the
  orchestrator)
- `finished` — work done, references its artifacts
- `error` — failed, says what it tried

A specialist cannot spawn others, cannot touch `state.md` or tickets, and
never talks to you directly.

### Questions and escalation

When a specialist signals `needs_input` with `requires: human`, the
orchestrator asks you — e.g. *"a specialist can't proceed until it picks a
port — can I tell it to use 3001?"* Answer normally; the orchestrator routes
your reply back to the specialist. Everything else it resolves itself from
task state first.

### After a crash

Kill pi mid-task, restart in the same directory, and continue. Specialists
are marked `interrupted`, their pending questions come back, and
`maestro_resume` picks them up exactly where they stopped — no lost or
duplicated work.

### Names and roles

A specialist's id is its role with a number by default: role `auditor` →
`auditor-1`, then `auditor-2`. Want a named specialist instead? Pass a `name`
at spawn and the id becomes exactly that name, with the role kept separate:

```
maestro_spawn(role: "qa", name: "charles", task: "…")
```

…spawns **charles**, a QA specialist — its own field notes, transcript, and
status, with `role: qa` recorded alongside. Omit `name` and it's `<role>-N`
as before.

### Settings (`config.json` in the task store)

Written on first init, with defaults:

```json
{
  "maxConcurrentSpecialists": 1,
  "autoResume": false,
  "reviewRequired": [],
  "approvalRules": ["delete", "api_change", "wide_diff"]
}
```

- `maxConcurrentSpecialists: 1` — sequential mode (strict guard).
- `autoResume` — resume interrupted specialists automatically on restart
  (default `false` — you decide).
- `reviewRequired` / `approvalRules` — hints for when the orchestrator should
  add a review step or ask you for approval.

## Where everything lives

```
.pi/maestro/<task-name>/
├── state.md            # the orchestrator's dashboard: goal, phase, tickets, decisions
├── agents.json         # who the specialists are and their status
├── events.jsonl        # append-only log of every signal and command
├── consumer.json       # read-watermarks (what's been seen / consumed)
├── config.json         # the settings above
├── tickets/            # ticket files (orchestrator-owned)
├── artifacts/          # what specialists produced
├── field-notes/        # what specialists learned
├── blueprints/         # reusable role definitions
└── sessions/           # specialist transcripts
```

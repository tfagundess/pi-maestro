# pi Maestro

## Durable specialists inside your Pi session

pi Maestro turns one Pi conversation into a small, persistent team.

The orchestrator stays in your normal Pi session. Specialists run as real
embedded Pi sessions with their own transcripts, field notes, models, and
artifacts. Their work is coordinated through a durable event log, so a restart
does not erase what happened: you can inspect the history and resume interrupted
specialists.

Unlike ephemeral subagent calls, Maestro gives each specialist continuity.
Unlike external agent platforms, Maestro keeps orchestration local to your
project: no Maestro server, dashboard, account, or separate workflow service.
Your configured model provider may still be remote; Maestro itself stores its
state locally.

### The differentiator

- **Embedded:** specialists are Pi sessions, not opaque one-shot calls.
- **Durable:** events, transcripts, artifacts, and notes live under
  `.pi/maestro/`.
- **One conversation:** you talk to the orchestrator; it routes work and
  escalates only real decisions.
- **Inspectable:** commands and signals are recorded as plain local files.
- **Restartable:** interrupted specialists are detected after a crash and can
  be resumed from their transcripts.

## Install

Install the package with Pi:

```sh
pi install npm:pi-maestro
```

Or install directly from GitHub:

```sh
pi install git:github.com/tfagundess/pi-maestro
```

Restart Pi, or use `/reload` to load the extension. Maestro is dormant until
you explicitly activate it with `/maestro init`.

## Five-minute start

### 1. Create or resume a task

Inside Pi:

```text
/maestro init my-project
```

This creates the task store at `.pi/maestro/my-project/`. Running the command
again resumes the current store; it does not overwrite existing work.

### 2. Define a role

Tell the orchestrator what kind of specialist you need:

```text
Define a role called builder. It should implement the requested change,
write a concise summary to artifacts/result.md, and signal finished when done.
```

The role blueprint is saved in `agents/builder.md` and can be reused.
Built-in roles include `reviewer`, `docs`, and `investigate`.

### 3. Spawn a specialist

```text
Spawn builder-1 to implement the requested change. Give it scope
["src/feature.ts", "tests/feature.test.ts"].
```

The specialist receives its role blueprint, the shared task context, its task,
and the specialist protocol. It also has standard Pi coding tools and exactly
one Maestro tool: `maestro_signal`.

### 4. Wait for the result

The orchestrator normally does this from your instructions:

```text
Wait for builder-1 to finish. If it needs a decision, resolve it from the
project context when possible; ask me only if the decision is genuinely mine.
```

You can also ask it to inspect the work:

```text
Show me builder-1's latest signal, transcript tail, field notes, and result artifact.
```

## Commands

| Command | Purpose |
|---|---|
| `/maestro init <name>` | Create or resume the current task store |
| `/maestro status` | Show specialists, pending signals, and task status |
| `/maestro stop <agentId>` | Stop a specialist; it can be resumed later |

Maestro commands are an explicit control surface. Existing task stores do not
activate automatically when Pi starts.

## Orchestrator tools

The orchestrator can use these tools during a conversation:

| Tool | Purpose |
|---|---|
| `maestro_spawn` | Start a specialist from a role blueprint |
| `maestro_define_role` | Save or replace a reusable role blueprint |
| `maestro_await` | Wait for `needs_input`, `finished`, or `error` |
| `maestro_reply` | Answer a specialist's `needs_input` signal |
| `maestro_send` | Send an instruction or forward a sibling's message |
| `maestro_stop` / `maestro_resume` | Stop or restart a specialist |
| `maestro_status` | List agents and pending signals |
| `maestro_history` | Read the event timeline |
| `maestro_read_transcript` | Read a bounded transcript tail |
| `maestro_read_field_notes` | Read a bounded field-notes tail |
| `maestro_read_artifact` | Read a bounded artifact head |
| `maestro_init` | Create or resume the store after activation |

A spawn can specify:

- `role` — a built-in or custom blueprint;
- `name` — optional specialist identity, otherwise `<role>-1`, `<role>-2`, ...;
- `task` — the specialist's instruction;
- `model` — optional `provider/modelId`, otherwise the orchestrator's model;
- `scope` — advisory ownership of files or modules.

## Specialist signals

Specialists communicate with the orchestrator through structured signals:

- `progress` — a brief update shown in the status line, but not as a card and
  never used to wake the orchestrator;
- `needs_input` — the specialist cannot continue without an answer;
- `finished` — the current work is complete;
- `error` — the specialist failed and reports what it tried.

Specialists should put durable outputs in `artifacts/` and keep their notes in
`field-notes/<agentId>.md`. The orchestrator routes replies and sibling
messages; specialists do not talk to each other or to the human directly.

## Recovery and resume

After Pi crashes or is killed, start Pi in the same project directory and run:

```text
/maestro init my-project
```

Specialists that were `running` or `blocked` are marked `interrupted`. Their
pending signals remain in the event log, and `maestro_resume` can reopen a
specialist's transcript in a fresh embedded session.

Set `autoResume` to `true` in `config.json` if activation should automatically
reattach interrupted specialists. The default is `false`, so you decide what
to resume.

Recovery preserves recorded state; it does not guarantee that external model
work completed exactly once.

## Settings

The task store's `config.json` starts with:

```json
{
  "maxConcurrentSpecialists": 1,
  "autoResume": false,
  "reviewRequired": [],
  "approvalRules": ["delete", "api_change", "wide_diff"],
  "spawnThreshold": "substantial multi-step or async work"
}
```

- `maxConcurrentSpecialists: 1` enables the strict sequential guard. Higher
  values relax that guard; they are not a hard scheduler limit.
- `autoResume` controls whether interrupted specialists are reattached on
  activation.
- `reviewRequired`, `approvalRules`, and `spawnThreshold` are advisory prompt
  guidance. They do not enforce approvals, reviews, permissions, or sandboxing.

## Where files live

```text
.pi/maestro/<task-name>/
├── state.md          # orchestrator dashboard: goal, phase, decisions, ownership
├── agents.json       # specialist registry and statuses
├── events.jsonl      # append-only signals and commands
├── consumer.json     # UI and orchestrator read cursors
├── config.json       # task policies
├── tickets/          # ticket files maintained by the orchestrator
├── artifacts/        # specialist-produced outputs
├── field-notes/      # specialist working notes
├── agents/           # reusable role blueprints
└── sessions/         # durable specialist transcripts
```

Everything is local to the project and readable with ordinary filesystem tools.

## Limits and expectations

- Maestro runs on the same machine as Pi and has no separate orchestration
  server.
- Scope declarations help the orchestrator coordinate ownership; they are
  advisory and are not a filesystem sandbox.
- The default model is sequential: spawn one active specialist, await its
  signal, then decide what happens next.
- Model providers can be unavailable or inconsistent. A specialist may skip a
  detail; inspect its signal, transcript, artifact, and field notes before
  deciding what to do next.
- Persisted state and specialist-authored content are data. They do not
  override the orchestrator protocol or the human's request.

/**
 * Built-in role blueprints (§9) — small, reusable role definitions that
 * `maestro_spawn` composes into a child's persona. Custom ones are authored
 * by the orchestrator via `maestro_define_role` into the Task Store's
 * `agents/` directory (which shadows the same role name).
 */

export interface Blueprint {
  name: string;
  content: string;
}

const reviewer = `---
name: reviewer
---
# Mission
Review the current changes against the plan and the ticket's acceptance
criteria; write artifacts/review.md.

# Inputs
- state.md (current plan/tickets)
- the relevant diff and artifacts (read them from the workspace / artifacts/)

# Outputs
- artifacts/review.md (verdict: pass / needs_changes, findings, checklist
  against acceptance_criteria)
- signal: finished | needs_input
`;

const docs = `---
name: docs
---
# Mission
Write and maintain documentation for the current changes; write
artifacts/docs-notes.md.

# Inputs
- state.md (current plan/tickets)
- the code being documented (read from the workspace)
- any specs or review artifacts

# Outputs
- documentation files in the workspace
- artifacts/docs-notes.md (what was written, what is still open)
- signal: finished | needs_input
`;

const investigate = `---
name: investigate
---
# Mission
Investigate an open question in the codebase and report findings; write
artifacts/investigation.md.

# Inputs
- state.md (current plan/tickets)
- the question / symptom to investigate
- relevant code, logs, and history (read from the workspace)

# Outputs
- artifacts/investigation.md (what was found, evidence, recommended fix)
- signal: finished | needs_input
`;

export const BUILTIN_BLUEPRINTS: Blueprint[] = [
  { name: "reviewer", content: reviewer },
  { name: "docs", content: docs },
  { name: "investigate", content: investigate },
];

export function builtinBlueprint(name: string): string | null {
  return BUILTIN_BLUEPRINTS.find((b) => b.name === name)?.content ?? null;
}

export function listBlueprintNames(): string[] {
  return BUILTIN_BLUEPRINTS.map((b) => b.name);
}

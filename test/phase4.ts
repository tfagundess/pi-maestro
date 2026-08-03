/**
 * Phase 4 test harness — unit checks for personas & policies (orchestrator
 * persona arming, config.json policy loading + autoResume, skill content,
 * custom-role flow, ownership accumulation).
 *
 * Temporary; registered as `/test-phase4` ONLY while imported by index.ts.
 * Removed from index.ts after verification. Writes results to
 * <cwd>/test-results.json. Isolated stores under <cwd>/phase4-unit/; no real
 * LLM, no real child — fake child sessions capture resume delivery.
 */
import type { ExtensionAPI, AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { TaskStore, readBlueprint } from "../src/task-store.ts";
import { buildRuntime, clearRuntime, setRuntime } from "../src/runtime.ts";
import { buildOrchestratorTools } from "../src/tools.ts";
import { autoResumeInterrupted } from "../src/control.ts";
import { buildOrchestratorContext, buildPersonaArming } from "../src/ui.ts";
import {
  MAESTRO_SKILL_DIR,
  MAESTRO_CHILD_SKILL_DIR,
  createChildSession,
  type ChildSessionHandle,
} from "../src/child-session.ts";
import { DEFAULT_CONFIG, ORCHESTRATOR_ID, type MaestroEvent } from "../src/types.ts";

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

function makeFakeFactory(agentId: string) {
  const starts: string[] = [];
  const factory = async (opts: { sessionFile?: string; agentId?: string }): Promise<ChildSessionHandle> => {
    const session = {
      get isStreaming() {
        return false;
      },
      prompt: async () => {},
      steer: async () => {},
      abort: async () => {},
      dispose: () => {},
    } as unknown as AgentSession;
    return {
      agentId: opts.agentId ?? agentId,
      session,
      sessionFile: opts.sessionFile ?? `/tmp/${agentId}.jsonl`,
      start: (p: string) => {
        starts.push(p);
      },
      dispose: () => {},
    } as ChildSessionHandle;
  };
  return { factory, starts };
}

export function registerPhase4Unit(pi: ExtensionAPI): void {
  pi.registerCommand("test-phase4", {
    description: "Phase 4 unit checks: persona arming, config policies, autoResume, skills, custom roles",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const { results, check } = makeResults();
      try {
        const base = join(cwd, "phase4-unit");
        await rm(base, { recursive: true, force: true });
        await mkdir(base, { recursive: true });

        // ── config.json policy loading (§8) ───────────────────────────────
        check(
          "config: defaults match the skill rules",
          DEFAULT_CONFIG.maxConcurrentSpecialists === 1 &&
            DEFAULT_CONFIG.autoResume === false &&
            DEFAULT_CONFIG.approvalRules.includes("delete") &&
            DEFAULT_CONFIG.approvalRules.includes("api_change") &&
            DEFAULT_CONFIG.approvalRules.includes("wide_diff") &&
            DEFAULT_CONFIG.spawnThreshold.length > 0,
          JSON.stringify(DEFAULT_CONFIG).slice(0, 120),
        );

        const dirA = join(base, "a");
        await mkdir(dirA, { recursive: true });
        const storeA = await TaskStore.init(dirA, "policies");
        const defaults = await storeA.loadConfig();
        check("config: seeded config.json equals defaults", defaults.maxConcurrentSpecialists === 1 && defaults.autoResume === false && defaults.approvalRules.length === 3);
        await writeFile(storeA.configPath, JSON.stringify({ ...DEFAULT_CONFIG, autoResume: true, spawnThreshold: "CUSTOM LINE: spawn nothing yourself" }, null, 2) + "\n", "utf8");
        const edited = await storeA.loadConfig();
        check("config: file edits merge over defaults", edited.autoResume === true && edited.spawnThreshold.startsWith("CUSTOM LINE"));
        const runtimeA = await buildRuntime(storeA);

        // ── persona arming (§14) ──────────────────────────────────────────
        const arming = await buildPersonaArming(runtimeA);
        check("arming: core rules present", arming.includes("You are the orchestrator") && arming.includes("spawn, maestro_await") && arming.includes("maestro_send"));
        check("arming: effective policies injected (observable behavior)", arming.includes("autoResume: true") && arming.includes("spawnThreshold: CUSTOM LINE"));
        check("arming: onboarding nudge on a fresh store", arming.includes("Tell me the goal and I'll break it into tickets"));

        const ctx0 = await buildOrchestratorContext(runtimeA, false);
        check("context: persona injected when not armed", ctx0?.content.includes("You are the orchestrator") === true && ctx0.personaArmed === true);
        const ctx1 = await buildOrchestratorContext(runtimeA, true);
        check("context: nothing to inject once armed + nothing pending", ctx1 === null);

        // pending signals still get injected (phase-2 behavior preserved).
        const attentionEvent = await runtimeA.log.append({
          from: "impl-1", to: ORCHESTRATOR_ID, type: "needs_input",
          payload: { summary: "need a port" }, requires: "orchestrator",
        });
        runtimeA.attention.push(attentionEvent);
        const ctx2 = await buildOrchestratorContext(runtimeA, true);
        check("context: pending signal injected after arming", ctx2?.content.includes("need a port") === true);
        check("context: watermark advanced on drain", (await runtimeA.consumers.getCursor(ORCHESTRATOR_ID)) >= attentionEvent.sequence);

        // Editing config.json changes the injected text → observable behavior.
        await writeFile(storeA.configPath, JSON.stringify({ ...DEFAULT_CONFIG, autoResume: false, spawnThreshold: "Do everything yourself." }, null, 2) + "\n", "utf8");
        const runtimeB = await buildRuntime(storeA);
        const arming2 = await buildPersonaArming(runtimeB);
        check("policy: editing config.json changes the armed persona", arming2.includes("Do everything yourself.") && !arming2.includes("CUSTOM LINE"));

        // ── autoResume policy (§8) ────────────────────────────────────────
        // Two interrupted agents; autoResume=false → nothing happens.
        for (const id of ["impl-1", "review-1"]) {
          runtimeB.registry.addAgent({
            id, role: id.split("-")[0]!, model: "inherit", status: "interrupted",
            sessionFile: `/tmp/${id}.jsonl`, scope: [], parent: "orchestrator",
            spawnedAt: new Date().toISOString(),
          });
        }
        await runtimeB.registry.persist(storeA);
        const resumedFalse = await autoResumeInterrupted(runtimeB, {
          cwd: dirA,
          resolveModel: () => undefined,
          signalToolFor: (agentId) => ({ name: "maestro_signal" }) as unknown as ToolDefinition,
        });
        check("autoResume: false (default) leaves interrupted agents for the orchestrator", resumedFalse.length === 0 && runtimeB.registry.getAgent("impl-1")?.status === "interrupted");

        // autoResume=true → re-attaches each from its transcript (fresh session).
        runtimeB.config.autoResume = true;
        const f1 = makeFakeFactory("impl-1");
        const f2 = makeFakeFactory("review-1");
        const resumed = await autoResumeInterrupted(runtimeB, {
          cwd: dirA,
          resolveModel: () => undefined,
          signalToolFor: (agentId) => ({ name: "maestro_signal" }) as unknown as ToolDefinition,
          createSession: ((opts: { agentId?: string }) =>
            opts.agentId === "review-1" ? f2.factory(opts) : f1.factory(opts)) as unknown as typeof createChildSession,
        });
        check("autoResume: true re-attaches both interrupted specialists", resumed.length === 2 && resumed.includes("impl-1") && resumed.includes("review-1"), resumed.join(","));
        check("autoResume: registry → running", runtimeB.registry.getAgent("impl-1")?.status === "running" && runtimeB.registry.getAgent("review-1")?.status === "running");
        check("autoResume: resume command recorded per agent", (await runtimeB.log.read(0)).filter((e) => e.type === "resume").length === 2);
        check("autoResume: fresh sessions from transcripts", f1.starts.length === 1 && f1.starts[0]?.includes("continue from your transcript"));
        check("autoResume: children live in runtime.children", runtimeB.children.has("impl-1") && runtimeB.children.has("review-1"));

        // a failed auto-resume leaves the agent interrupted (surfaced later).
        runtimeB.registry.setStatus("impl-1", "interrupted");
        await runtimeB.registry.persist(storeA);
        runtimeB.children.delete("impl-1");
        const failing = makeFakeFactory("impl-1");
        const resumed2 = await autoResumeInterrupted(runtimeB, {
          cwd: dirA,
          resolveModel: () => undefined,
          signalToolFor: (agentId) => ({ name: "maestro_signal" }) as unknown as ToolDefinition,
          createSession: (async () => {
            throw new Error("session factory exploded");
          }) as never,
        });
        check("autoResume: failure leaves the agent interrupted (orchestrator handles it)", resumed2.length === 0 && runtimeB.registry.getAgent("impl-1")?.status === "interrupted");

        // ── skills (§8 persona/protocol content) ──────────────────────────
        const maestroSkill = await readFile(join(MAESTRO_SKILL_DIR, "SKILL.md"), "utf8");
        check(
          "skill: maestro has the escalation chain (§7)",
          maestroSkill.includes("escalation chain") && maestroSkill.includes("maestro_reply") && maestroSkill.includes("forward") && maestroSkill.includes("human"),
        );
        check("skill: maestro has the 6 spawn-discipline rules", ["Do it yourself", "Reuse before respawn", "Spawn only when", "Scope ownership", "Cap concurrency", "Prefer long-lived"].every((r) => maestroSkill.includes(r)));
        check("skill: maestro has onboarding + review flow", maestroSkill.includes("Onboarding") && maestroSkill.includes("reviewer") && maestroSkill.includes("approval"));
        const childSkill = await readFile(join(MAESTRO_CHILD_SKILL_DIR, "SKILL.md"), "utf8");
        check(
          "skill: maestro-child has the 4 signal types",
          ["progress", "needs_input", "finished", "error"].every((t) => childSkill.includes(t)),
        );
        check("skill: maestro-child requires human before irreversible choices", childSkill.includes("requires: human") && childSkill.includes("irreversible"));
        check("skill: maestro-child honors single-writer ownership", childSkill.includes("orchestrator-owned") && childSkill.includes("state.md"));

        // ── custom specialist flow (§6, §9) ───────────────────────────────
        setRuntime(runtimeB);
        const tools = buildOrchestratorTools();
        const toolDefine = tools[1]!; // maestro_define_role
        const dr = await toolDefine.execute("d1", {
          name: "lint",
          blueprint: "# Mission\nLint the codebase.\n\n# Inputs\n- the code\n\n# Outputs\n- artifacts/lint.md\n- signal: finished",
        }, undefined, undefined, { cwd: dirA } as never);
        check("define_role: blueprint saved to agents/", (dr.details as { path: string }).path.endsWith("agents/lint.md"));
        const custom = await readBlueprint(storeA, "lint");
        check("define_role: spawn resolves the custom blueprint", custom?.includes("Lint the codebase") === true);
        // A custom blueprint shadows a built-in of the same name.
        const dr2 = await toolDefine.execute("d2", { name: "reviewer", blueprint: "# Mission\nCUSTOM reviewer.\n\n# Inputs\n- x\n\n# Outputs\n- y" }, undefined, undefined, { cwd: dirA } as never);
        const shadowed = await readBlueprint(storeA, "reviewer");
        check("define_role: custom blueprint shadows the built-in", shadowed?.includes("CUSTOM reviewer") === true && !shadowed?.includes("Review the current changes"));
        const toolSpawn = tools[2]!; // maestro_spawn
        const unknownErr = await toolSpawn.execute("s1", { role: "no-such-role", task: "x" }, undefined, undefined, { cwd: dirA } as never).then(() => null).catch((e: Error) => e.message);
        check("spawn: unknown role rejected (tells the orchestrator the built-ins)", typeof unknownErr === "string" && unknownErr.includes("Unknown role") && unknownErr.includes("reviewer"));

        // ── state.md ownership accumulation (bug fix) ─────────────────────
        await storeA.recordOwnership("impl-1", "impl", ["src/a/"]);
        await storeA.recordOwnership("review-1", "reviewer", ["src/b/"]);
        const state = await readFile(storeA.statePath, "utf8");
        const ownershipSection = state.split("## Ownership")[1] ?? "";
        check(
          "state.md: ownership accumulates (one line per specialist)",
          ownershipSection.includes("impl-1") && ownershipSection.includes("review-1"),
          ownershipSection.split("\n").filter((l) => l.startsWith("- ")).join(" | "),
        );
        await storeA.recordOwnership("impl-1", "impl", ["src/a/"]);
        const state2 = await readFile(storeA.statePath, "utf8");
        const lines2 = state2.split("## Ownership")[1]!.split("\n").filter((l) => l.startsWith("- "));
        check("state.md: ownership is idempotent per specialist", lines2.filter((l) => l.includes("impl-1")).length === 1, lines2.join(" | "));

        clearRuntime();
        const failed = results.filter((r) => !r.ok);
        await writeResults(cwd, "test-results.json", results);
        console.error(`PHASE 4 UNIT: ${results.length - failed.length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`PHASE 4 UNIT CRASHED: ${message}`);
        await writeResults(cwd, "test-results.json", results, message);
      }
    },
  });
}

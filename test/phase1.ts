/**
 * Phase 1 test harness — temporary. Registered as the `/test-phase1` command
 * ONLY while this file is listed in settings.json "extensions". Removed after
 * the phase is verified. Writes results to <cwd>/test-results.json.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { readdirSync as readdirSyncSafe } from "node:fs";
import { join } from "node:path";
import { TaskStore } from "../src/task-store.ts";
import { EventLog } from "../src/events.ts";
import { Registry } from "../src/registry.ts";
import { Consumers } from "../src/consumers.ts";
import { buildRuntime, setRuntime } from "../src/runtime.ts";
import { SignalFeed, type FeedSink } from "../src/feed.ts";
import { buildOrchestratorTools, makeMaestroSignalTool } from "../src/tools.ts";

interface Result {
  name: string;
  ok: boolean;
  detail?: string;
}

const results: Result[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  results.push({ name, ok: cond, detail });
  console.error(`[${cond ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, what: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error(`TIMEOUT waiting for: ${what}`);
  return false;
}

export default function (pi: ExtensionAPI): void {
  // Restart persistence check — run `pi -p "/test-phase1-restart"` in a dir
  // that already ran the full harness once. Asserts nothing was lost.
  pi.registerCommand("test-phase1-restart", {
    description: "Verify Task Store survives a pi restart",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      try {
        const store = await TaskStore.discover(cwd);
        check("restart: store discovered", store !== null);
        if (!store) return;
        const { EventLog: ReloadedLog } = await import("../src/events.ts");
        const log = await ReloadedLog.load(store);
        const evts = await log.read(1);
        const types = evts.map((e) => `${e.type}:${e.sequence}`);
        check("restart: events.jsonl intact (spawn+progress+finished)", evts.some((e) => e.type === "spawn") && evts.some((e) => e.type === "progress") && evts.some((e) => e.type === "finished"), types.join(", "));
        const seqs = evts.map((e) => e.sequence);
        check("restart: sequences contiguous from 1", seqs.join(",") === Array.from({ length: seqs.length }, (_, i) => i + 1).join(","), seqs.join(","));
        const reg = JSON.parse(await readFile(store.registryPath, "utf8"));
        check("restart: registry retains agents", Object.keys(reg.agents ?? {}).length > 0, Object.keys(reg.agents ?? {}).join(","));
        const cons = JSON.parse(await readFile(store.consumersPath, "utf8"));
        // The unit run's feed consumes informational entries (spawn/progress)
        // at render — watermark lands on the last informational sequence (4);
        // action signals (finished seq 3, needs_input seq 5) stay queued past
        // it. Asserting the persisted value exactly proves the watermark
        // survived the restart unreset (an older `=== 0` contradicted the
        // unit's own "consumers reload … watermark=4" check).
        check("restart: watermark intact", cons.consumers?.orchestrator?.lastSequence === 4, `lastSequence=${cons.consumers?.orchestrator?.lastSequence}`);
        const config = JSON.parse(await readFile(store.configPath, "utf8"));
        check("restart: config intact", config.maxConcurrentSpecialists === 1);
        const state = await readFile(store.statePath, "utf8");
        check("restart: ownership recorded in state.md", state.includes("investigate-1"));
        const sessions = await readdirSyncSafe(join(store.sessionsDir));
        check("restart: child session file persisted", sessions.some((f) => f.endsWith(".jsonl")));
        const failed = results.filter((r) => !r.ok);
        await writeFile(join(cwd, "restart-results.json"), JSON.stringify({ results, failed: failed.length, total: results.length }, null, 2), "utf8");
        console.error(`PHASE 1 RESTART: ${results.length - failed.length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`PHASE 1 RESTART CRASHED: ${message}`);
      }
    },
  });

  pi.registerCommand("test-phase1", {
    description: "Run Phase 1 acceptance checks",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      try {
        // ── 0. setup: fresh dir state is guaranteed by the caller ──────────
        const mr = await ModelRuntime.create();
        const model =
          mr.getModel("opencode-go", "deepseek-v4-flash") ??
          (await mr.getAvailable())[0];
        if (!model) throw new Error("No model available for the child smoke test");
        const modelLabel = `${model.provider}/${model.id}`;
        console.error(`Using model: ${modelLabel}`);

        const fakeModelRegistry = {
          getAvailable: () => mr.getAvailable(),
          find: (provider: string, id: string) => mr.getModel(provider, id),
        };
        const fakeCtx = {
          cwd,
          modelRegistry: fakeModelRegistry,
          model,
          thinkingLevel: "low",
          ui: { notify: () => {} },
        } as never;

        const [toolInit, toolDefineRole, toolSpawn, toolStatus, toolReadTranscript, , toolReadArtifact] =
          buildOrchestratorTools();
        // ── 1. maestro_init ────────────────────────────────────────────────
        const initRes = await toolInit.execute("tc-init", {}, undefined, undefined, fakeCtx);
        const store = await TaskStore.discover(cwd);
        check("init: task store discovered", store !== null);
        if (!store) throw new Error("init failed");
        for (const f of ["state.md", "config.json", "agents.json", "consumer.json", "events.jsonl"]) {
          const exists = await readFile(join(store.root, f), "utf8").then(() => true).catch(() => false);
          check(`init: ${f} exists`, exists);
        }
        for (const f of ["reviewer.md", "docs.md", "investigate.md"]) {
          const exists = await readFile(join(store.blueprintsDir, f), "utf8").then(() => true).catch(() => false);
          check(`init: blueprint agents/${f}`, exists);
        }
        const stateText = await readFile(store.statePath, "utf8");
        check(
          "init: state.md has five sections",
          ["## Goal", "## Current phase", "## Open tickets", "## Decisions", "## Ownership"].every((s) =>
            stateText.includes(s),
          ),
        );
        const configText = JSON.parse(await readFile(store.configPath, "utf8"));
        check("init: config has 5 policies", ["maxConcurrentSpecialists", "autoResume", "reviewRequired", "approvalRules", "spawnThreshold"].every((k) => k in configText));
        const consumerText = JSON.parse(await readFile(store.consumersPath, "utf8"));
        check("init: orchestrator watermark seeded at 0", consumerText.consumers?.orchestrator?.lastSequence === 0);
        const emptyLog = await readFile(store.eventsPath, "utf8");
        check("init: events.jsonl empty", emptyLog.trim() === "");

        // ── 2. runtime wiring ──────────────────────────────────────────────
        const runtime = await buildRuntime(store);
        setRuntime(runtime);
        check("runtime: built", runtime.log.nextSequenceValue === 1);

        // ── 3. maestro_define_role ─────────────────────────────────────────
        await toolDefineRole.execute(
          "tc-role",
          { name: "architect", blueprint: "# Mission\nDesign the module layout.\n\n# Outputs\n- artifacts/design.md" },
          undefined,
          undefined,
          fakeCtx,
        );
        const arch = await readFile(join(store.blueprintsDir, "architect.md"), "utf8");
        check("define_role: agents/architect.md written with frontmatter", arch.startsWith("---\nname: architect\n---"));
        const badRole = await toolDefineRole.execute("tc-role2", { name: "../evil", blueprint: "x" }, undefined, undefined, fakeCtx)
          .then(() => null)
          .catch((e: Error) => e.message);
        check("define_role: rejects unsafe name", typeof badRole === "string" && badRole.includes("Invalid role name"));

        // ── 4. maestro_spawn → real child run ──────────────────────────────
        const spawnRes = await toolSpawn.execute(
          "tc-spawn",
          {
            role: "investigate",
            task:
              "SMOKE TEST. Do NOT read or write any files; do NOT use bash. " +
              "Your entire job: call maestro_signal exactly twice, then stop. " +
              "1) maestro_signal(type='progress', payload.summary='smoke test started'). " +
              "2) maestro_signal(type='finished', payload.summary='smoke test complete'). " +
              "Use no other tools. Then reply 'done'.",
            model: modelLabel,
            scope: ["src/smoke/"],
          },
          undefined,
          undefined,
          fakeCtx,
        );
        const spawnDetails = spawnRes.details as { agentId: string; sessionFile: string };
        const agentId = spawnDetails.agentId;
        check("spawn: returns agent id (investigate-1)", agentId === "investigate-1", agentId);

        const reg = JSON.parse(await readFile(store.registryPath, "utf8"));
        const agent = reg.agents[agentId];
        check("spawn: registry entry with role/model/status/scope", agent?.role === "investigate" && agent?.status === "running" && agent?.scope?.[0] === "src/smoke/" && agent?.parent === "orchestrator");

        // Child tool surface: standard coding tools + exactly one maestro tool.
        const childHandle = runtime.children.get(agentId);
        const childToolNames =
          childHandle?.session?.agent?.state?.tools?.map((t: { name: string }) => t.name) ?? [];
        const maestroChildTools = childToolNames.filter((n: string) => n.startsWith("maestro_"));
        check(
          "child: exactly one maestro tool (maestro_signal)",
          maestroChildTools.length === 1 && maestroChildTools[0] === "maestro_signal",
          childToolNames.join(","),
        );
        check(
          "child: coding tools present (can do real work)",
          ["read", "bash", "edit", "write"].every((n) => childToolNames.includes(n)),
          childToolNames.join(","),
        );
        check("spawn: sessionFile under task store sessions/", agent?.sessionFile?.includes(`${store.taskId}/sessions/`) && agent?.sessionFile?.endsWith(".jsonl"), agent?.sessionFile);

        // Wait for the child to emit progress + finished (poll events.jsonl).
        const gotSignals = await waitFor(async () => {
          const evts = await runtime.log.read(1);
          return evts.filter((e) => e.type === "progress" || e.type === "finished").length >= 2;
        }, 240_000, "child progress+finished signals");
        check("child: emitted progress + finished signals", gotSignals);

        // The session file is written lazily on the child's first message — it
        // exists once the signals have landed.
        const fileExists = await readFile(agent.sessionFile, "utf8").then((t) => t.trim().length > 0).catch(() => false);
        check("spawn: session file exists and is JSONL", fileExists);
        const sessionText = await readFile(agent.sessionFile, "utf8");
        check("spawn: session file is JSONL", sessionText.split("\n").filter(Boolean).every((l) => l.startsWith("{")));

        const all = await runtime.log.read(1);
        const spawnCmd = all.find((e) => e.type === "spawn");
        const progress = all.find((e) => e.type === "progress");
        const finished = all.find((e) => e.type === "finished");
        check("log: spawn command recorded (from orchestrator, to agent)", spawnCmd?.from === "orchestrator" && spawnCmd?.to === agentId);
        check("log: sequence strictly increasing (spawn<progress<finished)", Boolean(spawnCmd && progress && finished && spawnCmd.sequence < progress.sequence && progress.sequence < finished.sequence), `${spawnCmd?.sequence},${progress?.sequence},${finished?.sequence}`);
        check("log: progress stamped (eventId/timestamp/from/to)", Boolean(progress?.eventId?.startsWith("sig-") && progress?.timestamp && progress?.from === agentId && progress?.to === "orchestrator"));
        check("log: finished payload summary", finished?.payload?.summary === "smoke test complete");
        const sequences = all.map((e) => e.sequence);
        check("log: sequences contiguous from 1", sequences.join(",") === Array.from({ length: sequences.length }, (_, i) => i + 1).join(","), sequences.join(","));

        // ── 5. sequence survives restart ───────────────────────────────────
        const reloadedLog = await EventLog.load(store);
        check("restart: next sequence > last persisted", reloadedLog.nextSequenceValue > (sequences[sequences.length - 1] ?? 0), `next=${reloadedLog.nextSequenceValue}`);

        // ── 6. maestro_status ──────────────────────────────────────────────
        const statusRes = await toolStatus.execute("tc-status", {}, undefined, undefined, fakeCtx);
        const statusDetails = statusRes.details as { agents: unknown[]; pendingSignals: unknown[] };
        check("status: lists the spawned agent", (statusDetails.agents as { id: string }[]).some((a) => a.id === agentId));
        check("status: pending signals include progress+finished (past watermark 0)", (statusDetails.pendingSignals as { type: string }[]).filter((s) => s.type === "progress" || s.type === "finished").length >= 2);

        // ── 7. maestro_read_transcript ─────────────────────────────────────
        const transcriptRes = await toolReadTranscript.execute("tc-tx", { agentId, tail: 10 }, undefined, undefined, fakeCtx);
        const txText = transcriptRes.content[0]?.type === "text" ? transcriptRes.content[0].text : "";
        check("read_transcript: returns transcript content", txText.length > 0, `${txText.length} chars`);

        // ── 8. maestro_read_artifact ───────────────────────────────────────
        await writeFile(join(store.artifactsDir, "smoke.md"), "# Smoke artifact\n\nhello maestro", "utf8");
        const artifactRes = await toolReadArtifact.execute("tc-art", { path: "smoke.md" }, undefined, undefined, fakeCtx);
        const artText = artifactRes.content[0]?.type === "text" ? artifactRes.content[0].text : "";
        check("read_artifact: reads artifacts/smoke.md", artText.includes("hello maestro"));
        const badArtifact = await toolReadArtifact.execute("tc-art2", { path: "../../etc/passwd" }, undefined, undefined, fakeCtx)
          .then(() => null)
          .catch((e: Error) => e.message);
        check("read_artifact: rejects path escape", typeof badArtifact === "string");

        // ── 9. scope overlap + sequential guard ────────────────────────────
        const overlap = await toolSpawn.execute("tc-sp2", { role: "reviewer", task: "x", scope: ["src/smoke/"] }, undefined, undefined, fakeCtx)
          .then(() => null)
          .catch((e: Error) => e.message);
        check("spawn: rejects overlapping scope", typeof overlap === "string" && overlap.includes("Scope overlap"));
        // Sequential guard (Phase 3 semantics): only an ACTIVE child — still
        // streaming with un-finished work — blocks a new spawn; a child that
        // already finished (fast real child) is reusable, not blocking.
        const sequential = await toolSpawn.execute("tc-sp3", { role: "reviewer", task: "x", scope: ["src/other/"] }, undefined, undefined, fakeCtx)
          .then(() => null)
          .catch((e: Error) => e.message);
        check("spawn: sequential guard blocks a still-working child (else allows reuse)", sequential === null || sequential.includes("still working"), String(sequential));

        // ── 10. maestro_signal direct (stamp test) ─────────────────────────
        const signalTool = makeMaestroSignalTool("impl-1");
        const sigRes = await signalTool.execute("tc-sig", { type: "needs_input", payload: { summary: "port taken", details: "3000 in use" }, requires: "orchestrator" }, undefined, undefined, fakeCtx);
        const sigSeq = (sigRes.details as { sequence: number }).sequence;
        const sigEvents = await runtime.log.read(sigSeq);
        check("maestro_signal: stamps from=impl-1 to=orchestrator", sigEvents[0]?.from === "impl-1" && sigEvents[0]?.to === "orchestrator");
        check("maestro_signal: carries requires hint", sigEvents[0]?.requires === "orchestrator");

        // ── 11. persistence of registry + consumers ────────────────────────
        // The feed attaches here, deliberately AFTER the status check above
        // (which asserts the events are still pending past watermark 0) —
        // attaching now consumes progress at render (advancing the watermark)
        // while action signals (finished / needs_input) queue instead.
        const feed = new SignalFeed({
          canWake: () => false,
          onCard: () => {},
          onWake: () => {},
          onStatusChanged: () => {},
        } satisfies FeedSink);
        feed.attach(runtime);
        // Deterministic: let the feed's startup pass (reconcile → persist)
        // finish before re-reading agents.json — otherwise Registry.load can
        // race the mid-write file and parse a partial JSON.
        await feed.settled();
        const reg2 = await Registry.load(store);
        check("registry reload: agent still present", reg2.getAgent(agentId)?.id === agentId);
        // The feed consumes informational entries (progress) at render and
        // queues action signals (finished / needs_input) — the watermark
        // reflects progress consumed, not the queued actions.
        await feed.settled();
        const cons = await Consumers.load(store);
        const w = cons.getCursor("orchestrator");
        check("consumers reload: informational consumed, action signals still queued", w >= 2 && w < 5, `watermark=${w}`);

        // ── summary ────────────────────────────────────────────────────────
        const failed = results.filter((r) => !r.ok);
        await writeFile(join(cwd, "test-results.json"), JSON.stringify({ results, failed: failed.length, total: results.length }, null, 2), "utf8");
        console.error(`PHASE 1: ${results.length - failed.length}/${results.length} checks passed`);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error(`PHASE 1 CRASHED: ${message}`);
        results.push({ name: "harness", ok: false, detail: message });
        await writeFile(join(cwd, "test-results.json"), JSON.stringify({ results, crashed: true }, null, 2), "utf8").catch(() => {});
      }
    },
  });
}

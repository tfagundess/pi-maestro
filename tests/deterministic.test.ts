import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extension = join(root, "index.ts");
let temp: string;

before(async () => {
  temp = await mkdtemp(join(tmpdir(), "pi-maestro-deterministic-"));
});

after(async () => {
  await rm(temp, { recursive: true, force: true });
});

function runPi(cwd: string, prompt: string, extensionPath = extension): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pi",
      [
        "--no-session",
        "--no-skills",
        "--no-context-files",
        "--no-builtin-tools",
        "--mode",
        "json",
        "--extension",
        extensionPath,
        "--print",
        prompt,
      ],
      { cwd, env: { ...process.env, PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`pi exited ${code ?? signal}\n${stdout}\n${stderr}`));
    });
  });
}

test("maestro init creates one deterministic task store without model work", async () => {
  const cwd = join(temp, "init");
  await mkdir(cwd, { recursive: true });
  const output = await runPi(cwd, "/maestro init deterministic");
  const store = join(cwd, ".pi", "maestro", "deterministic");

  assert.equal(existsSync(join(cwd, ".pi", "maestro", "current.txt")), true);
  assert.equal(existsSync(join(store, "state.md")), true);
  assert.equal(existsSync(join(store, "config.json")), true);
  assert.equal(existsSync(join(store, "consumer.json")), true);
  assert.equal(existsSync(join(store, "events.jsonl")), true);
  assert.equal(existsSync(join(store, "agents", "reviewer.md")), true);
  assert.deepEqual(JSON.parse(await readFile(join(store, "consumer.json"), "utf8")).consumers, {
    orchestrator: { lastSequence: 0 },
    "orchestrator-ui": { lastSequence: 0 },
  });
  assert.deepEqual(JSON.parse(await readFile(join(store, "agents.json"), "utf8")).agents, {});
  assert.deepEqual((await readdir(join(store, "agents"))).sort(), ["docs.md", "investigate.md", "reviewer.md"]);
  assert.match(output, /"type":"session"/);
});

test("maestro init resumes the current store instead of creating a second one", async () => {
  const cwd = join(temp, "init");
  const output = await runPi(cwd, "/maestro init another-name");
  const maestroRoot = join(cwd, ".pi", "maestro");

  assert.equal(await readFile(join(maestroRoot, "current.txt"), "utf8"), "deterministic\n");
  assert.deepEqual((await readdir(maestroRoot)).filter((name) => !name.startsWith(".")), ["current.txt", "deterministic"]);
  assert.match(output, /"type":"session"/);
});

test("extension stays dormant before explicit Maestro activation", async () => {
  const cwd = join(temp, "dormant");
  await mkdir(cwd, { recursive: true });
  await runPi(cwd, "/maestro status");
  assert.equal(existsSync(join(cwd, ".pi", "maestro")), false);
});

test("activation reconciles persisted live agents after a restart", async () => {
  const cwd = join(temp, "restart");
  await mkdir(cwd, { recursive: true });
  await runPi(cwd, "/maestro init restart");
  const registryPath = join(cwd, ".pi", "maestro", "restart", "agents.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  registry.agents["qa-1"] = {
    id: "qa-1",
    role: "qa",
    model: "test",
    status: "running",
    sessionFile: join(cwd, "qa-session.jsonl"),
    scope: ["tests"],
    parent: "orchestrator",
    spawnedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
  await runPi(cwd, "/maestro init restart");
  assert.equal(JSON.parse(await readFile(registryPath, "utf8")).agents["qa-1"].status, "interrupted");
});

test("failed auto-resume leaves an interrupted specialist recoverable", async () => {
  const cwd = join(temp, "auto-resume-failure");
  await mkdir(cwd, { recursive: true });
  await runPi(cwd, "/maestro init auto-fail");
  const store = join(cwd, ".pi", "maestro", "auto-fail");
  const configPath = join(store, "config.json");
  const registryPath = join(store, "agents.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.autoResume = true;
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  registry.agents["reviewer-1"] = {
    id: "reviewer-1",
    role: "reviewer",
    model: "not-a-real-model",
    status: "interrupted",
    sessionFile: store,
    scope: ["src"],
    parent: "orchestrator",
    spawnedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
  await runPi(cwd, "/maestro init auto-fail");
  assert.equal(JSON.parse(await readFile(registryPath, "utf8")).agents["reviewer-1"].status, "interrupted");
});

test("corrupt persisted config and registry fall back without crashing", async () => {
  const cwd = join(temp, "corrupt-state");
  await mkdir(cwd, { recursive: true });
  await runPi(cwd, "/maestro init corrupt");
  const store = join(cwd, ".pi", "maestro", "corrupt");
  await writeFile(join(store, "config.json"), "{not-json\n", "utf8");
  await writeFile(join(store, "agents.json"), "{not-json\n", "utf8");
  await runPi(cwd, "/maestro init corrupt");
  await runPi(cwd, "/maestro status");
  const maestroRoot = join(cwd, ".pi", "maestro");
  await writeFile(join(maestroRoot, "current.txt"), "../escape\n", "utf8");
  await runPi(cwd, "/maestro status");
  await mkdir(join(cwd, "outside-store"), { recursive: true });
  await symlink(join(cwd, "outside-store"), join(maestroRoot, "linked"));
  await writeFile(join(maestroRoot, "current.txt"), "linked\n", "utf8");
  await runPi(cwd, "/maestro status");
  assert.equal(existsSync(join(store, "config.json")), true);
  assert.equal(existsSync(join(store, "agents.json")), true);
});

test("registered Maestro tools perform an orchestrator workflow", async () => {
  const cwd = join(temp, "tools");
  await mkdir(cwd, { recursive: true });
  const helper = join(cwd, "tool-workflow.mjs");
  await writeFile(
    helper,
    `import { join } from "node:path";
import { readFile, symlink, writeFile } from "node:fs/promises";
import maestro from ${JSON.stringify(extension)};
import { buildOrchestratorTools, makeMaestroSignalTool } from ${JSON.stringify(join(root, "src", "tools.ts"))};
import { EventLog } from ${JSON.stringify(join(root, "src", "events.ts"))};
import { ensureRuntime, getRuntime } from ${JSON.stringify(join(root, "src", "runtime.ts"))};
import { SignalFeed } from ${JSON.stringify(join(root, "src", "feed.ts"))};
import { buildOrchestratorContext, registerMaestroCards } from ${JSON.stringify(join(root, "src", "ui.ts"))};

export default function (pi) {
  maestro(pi);
  pi.on("session_shutdown", async () => {
    await writeFile(join(process.cwd(), "shutdown.txt"), getRuntime() === null ? "cleared" : "leaked", "utf8");
  });
  pi.registerCommand("maestro-test", {
    handler: async (_args, ctx) => {
      const tools = Object.fromEntries(buildOrchestratorTools().map((tool) => [tool.name, tool]));
      const call = (name, params) => tools[name].execute("test-" + name, params, undefined, () => {}, ctx);
      const init = await call("maestro_init", { task: "workflow" });
      await call("maestro_define_role", { name: "qa", blueprint: "# Mission\\nExercise the test workflow." });
      const runtime = await ensureRuntime(ctx.cwd);
      const concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) => runtime.log.append({
        from: "qa-1",
        to: "orchestrator",
        type: "progress",
        payload: { summary: "concurrent-" + i },
      })));
      const rawBeforeMalformed = await readFile(runtime.store.eventsPath, "utf8");
      await writeFile(runtime.store.eventsPath, rawBeforeMalformed + "{malformed\\n", "utf8");
      const recoveredLog = await EventLog.load(runtime.store);
      const recovered = await recoveredLog.append({
        from: "qa-1",
        to: "orchestrator",
        type: "progress",
        payload: { summary: "recovered" },
      });
      const recoveredEvents = await recoveredLog.read(0);
      runtime.registry.addAgent({
        id: "qa-1",
        role: "qa",
        model: "test",
        status: "idle",
        sessionFile: join(ctx.cwd, "qa-session.jsonl"),
        scope: ["tests"],
        parent: "orchestrator",
        spawnedAt: new Date().toISOString(),
      });
      await runtime.registry.persist(runtime.store);
      await writeFile(join(runtime.store.artifactsDir, "qa.md"), "QA artifact\\n", "utf8");
      await writeFile(join(ctx.cwd, "outside.md"), "outside\\n", "utf8");
      await symlink(join(ctx.cwd, "outside.md"), join(runtime.store.artifactsDir, "outside-link.md"));
      const invalidRole = await call("maestro_define_role", { name: "bad/name", blueprint: "invalid" })
        .then(() => "no error", (error) => error.message);
      const scopeOverlap = await call("maestro_spawn", { role: "qa", task: "blocked", scope: ["tests"] })
        .then(() => "no error", (error) => error.message);
      const badArtifact = await call("maestro_read_artifact", { path: "../state.md" })
        .then(() => "no error", (error) => error.message);
      const badWindowsArtifact = await call("maestro_read_artifact", { path: "..\\\\state.md" })
        .then(() => "no error", (error) => error.message);
      const symlinkArtifact = await call("maestro_read_artifact", { path: "outside-link.md" })
        .then(() => "no error", (error) => error.message);
      let renderer;
      registerMaestroCards({ registerEntryRenderer: (_name, render) => { renderer = render; } });
      const renderedCard = renderer(
        { data: { type: "needs_input", from: "qa-1", summary: "Need approval", details: "Details", sequence: 1 } },
        { expanded: true },
        { bg: (_name, text) => text, fg: (_name, text) => text },
      );
      const renderedFrame = renderedCard.render(80).join("\\n");
      const feedSeen = { cards: [], wakes: [], statuses: 0 };
      const feed = new SignalFeed({
        canWake: () => false,
        onCard: (event) => feedSeen.cards.push(event.type),
        onWake: (event) => feedSeen.wakes.push(event.type),
        onStatusChanged: () => { feedSeen.statuses += 1; },
      });
      feed.attach(runtime);
      await feed.settled();
      const signal = makeMaestroSignalTool("qa-1");
      const progress = await signal.execute("test-progress", {
        type: "progress",
        payload: { summary: "Started" },
      }, undefined, () => {}, ctx);
      const needsInput = await signal.execute("test-signal", {
        type: "needs_input",
        payload: { summary: "Need approval", details: "The workflow is ready." },
        artifact: "qa.md",
        requires: "orchestrator",
      }, undefined, () => {}, ctx);
      await feed.settled();
      const awaited = await call("maestro_await", { agentId: "qa-1", timeout: 1 });
      const reply = await call("maestro_reply", {
        agentId: "qa-1",
        replyTo: needsInput.details.eventId,
        message: "Approved; continue.",
      });
      const send = await call("maestro_send", {
        agentId: "qa-1",
        message: "Run the next check.",
        forward: true,
        ticket: "T-1",
      });
      const artifact = await call("maestro_read_artifact", { path: "qa.md" });
      runtime.children.set("qa-1", {
        agentId: "qa-1",
        sessionFile: join(ctx.cwd, "qa-session.jsonl"),
        session: { isStreaming: false, prompt: async () => { throw new Error("child crashed"); } },
        dispose: () => {},
      });
      const failedSend = await call("maestro_send", { agentId: "qa-1", message: "This delivery fails." });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const errorSignal = await signal.execute("test-error", {
        type: "error",
        payload: { summary: "A controlled failure" },
      }, undefined, () => {}, ctx);
      await feed.settled();
      const contextAfterError = await buildOrchestratorContext(runtime, false);
      const stop = await call("maestro_stop", { agentId: "qa-1", ticket: "T-1" });
      const ignored = await signal.execute("test-signal-stopped", {
        type: "finished",
        payload: { summary: "Late result" },
      }, undefined, () => {}, ctx);
      const status = await call("maestro_status", {});
      const history = await call("maestro_history", { agentId: "qa-1", tail: 20 });
      feed.detach();
      const results = { init, progress, needsInput, awaited, reply, send, artifact, failedSend, errorSignal, stop, ignored, status, history, feed: feedSeen, contextAfterError, invalidRole, scopeOverlap, badArtifact, badWindowsArtifact, symlinkArtifact, concurrent, recovered, recoveredEvents, renderedCard: Boolean(renderedCard), renderedFrame };
      await writeFile(join(ctx.cwd, "tool-results.json"), JSON.stringify(results, null, 2));
    },
  });
}
`,
    "utf8",
  );

  await runPi(cwd, "/maestro-test", helper);
  const store = join(cwd, ".pi", "maestro", "workflow");
  const results = JSON.parse(await readFile(join(cwd, "tool-results.json"), "utf8"));
  assert.match(results.init.content[0].text, /Task store created: workflow/);
  assert.equal(new Set(results.concurrent.map((event) => event.sequence)).size, 8);
  assert.equal(results.recoveredEvents.some((event) => event.payload.summary === "recovered"), true);
  assert.equal(results.renderedCard, true);
  assert.match(results.renderedFrame, /Need approval/);
  assert.match(results.renderedFrame, /Details/);
  assert.match(results.invalidRole, /Invalid role name/);
  assert.match(results.scopeOverlap, /Scope overlap/);
  assert.match(results.badArtifact, /escapes the artifacts dir/);
  assert.match(results.badWindowsArtifact, /escapes the artifacts dir/);
  assert.match(results.symlinkArtifact, /escapes its directory/);
  assert.match(results.progress.content[0].text, /Signal recorded/);
  assert.match(results.needsInput.content[0].text, /Signal recorded/);
  assert.equal(results.awaited.details.status, "signal");
  assert.match(results.contextAfterError.content, /You are the orchestrator/);
  assert.match(results.contextAfterError.content, /Unconsumed specialist signals/);
  assert.match(results.contextAfterError.content, /error/);
  assert.equal(results.feed.cards.includes("progress"), false);
  assert.equal(results.feed.cards[0], "needs_input");
  assert.equal(results.feed.cards.includes("reply"), true);
  assert.equal(results.feed.cards.includes("forward"), true);
  assert.equal(results.feed.cards.includes("stop"), true);
  assert.equal(results.feed.cards.includes("error"), true);
  assert.deepEqual(results.feed.wakes, []);
  assert.ok(results.feed.statuses > 0);
  assert.match(results.reply.content[0].text, /Reply command recorded/);
  assert.match(results.send.content[0].text, /forward command recorded/);
  assert.match(results.artifact.content[0].text, /QA artifact/);
  assert.equal(results.failedSend.details.delivered, true);
  assert.match(results.errorSignal.content[0].text, /Signal recorded/);
  assert.equal(results.stop.details.status, "stopped");
  assert.equal(results.ignored.details.ignored, true);
  assert.match(results.status.content[0].text, /qa-1.*stopped/s);
  assert.match(results.history.content[0].text, /\[needs_input\]/);
  assert.match(results.history.content[0].text, /\[reply\]/);
  assert.match(results.history.content[0].text, /\[forward\]/);
  assert.match(results.history.content[0].text, /\[stop\]/);
  assert.equal(existsSync(join(store, "agents", "qa.md")), true);
  assert.equal(await readFile(join(cwd, "shutdown.txt"), "utf8"), "cleared");
});

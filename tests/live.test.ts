import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extension = join(root, "index.ts");
let temp: string;

before(async () => {
  temp = await mkdtemp(join(tmpdir(), "pi-maestro-live-"));
});

after(async () => {
  await rm(temp, { recursive: true, force: true });
});

function runPi(cwd: string, args: string[], extraEnv: Record<string, string> = {}, timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
    delete env.PI_OFFLINE;
    const child = spawn("pi", ["--thinking", "off", ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), timeout);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`live pi exited ${code ?? signal}\\n${stdout}\\n${stderr}`));
    });
  });
}

test(
  "DeepSeek V4 Flash simulates an orchestrator workflow through Maestro tools",
  { skip: process.env.LIVE_TESTS !== "1" },
  async () => {
    const cwd = join(temp, "live");
    await mkdir(cwd, { recursive: true });
    const output = await runPi(cwd, [
      "--no-session",
      "--no-skills",
      "--no-context-files",
      "--no-builtin-tools",
      "--mode",
      "json",
      "--provider",
      "opencode-go",
      "--model",
      "deepseek-v4-flash",
      "--extension",
      extension,
      "--print",
      "/maestro init live-test",
      "Use the active Maestro extension and perform this end-to-end workflow with actual tools, not a description: call maestro_define_role with name qa and a short blueprint; call maestro_spawn with role qa, task 'Use the maestro_signal tool immediately. Do not edit files or explain anything. Call maestro_signal with type finished and summary live child finished.', and scope ['tests/live-child']; call maestro_await for qa-1 with timeout 60; call maestro_stop for qa-1; call maestro_resume for qa-1; call maestro_await for qa-1 with timeout 60; call maestro_read_transcript for qa-1 with tail 10; call maestro_read_field_notes for qa-1 with tail 10; call maestro_spawn with role qa, name qa-2, task 'Use the maestro_signal tool immediately. Do not edit files or explain anything. Call maestro_signal with type finished and summary second child finished.', and scope ['tests/live-child-2']; call maestro_await for qa-2 with timeout 60; then call maestro_status and maestro_history with tail 30; finally reply with exactly LIVE_OK.",
    ]);

    const store = join(cwd, ".pi", "maestro", "live-test");
    assert.equal(existsSync(join(store, "config.json")), true);
    assert.equal(output.includes('"toolName":"maestro_define_role"'), true);
    assert.equal(output.includes('"toolName":"maestro_spawn"'), true);
    assert.equal(output.includes('"toolName":"maestro_await"'), true);
    assert.equal(output.includes('"toolName":"maestro_stop"'), true);
    assert.equal(output.includes('"toolName":"maestro_resume"'), true);
    assert.equal(output.includes('"toolName":"maestro_read_transcript"'), true);
    assert.equal(output.includes('"toolName":"maestro_read_field_notes"'), true);
    assert.equal(output.includes('"toolName":"maestro_status"'), true);
    assert.equal(output.includes('"toolName":"maestro_history"'), true);
    assert.equal(output.includes("Role blueprint saved: agents/qa.md"), true);
    assert.equal(output.includes("Spawned qa-1"), true);
    assert.equal(output.includes("Resumed qa-1"), true);
    assert.equal(output.includes("Spawned qa-2"), true);
    assert.equal(output.includes("LIVE_OK"), true);
    assert.equal(existsSync(join(store, "agents", "qa.md")), true);

    const config = JSON.parse(await readFile(join(store, "config.json"), "utf8"));
    const registry = JSON.parse(await readFile(join(store, "agents.json"), "utf8"));
    const events = (await readFile(join(store, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(config.maxConcurrentSpecialists, 1);
    assert.equal(["idle", "running"].includes(registry.agents["qa-1"].status), true);
    assert.equal(["idle", "running"].includes(registry.agents["qa-2"].status), true);
    assert.equal(events.some((event) => event.type === "spawn" && event.to === "qa-1"), true);
    assert.equal(events.some((event) => event.type === "spawn" && event.to === "qa-2"), true);
    assert.equal(events.some((event) => event.type === "finished" && event.from === "qa-1"), true);
    assert.equal(events.some((event) => event.type === "stop" && event.to === "qa-1"), true);
    assert.equal(events.some((event) => event.type === "resume" && event.to === "qa-1"), true);
    assert.equal(events.some((event) => event.type === "finished" && event.from === "qa-1"), true);

    const configPath = join(store, "config.json");
    const registryPath = join(store, "agents.json");
    config.autoResume = true;
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    registry.agents["qa-1"].status = "interrupted";
    await writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
    await runPi(cwd, [
      "--no-session",
      "--no-skills",
      "--no-context-files",
      "--no-builtin-tools",
      "--mode",
      "json",
      "--provider",
      "opencode-go",
      "--model",
      "deepseek-v4-flash",
      "--extension",
      extension,
      "--print",
      "/maestro init live-test",
    ]);
    const afterAutoResume = (await readFile(join(store, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(afterAutoResume.filter((event) => event.type === "resume" && event.to === "qa-1").length >= 2, true);

    const rpcOutput = await runPi(
      cwd,
      [
        "--no-session",
        "--no-skills",
        "--no-context-files",
        "--no-builtin-tools",
        "--mode",
        "json",
        "--provider",
        "opencode-go",
        "--model",
        "deepseek-v4-flash",
        "--extension",
        extension,
        "--print",
        "As the child specialist, call maestro_signal exactly once with type error and summary rpc child error.",
      ],
      { MAESTRO_AGENT_ID: "qa-1" },
    );
    assert.equal(rpcOutput.includes('"toolName":"maestro_signal"'), true);
    const afterRpc = (await readFile(join(store, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(afterRpc.some((event) => event.type === "error" && event.from === "qa-1"), true);
  },
);

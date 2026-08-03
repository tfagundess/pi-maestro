import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TaskStore } from "../src/task-store.ts";
import { buildRuntime } from "../src/runtime.ts";
import { SignalFeed, type FeedSink } from "../src/feed.ts";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("probe-statuses", {
    description: "probe: does the feed call onStatusChanged?",
    handler: async (_args, ctx) => {
      const cwd = join(ctx.cwd, "probe");
      await rm(cwd, { recursive: true, force: true });
      await mkdir(cwd, { recursive: true });
      const store = await TaskStore.init(cwd, "probe");
      const runtime = await buildRuntime(store);
      let statuses = 0;
      const sink: FeedSink = {
        canWake: () => false,
        onCard: () => {},
        onWake: () => {},
        onStatusChanged: () => {
          statuses += 1;
        },
      };
      const feed = new SignalFeed(sink);
      feed.attach(runtime);
      await feed.settled();
      const afterStartup = statuses;
      await runtime.log.append({ from: "x", to: "orchestrator", type: "progress", payload: { summary: "hi" } });
      await feed.settled();
      await writeFile(join(ctx.cwd, "probe-result.txt"), `afterStartup=${afterStartup} afterAppend=${statuses}\n`, "utf8");
      console.error(`PROBE: afterStartup=${afterStartup} afterAppend=${statuses}`);
    },
  });
}

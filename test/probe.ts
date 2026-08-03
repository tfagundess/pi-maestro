/**
 * Quick probe of pi print-mode behaviors Phase 2 depends on:
 * - pi.appendEntry persists custom entries (visible in sessionManager + session file)
 * - ctx.isIdle() in a command handler
 * - ctx.hasUI / ctx.mode in print mode
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("probe", {
    description: "Probe print-mode APIs",
    handler: async (_args, ctx) => {
      const out: string[] = [];
      out.push(`mode=${ctx.mode} hasUI=${ctx.hasUI}`);
      try {
        out.push(`isIdle=${ctx.isIdle()}`);
      } catch (e) {
        out.push(`isIdle threw: ${e instanceof Error ? e.message : e}`);
      }
      pi.appendEntry("probe-entry", { n: 1, ts: Date.now() });
      const file = ctx.sessionManager.getSessionFile() ?? "(none)";
      out.push(`sessionFile=${file}`);
      try {
        const entries = ctx.sessionManager.getEntries();
        const custom = entries.filter((e) => e.type === "custom" && e.customType === "probe-entry");
        out.push(`sessionManager custom entries: ${custom.length}`);
      } catch (e) {
        out.push(`getEntries threw: ${e instanceof Error ? e.message : e}`);
      }
      try {
        const branch = ctx.sessionManager.getBranch();
        const custom = branch.filter((e) => e.type === "custom" && e.customType === "probe-entry");
        out.push(`sessionManager branch custom entries: ${custom.length}`);
      } catch (e) {
        out.push(`getBranch threw: ${e instanceof Error ? e.message : e}`);
      }
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const file2 = ctx.sessionManager.getSessionFile();
        const { readFileSync } = await import("node:fs");
        const raw = file2 ? readFileSync(file2, "utf8") : "";
        out.push(`session file mentions probe-entry: ${raw.includes("probe-entry")}`);
      } catch (e) {
        out.push(`read session file threw: ${e instanceof Error ? e.message : e}`);
      }
      const { writeFile } = await import("node:fs/promises");
      await writeFile(process.cwd() + "/probe-out.txt", out.join("\n"), "utf8");
    },
  });
}

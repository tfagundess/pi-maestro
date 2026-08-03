/**
 * TEMP loader: registers the non-factory harnesses (audit + acceptance) that
 * index.ts imported during verification. Local-only, gitignored (test/).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAuditE2E } from "./audit.ts";
import { registerAcceptance } from "./acceptance.ts";
import { registerPhase3Unit } from "./phase3.ts";
import { registerPhase4Unit } from "./phase4.ts";
import { registerPhase5Unit } from "./phase5.ts";

export default function (pi: ExtensionAPI): void {
  registerAuditE2E(pi);
  registerAcceptance(pi);
  registerPhase3Unit(pi);
  registerPhase4Unit(pi);
  registerPhase5Unit(pi);
}

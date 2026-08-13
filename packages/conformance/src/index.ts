/**
 * `@byollm/conformance` — the compatibility contract.
 *
 * A server is **byollm-compatible when this kit passes against it**. That
 * sentence is the whole versioning story: there is no framework version to
 * chase, and the tests, not a number, are what compatibility means.
 *
 * Each check drives a real daemon — the shipped runner, the shipped pairing
 * exchange, the shipped allowlist — against the target, so what gets
 * certified is the behaviour of the pair rather than either side's opinion of
 * the other. Only the model at the far end is substituted, because the kit
 * certifies the protocol and not anyone's choice of model.
 *
 * ```ts
 * import { certify, formatReport } from "@byollm/conformance";
 *
 * const report = await certify(myTarget);
 * process.stdout.write(formatReport(report));
 * process.exitCode = report.passed ? 0 : 1;
 * ```
 *
 * @packageDocumentation
 */

export { CHECKS, type Check } from "./checks.js";

export {
  certify,
  formatReport,
  miscoveredMusts,
  uncoveredMusts,
  type CertificationReport,
  type CheckResult,
} from "./certify.js";

export {
  EchoBackend,
  advance,
  ownerIdFor,
  pairDaemon,
  sleep,
  waitFor,
  type HarnessDaemon,
} from "./harness.js";

export type { ConformanceTarget } from "./target.js";

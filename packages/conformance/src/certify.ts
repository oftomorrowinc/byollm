import {
  kindsOf,
  MUSTS,
  MUST_IDS,
  mustsVerifiedBy,
  type MustId,
} from "@byollm/protocol";
import { CHECKS, type Check } from "./checks.js";
import type { ConformanceTarget } from "./target.js";

export interface CheckResult {
  readonly check: Check;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly error?: string;
}

export interface CertificationReport {
  readonly target: string;
  readonly passed: boolean;
  readonly results: readonly CheckResult[];
  /**
   * MUSTs no check asserts.
   *
   * byollm_001 requires every MUST carry a conformance test id. Reporting the
   * gap rather than hiding it is what keeps that requirement honest as the
   * protocol grows — a new MUST shows up here until someone writes its check.
   */
  readonly uncoveredMusts: readonly MustId[];
}

/**
 * Run the compatibility contract against a server.
 *
 * "A server is byollm-compatible when the kit passes" — this is the function
 * that decides it.
 */
export async function certify(
  target: ConformanceTarget,
  options: {
    only?: readonly string[];
    onProgress?: (result: CheckResult) => void;
  } = {},
): Promise<CertificationReport> {
  const only = options.only;
  const selected = only
    ? CHECKS.filter((check) => only.includes(check.id))
    : CHECKS;

  const results: CheckResult[] = [];

  for (const check of selected) {
    await target.reset();
    const started = Date.now();
    try {
      await check.run(target);
      const result: CheckResult = {
        check,
        passed: true,
        durationMs: Date.now() - started,
      };
      results.push(result);
      options.onProgress?.(result);
    } catch (error) {
      const result: CheckResult = {
        check,
        passed: false,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(result);
      options.onProgress?.(result);
    }
  }

  return {
    target: target.name,
    passed: results.every((result) => result.passed),
    results,
    uncoveredMusts: uncoveredMusts(selected),
  };
}

/**
 * `conformance`-kind MUSTs with no check asserting them.
 *
 * This counts only the MUSTs the kit is *able* to assert. It used to count
 * all of them, which made a permanent structural fact — the kit certifies a
 * server, and a third of the MUSTs are properties of a daemon — look like a
 * backlog of ten missing tests. A number that can never reach zero gets
 * ignored, and a number that is ignored is not a check.
 *
 * This one should be zero, and CI keeps it there.
 */
export function uncoveredMusts(checks: readonly Check[] = CHECKS): MustId[] {
  const covered = new Set(checks.flatMap((check) => check.musts));
  return mustsVerifiedBy("conformance").filter((id) => !covered.has(id));
}

/**
 * MUSTs a check claims but which are not verifiable by conformance.
 *
 * The opposite error, and the one that would quietly overstate what a
 * certification means: a check asserting an `operator`-kind MUST would put
 * "verified" next to something no third party can check from outside.
 */
export function miscoveredMusts(checks: readonly Check[] = CHECKS): MustId[] {
  return [...new Set(checks.flatMap((check) => check.musts))]
    .filter((id) => !kindsOf(MUSTS[id]).includes("conformance"))
    .sort();
}

const VERIFICATION_NOTE =
  "(`adversarial` = proved by the reference daemon's own suites; " +
  "`construction` = true by code shape; `operator` = a deployment claim, " +
  "verifiable only by audit or source. None is asserted by this run.)";

/** A human-readable report. */
export function formatReport(report: CertificationReport): string {
  const lines: string[] = [];
  lines.push(`byollm conformance — ${report.target}`);
  lines.push("");

  for (const result of report.results) {
    lines.push(
      `  ${result.passed ? "✓" : "✗"} ${result.check.id}  ${result.check.title}` +
        `  (${String(result.durationMs)}ms)`,
    );
    if (!result.passed && result.error !== undefined) {
      lines.push(`      ${result.error}`);
    }
  }

  const failed = report.results.filter((result) => !result.passed).length;
  lines.push("");
  lines.push(
    report.passed
      ? `  ${String(report.results.length)} checks passed — ${report.target} is byollm-compatible.`
      : `  ${String(failed)} of ${String(report.results.length)} checks failed — not compatible.`,
  );

  if (report.uncoveredMusts.length > 0) {
    lines.push("");
    lines.push("  MUSTs this kit can assert but does not yet:");
    for (const id of report.uncoveredMusts) {
      lines.push(`    - ${id}: ${MUSTS[id].statement}`);
    }
  }

  // Say what this run did *not* cover, and why — so "it passes conformance"
  // is never read as "every MUST is satisfied". A certification that hides
  // its own scope is worth less than one that states it.
  const elsewhere = MUST_IDS.filter(
    (id) => !kindsOf(MUSTS[id]).includes("conformance"),
  );
  if (elsewhere.length > 0) {
    lines.push("");
    lines.push("  Verified elsewhere, not by this kit:");
    for (const kind of ["adversarial", "construction", "operator"] as const) {
      const ids = elsewhere.filter((id) => kindsOf(MUSTS[id]).includes(kind));
      if (ids.length === 0) continue;
      lines.push(`    ${kind}: ${ids.join(", ")}`);
    }
    lines.push(`    ${VERIFICATION_NOTE}`);
  }
  return `${lines.join("\n")}\n`;
}

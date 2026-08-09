import { MUSTS, MUST_IDS, type MustId } from "@byollm/protocol";
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

/** MUSTs with no check asserting them. */
export function uncoveredMusts(checks: readonly Check[] = CHECKS): MustId[] {
  const covered = new Set(checks.flatMap((check) => check.musts));
  return MUST_IDS.filter((id) => !covered.has(id));
}

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
    lines.push("  MUSTs with no check yet (the kit is honest about its gaps):");
    for (const id of report.uncoveredMusts) {
      lines.push(`    - ${id}: ${MUSTS[id].statement}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

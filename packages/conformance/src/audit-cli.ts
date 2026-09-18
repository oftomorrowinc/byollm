#!/usr/bin/env node
import { auditDeployment, formatPostureReport } from "./deployment.js";

/**
 * `byollm-audit-deployment <url>` — what a stranger can do to a running relay.
 *
 * Distinct from `byollm-certify`, which drives a real daemon against a target
 * that may be an in-process handler. This one has a URL and nothing else,
 * which is exactly what an attacker has, and it exists because eight
 * freeze-gate findings came from a suite in which nothing was ever a stranger.
 *
 * ```bash
 * npx --package @byollm/conformance byollm-audit-deployment https://hub.byollm.cloud
 * ```
 *
 * Safe to run against production: nothing writes, nothing floods, and every
 * request is one an ordinary scanner would make.
 */
const USAGE =
  "usage: byollm-audit-deployment <url> [base-path] [origin-address]\n" +
  "  e.g. byollm-audit-deployment https://hub.byollm.cloud\n";

const argv = process.argv.slice(2);

/**
 * `--help` before the URL is read — B243, one bin over.
 *
 * It used to fall through to the audit as though `--help` were an address, so
 * the first thing a person types printed *"deployment posture — --help"* and
 * exited 1. A flag answered with a failed scan of itself is worse than one
 * that is unrecognised: it looks like the tool tried and the deployment is
 * broken.
 */
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const [url, basePath, originAddress] = argv;

if (url === undefined) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const report = await auditDeployment({
  url,
  ...(basePath === undefined ? {} : { basePath }),
  // `D008` asks the origin directly. Without it that check says so rather
  // than guessing an address and reporting a posture it never tested.
  ...(originAddress === undefined ? {} : { originAddress }),
});
process.stdout.write(`\n${formatPostureReport(report)}`);
process.exit(report.passed ? 0 : 1);

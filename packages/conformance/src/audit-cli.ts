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
 * npx byollm-audit-deployment https://hub.byollm.cloud
 * ```
 *
 * Safe to run against production: nothing writes, nothing floods, and every
 * request is one an ordinary scanner would make.
 */
const [url, basePath, originAddress] = process.argv.slice(2);

if (url === undefined) {
  process.stderr.write(
    "usage: byollm-audit-deployment <url> [base-path] [origin-address]\n" +
      "  e.g. byollm-audit-deployment https://hub.byollm.cloud\n",
  );
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

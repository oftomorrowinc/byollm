#!/usr/bin/env node
import { certify, formatReport } from "./index.js";

/**
 * `byollm-certify` — the one command byollm_003 promises.
 *
 * A third-party server points this at a module exporting a
 * {@link ConformanceTarget} as its default export:
 *
 * ```bash
 * npx byollm-certify ./my-target.js
 * ```
 */
const [targetPath] = process.argv.slice(2);

if (targetPath === undefined) {
  process.stderr.write(
    "usage: byollm-certify <path-to-module-exporting-a-ConformanceTarget>\n",
  );
  process.exit(2);
}

const module_ = (await import(targetPath)) as {
  default?: unknown;
  target?: unknown;
};
const factory = module_.default ?? module_.target;
const target =
  typeof factory === "function"
    ? ((factory as () => unknown)() as Parameters<typeof certify>[0])
    : (factory as Parameters<typeof certify>[0]);

const report = await certify(target, {
  onProgress: (result) => {
    process.stdout.write(result.passed ? "." : "x");
  },
});
process.stdout.write(`\n\n${formatReport(report)}`);
await target.close?.();
process.exit(report.passed ? 0 : 1);

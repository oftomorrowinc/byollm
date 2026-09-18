#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { certify, formatReport } from "./index.js";

/**
 * `byollm-certify` — the one command byollm_003 promises.
 *
 * A third-party server points this at a module exporting a
 * {@link ConformanceTarget} as its default export:
 *
 * ```bash
 * npm install --save-dev @byollm/conformance
 * npm install --save-dev @byollm/conformance
 * npx byollm-certify ./my-target.js
 * ```
 *
 * ## It could not load a relative path, which is the only form we publish
 *
 * B243. `await import(targetPath)` with the raw argv string resolves a bare
 * specifier **relative to the importing module** — `dist/cli.js` — not to the
 * directory the person is standing in. So the kit looked for a stranger's
 * server adapter inside our own package and said:
 *
 *     Cannot find module .../node_modules/@byollm/conformance/dist/my-target.js
 *
 * They installed our kit, typed the line off our npm page, and got a
 * missing-module error naming a path inside our package. Nothing in it says
 * the instruction was ours, so the only readings available to them are "this
 * package is broken" or "I did something wrong" — on the one artifact whose
 * whole job is to tell them whether *their* code conforms.
 *
 * ## The fix is a file URL, and `resolve()` alone is not enough
 *
 * A bare absolute path in `import()` breaks on a Windows drive letter — `C:`
 * reads as a protocol — and this kit is published for strangers on platforms
 * we do not choose. `pathToFileURL` is the form that is correct everywhere.
 */
const USAGE =
  "usage: byollm-certify <path-to-module-exporting-a-ConformanceTarget>\n";

/**
 * Node's message, with the part that is always us removed.
 *
 * `ERR_MODULE_NOT_FOUND` reads *"Cannot find module '<their path>' imported
 * from <our dist/cli.js>"* — and that trailing clause was the last thing a
 * reader saw. **The importer is always us**, because we are the one calling
 * `import()`, so naming it tells them nothing and costs the whole framing
 * above it: an error ending in a path inside `@byollm/conformance` reads as
 * our package being broken, however carefully the lines above are worded.
 *
 * Cut rather than rewritten. Node's own words about *their* file are worth
 * keeping — a syntax error in their module should say so.
 */
function nodesClause(message: string): string {
  const first = message.split("\n")[0] ?? message;
  const [said] = first.split(" imported from ");
  return said ?? first;
}

/** What arrived, in a few words a person can compare against their file. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value !== "object") return `a ${typeof value}`;
  const keys = Object.keys(value);
  return keys.length === 0
    ? "an object with no properties"
    : `an object with ${keys.slice(0, 5).join(", ")}`;
}

const argv = process.argv.slice(2);

/**
 * `--help` before anything else, because it is what somebody types first.
 *
 * The usage text already existed and was wired to exactly one of three cases:
 * no arguments printed it, and `--help` was passed to `import()` as though it
 * were a filename, producing a raw Node stack trace. A flag that answers with
 * a crash is worse than one that is unrecognised.
 */
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const [targetPath] = argv;

if (targetPath === undefined) {
  process.stderr.write(USAGE);
  process.exit(2);
}

/**
 * Loaded from where the PERSON is, with their own words in any failure.
 *
 * The catch is not decoration: an unhandled `ERR_MODULE_NOT_FOUND` prints a
 * stack trace through our `dist`, and that trace is the part that misattributes
 * the fault. What a reader needs is the path they typed, where we looked, and
 * no mention of our internals.
 */
const href = pathToFileURL(resolve(process.cwd(), targetPath)).href;

let module_: { default?: unknown; target?: unknown };
try {
  module_ = (await import(href)) as { default?: unknown; target?: unknown };
} catch (error) {
  const why = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `byollm-certify could not load ${targetPath}\n` +
      `  looked for: ${resolve(process.cwd(), targetPath)}\n` +
      `  from:       ${process.cwd()}\n\n` +
      "  The path is resolved against the directory you are in. It must be a\n" +
      "  module that exports a ConformanceTarget as its default export.\n\n" +
      `  node said: ${nodesClause(why)}\n`,
  );
  process.exit(2);
}
const factory = module_.default ?? module_.target;
const produced =
  typeof factory === "function" ? (factory as () => unknown)() : factory;

/**
 * What loaded has to BE a target, and saying so is the same repair as B243.
 *
 * The path fix got a stranger past "cannot find your file" and straight into
 * the next misattribution: a module that loads but exports the wrong shape
 * reached `certify`, which called `target.reset()` and threw a `TypeError`
 * with a stack trace through our own `dist`. Same reading as before — *this
 * package is broken* — one step along, and the whole argument of the row is
 * that a stranger has no third reading available.
 *
 * So the shape is checked here, where the words can name what they exported
 * and what was wanted. `reset` is the method `certify` reaches for first; it
 * is enough to tell a ConformanceTarget from an object.
 */
if (
  produced === null ||
  typeof produced !== "object" ||
  typeof (produced as { reset?: unknown }).reset !== "function"
) {
  process.stderr.write(
    `byollm-certify loaded ${targetPath}, and it is not a ConformanceTarget\n` +
      `  exported:  ${describe(produced)}\n` +
      "  expected:  an object with reset(), enqueue() and the rest of the\n" +
      "             ConformanceTarget interface — exported as `default`, or\n" +
      "             as a function returning one.\n",
  );
  process.exit(2);
}

const target = produced as Parameters<typeof certify>[0];

const report = await certify(target, {
  onProgress: (result) => {
    process.stdout.write(result.passed ? "." : "x");
  },
});
process.stdout.write(`\n\n${formatReport(report)}`);
await target.close?.();
process.exit(report.passed ? 0 : 1);

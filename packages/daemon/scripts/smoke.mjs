#!/usr/bin/env node
/**
 * Runs the **built binary** as a binary.
 *
 * Everything else drives `runCli` in-process, which is exactly how a bug
 * shipped once already: exporting the CLI from the library entry let the
 * bundler hoist its implementation into a shared chunk, leaving `dist/bin.js`
 * a pure re-export that produced no output at all. No unit test could see
 * that, because no unit test ran the artifact users actually execute.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const home = await mkdtemp(join(tmpdir(), "byollm-smoke-"));

let failures = 0;

function run(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { env: { ...process.env, BYOLLM_HOME: home }, timeout: 30_000 },
      (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stdout, stderr });
      },
    );
  });
}

async function check(name, args, assertion) {
  const result = await run(args);
  const ok = assertion(result);
  process.stdout.write(`  ${ok ? "✓" : "✗"} ${name}\n`);
  if (!ok) {
    failures += 1;
    process.stdout.write(
      `      exit=${result.code}\n      stdout=${JSON.stringify(result.stdout.slice(0, 200))}\n` +
        `      stderr=${JSON.stringify(result.stderr.slice(0, 200))}\n`,
    );
  }
}

process.stdout.write("\nbyollm binary smoke test\n");

try {
  // byollm_010 §5: the tuple, not a bare version. This runs the real binary
  // on every platform in CI, which is the only way to know `process.platform`
  // reports what the issue template will ask a reporter to paste.
  await check(
    "--version prints the full tuple",
    ["--version"],
    (r) =>
      /^byollm \d+\.\d+\.\d+\S* \(protocol \S+\)/.test(r.stdout.trim()) &&
      /\n\S+-\S+, node \d+\.\d+\.\d+/.test(r.stdout),
  );
  await check("--help prints usage", ["--help"], (r) =>
    r.stdout.includes("byollm connect"),
  );
  await check("status runs against an empty home", ["status"], (r) =>
    r.stdout.includes("paired apps"),
  );
  // The tombstone is a shipped surface, so the binary smoke test covers it:
  // `byollm allow` was real until 2026-08-26 and somebody's fingers still
  // know it. A refusal that did not say where membership went would be a dead
  // end wearing a helpful tone.
  await check(
    "allow points at where membership lives now",
    ["allow", "--list"],
    (r) => r.code === 2 && r.stderr.includes("team page"),
  );
  await check("log says nothing has run, rather than nothing", ["log"], (r) =>
    r.stdout.includes("nothing has run"),
  );
  await check(
    "an unknown command exits 2 with usage",
    ["frobnicate"],
    (r) => r.code === 2 && r.stderr.includes("unknown command"),
  );
} finally {
  await rm(home, { recursive: true, force: true });
}

process.stdout.write(
  failures === 0
    ? "\n  the binary works\n\n"
    : `\n  ${failures} smoke check(s) failed\n\n`,
);
process.exit(failures === 0 ? 0 : 1);

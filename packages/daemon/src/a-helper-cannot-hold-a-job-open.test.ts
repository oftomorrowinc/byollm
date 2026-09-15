import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeScratch } from "./backends/process-backend.js";
import { runProcessJob } from "./backends/process-backend.js";

/**
 * A helper the CLI spawned cannot hold a job open for ever — B200.
 *
 * Todd's two box jobs sat with **no outcome at 20+ minutes** under a 600s
 * ceiling. The hard timeout exists, so at ten minutes both should have written
 * `error (timeout)`. They wrote nothing.
 *
 * The mechanism, and every part of it is ordinary Node:
 *
 * - the promise settled only inside `child.on("close")`;
 * - **Node fires `close` when the process has exited AND every stdio stream
 *   has closed** — a pipe a grandchild inherited keeps it from ever firing;
 * - `child.kill()` signals the DIRECT child only, so a helper the CLI started
 *   never heard the SIGTERM;
 * - the SIGKILL escalation gated on a flag set in that same `close` handler,
 *   so it was deciding from the signal the failure itself prevents.
 *
 * Todd had already seen the helpers — the `tokio-rt-worker` sighting on the
 * box. The parent dies, the little one lives, the pipe stays open, the slot
 * stays held, and memory eases while the counters stay frozen. Every
 * observation fits.
 *
 * **Driven with a real grandchild**, because what is under test is when Node
 * fires which event on a process tree. A stub would assert its own schedule.
 */
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-b200-"));
});
afterEach(async () => {
  /* Left to the group kill and to the fixtures' own short lives — a rimraf
     racing a grandchild is how this suite would start failing for reasons
     nobody could reproduce. */
  await new Promise((wake) => setTimeout(wake, 50));
});

/**
 * A child that spawns a helper inheriting its stdout, then leaves.
 *
 * This is the shape an agentic CLI produces, reduced to the part that matters:
 * after the parent is gone, something still holds the pipe.
 */
async function withHelper(helperLivesMs: number): Promise<string> {
  const path = join(dir, "with-helper.mjs");
  await writeFile(
    path,
    `import { spawn } from "node:child_process";\n` +
      `process.stdout.write("parent said this\\n");\n` +
      `spawn(process.execPath, ["-e", "setTimeout(()=>{}, ${String(helperLivesMs)})"], {\n` +
      `  stdio: ["ignore", "inherit", "inherit"], detached: true,\n` +
      `}).unref();\n` +
      `setTimeout(() => process.exit(0), 50);\n`,
    "utf8",
  );
  return path;
}

const run = (command: string, timeoutMs = 20_000) =>
  runProcessJob({
    launch: { command: process.execPath, prefixArgs: [command] },
    argv: [],
    env: {},
    displayName: "the claude CLI",
    now: () => Date.now(),
    corpus: [],
    request: {
      model: "m",
      prompt: "hello",
      timeoutMs,
      maxOutputBytes: 64_000,
      signal: new AbortController().signal,
    },
    started: Date.now(),
  });

describe("a child whose helper outlives it", () => {
  it("settles instead of pending for ever", async () => {
    /**
     * The row in one case. Before this, `close` never fired — the helper held
     * stdout — so the promise never settled, no outcome was written, and the
     * slot was held until the daemon restarted.
     *
     * The helper here outlives the grace deliberately: if the fix depended on
     * the helper leaving, it would not be a fix.
     */
    const result = await run(await withHelper(30_000));

    expect(result.ok, "it ended at all").toBe(true);
  });

  it("keeps what the parent managed to say", async () => {
    /* A dead child's answer is whatever it said. Settling must not mean
       discarding the output that arrived before the pipe went quiet. */
    const result = await run(await withHelper(30_000));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain("parent said this");
  });

  it("does not take the whole timeout to notice", async () => {
    /**
     * The assertion that distinguishes the fix from the old behaviour plus
     * luck. With a 20s ceiling and a helper living 30s, the old code would
     * have waited the full ceiling and then still not settled — `close` never
     * comes. Settling within a few seconds is the new mechanism working.
     */
    const began = Date.now();
    await run(await withHelper(30_000), 20_000);

    expect(Date.now() - began).toBeLessThan(10_000);
  });
});

describe("a child with no helper at all", () => {
  it("still returns everything it wrote", async () => {
    /**
     * The control, and the reason the grace exists rather than settling on
     * `exit` outright. An ordinary job's `close` arrives microseconds after
     * `exit` carrying the last bytes; settling immediately would trade a
     * hanging slot for truncated answers, which is a worse trade on every job
     * that was working fine.
     */
    const path = join(dir, "plain.mjs");
    await writeFile(
      path,
      `process.stdout.write("a".repeat(5000));\nprocess.stdout.write("END\\n");`,
      "utf8",
    );
    const result = await run(path);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("END");
      expect(result.text.length).toBeGreaterThan(5000);
    }
  });
});

describe("clearing up after a job", () => {
  it("cannot turn a finished job into a filesystem error", async () => {
    /**
     * The scratch directory was removed by `await rm(...)` inside the
     * `finally` of the job. **A throw in a `finally` replaces the value being
     * returned**, so a job that ran perfectly would come back as an unrelated
     * filesystem error.
     *
     * Not hypothetical, and this file's own subject is why: a helper the CLI
     * spawned outlives it, and a live process holding a directory makes
     * `rmdir` fail with `EBUSY` on Windows. Measured on `windows-latest` —
     * three cases here failed on `EBUSY: resource busy or locked, rmdir
     * 'C:\Users\RUNNER~1\AppData\Local\Temp\byollm-job-...'` — which is the
     * scenario this suite exists for, failing in its clean-up rather than in
     * its subject.
     *
     * Driven with a directory that genuinely cannot be removed: a read-only
     * parent, so `rm` fails with `EACCES` on the platforms this runs on.
     * Windows has no equivalent chmod, and it is the platform where the real
     * `EBUSY` lives, so it is skipped rather than faked.
     */
    const parent = await mkdtemp(join(tmpdir(), "byollm-locked-"));
    const scratch = join(parent, "scratch");
    await mkdir(scratch);
    await writeFile(join(scratch, "held"), "x", "utf8");
    await chmod(parent, 0o500);

    try {
      /* The assertion IS that this resolves. A rejection here is the bug. */
      await expect(removeScratch(scratch)).resolves.toBeUndefined();
    } finally {
      await chmod(parent, 0o700);
      await rm(parent, { recursive: true, force: true });
    }
  });
});

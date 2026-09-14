import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runProcessJob } from "./backends/process-backend.js";
import { removeTemp } from "./test-support.js";

/**
 * Where a job's time went — B195.
 *
 * Todd, 09-14, watching the test site sit on "Still going": *"I want to know
 * how much of that is waiting on claude and gpt vs resource utilization."*
 *
 * `durationMs` could not answer it. `started` is taken on the **first line** of
 * the backend's `execute()` (`claude-cli.ts:417`, `codex-cli.ts:409`) and the
 * spawn happens inside `runProcessJob` immediately after, so spawn, the vendor
 * wait and reading the answer were one number.
 *
 * Two boundaries a parent process can actually observe are now recorded: the
 * child's `spawn` event, and the first byte on either stream.
 *
 * **Driven through a real child**, because the thing under test is when events
 * fire on a process — a stub would be asserting its own schedule.
 */
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-b195-"));
});
afterEach(async () => {
  await removeTemp(dir);
});

/** A child that speaks twice, so FIRST and LAST output are distinguishable. */
async function chatty(firstMs: number, secondMs: number): Promise<string> {
  const path = join(dir, "chatty-cli.mjs");
  await writeFile(
    path,
    `setTimeout(() => process.stdout.write("one\\n"), ${String(firstMs)});\n` +
      `setTimeout(() => process.stdout.write("two\\n"), ${String(secondMs)});`,
    "utf8",
  );
  return path;
}

/** A child that waits, then speaks — so the two boundaries cannot coincide. */
async function cli(quietMs: number): Promise<string> {
  const path = join(dir, "slow-cli.mjs");
  await writeFile(
    path,
    `setTimeout(() => { process.stdout.write("answered\\n"); }, ${String(quietMs)});`,
    "utf8",
  );
  return path;
}

/** A command that does not exist — so the spawn itself fails. */
const run = (command: string, started = Date.now()) =>
  runProcessJob({
    /* Run by this Node rather than by a shebang — Windows has no shebang, and
       `process.execPath` is absolute so the child needs no PATH. The same
       reasoning `cli-quota.test.ts` records. */
    launch: { command: process.execPath, prefixArgs: [command] },
    argv: [],
    env: {},
    displayName: "the claude CLI",
    now: () => Date.now(),
    corpus: [],
    request: {
      model: "m",
      prompt: "hello",
      timeoutMs: 20_000,
      maxOutputBytes: 64_000,
      signal: new AbortController().signal,
    },
    started,
  });

/** A binary that is not there, so `spawn` never fires. */
const runMissing = () =>
  runProcessJob({
    launch: { command: join(dir, "no-such-binary-9f3a"), prefixArgs: [] },
    argv: [],
    env: {},
    displayName: "the claude CLI",
    now: () => Date.now(),
    corpus: [],
    request: {
      model: "m",
      prompt: "hello",
      timeoutMs: 20_000,
      maxOutputBytes: 64_000,
      signal: new AbortController().signal,
    },
    started: Date.now(),
  });

const QUIET_MS = 300;

describe("the segments of a call that can be seen from outside", () => {
  it("records when the child existed and when it first spoke", async () => {
    const result = await run(await cli(QUIET_MS));

    expect(result.ok).toBe(true);
    expect(result.timing?.spawnMs, "the child existed").toBeTypeOf("number");
    expect(result.timing?.firstOutputMs, "and then it spoke").toBeTypeOf(
      "number",
    );
  });

  it("puts the quiet time between them, which is the whole point", async () => {
    /**
     * The assertion that makes the split worth having. A child that waits 300ms
     * before speaking must show that gap between `spawnMs` and
     * `firstOutputMs` — that gap is where a vendor's latency lives on a real
     * call, and where a starved box does NOT.
     *
     * Asserted as a floor with slack rather than an equality: the numbers are
     * wall-clock on a shared machine, and a test that pins them exactly is a
     * test that fails on a busy CI box for no defect.
     */
    const result = await run(await cli(QUIET_MS));
    const { spawnMs = 0, firstOutputMs = 0 } = result.timing ?? {};

    expect(firstOutputMs - spawnMs).toBeGreaterThanOrEqual(QUIET_MS * 0.5);
    expect(spawnMs, "spawning is not where the wait was").toBeLessThan(
      QUIET_MS,
    );
  });

  it("keeps both inside the total, or one of the three is wrong", async () => {
    /* The consistency check. Three numbers from two clocks that disagree would
       be worse than one number, because somebody would act on the difference. */
    const result = await run(await cli(QUIET_MS));
    const { spawnMs = 0, firstOutputMs = 0 } = result.timing ?? {};

    expect(spawnMs).toBeLessThanOrEqual(firstOutputMs);
    expect(firstOutputMs).toBeLessThanOrEqual(result.durationMs);
  });

  it("keeps the FIRST byte, not the last one", async () => {
    /**
     * The gap mutation testing found, and it was a real one.
     *
     * Every other case here drives a child that writes **once**, so first and
     * last output are the same instant: changing `firstOutputAt ??=` to `=` —
     * which turns the measurement into *time to last byte* — passed all six.
     *
     * Time to last byte is `durationMs` again, near enough, and the whole
     * point of this number is that it is not that. A child that answers at
     * 120ms and keeps streaming until 600ms spent 120ms waiting, not 600.
     */
    const result = await run(await chatty(120, 600));
    const { firstOutputMs = 0 } = result.timing ?? {};

    expect(firstOutputMs, "the first write, not the second").toBeLessThan(400);
    expect(
      result.durationMs,
      "and the child really did run on",
    ).toBeGreaterThan(450);
  });

  it("reports no spawn time when the spawn itself failed", async () => {
    /**
     * The control, and the reason these are optional rather than zero.
     *
     * A binary that does not exist produces an `error` event and no `spawn`.
     * Reporting `spawnMs: 0` there would be a measurement nobody made, and it
     * would read as *"spawning was instant"* — the opposite of what happened.
     *
     * **The first version of this case pointed `node` at a missing SCRIPT and
     * asserted the same thing.** It failed, correctly: `node` exists, so the
     * child spawns, prints its complaint to stderr and exits — both boundaries
     * are real and `spawnMs` was 2. A missing script is a child that ran; only
     * a missing COMMAND is a child that never started.
     */
    const result = await runMissing();

    expect(result.ok).toBe(false);
    expect(result.timing?.spawnMs).toBeUndefined();
    expect(result.timing?.firstOutputMs).toBeUndefined();
  });

  it("still reports a total for that failure, which it always did", async () => {
    /* Nothing about the split may take away what was already there. */
    const result = await runMissing();
    expect(result.durationMs).toBeTypeOf("number");
  });

  it("does report both for a child that started and then failed", async () => {
    /* The distinction the broken control taught: `node missing-script.mjs`
       spawns, complains on stderr and exits non-zero. That child RAN, and its
       timings are real — which is exactly what an operator needs to tell
       "could not start it" from "it started and died". */
    const result = await run(join(dir, "no-such-script.mjs"));

    expect(result.ok).toBe(false);
    expect(result.timing?.spawnMs).toBeTypeOf("number");
    expect(result.timing?.firstOutputMs, "it complained on stderr").toBeTypeOf(
      "number",
    );
  });
});

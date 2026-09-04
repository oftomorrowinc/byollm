import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runProcessJob } from "./backends/process-backend.js";
import type { Observation } from "./backends/quota.js";
import { removeTemp } from "./test-support.js";

/**
 * The Claude path carries a quota block and its clock — CW minor, 2026-09-04.
 *
 * S1 was filed against the Codex adapter: it parsed a time out of the CLI's
 * words and then dropped it, so a five-hour block released on the next pass
 * and the fast failover never engaged. The same shape sat one adapter over.
 * This path did compute `until` and spread it onto the result, and **nothing
 * ever ran that line** — a field is not carried because the code looks like
 * it carries it.
 *
 * Driven through a real child process rather than a stub, because the thing
 * under test is the seam between what a CLI prints and what the runner reads.
 */
let dir: string;

const FIXTURE: readonly Observation[] = [
  {
    pattern: /\busage limit\b/iu,
    seenOn: "fixture",
    seenAt: "2026-09-04",
    verbatim:
      "You've hit your usage limit. Try again at Sep 3rd, 2026 8:28 AM.",
  },
];

const NOW = Date.parse("2026-09-03T06:00:00");

/** A CLI that fails the way a blocked one does: non-zero, and says why. */
const BLOCKED = `process.stdout.write("You've hit your usage limit. Try again at Sep 3rd, 2026 8:28 AM.\\n");
process.exit(1);
`;

const SIGNED_OUT = `process.stdout.write("Not logged in. Please run /login\\n");
process.exit(1);
`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-cliquota-"));
});
afterEach(async () => {
  await removeTemp(dir);
});

async function cli(behaviour: string): Promise<string> {
  const path = join(dir, "fake-cli.mjs");
  await writeFile(path, behaviour, "utf8");
  return path;
}

const run = (command: string) =>
  runProcessJob({
    /* Run by this Node rather than by a shebang. Windows has no shebang, so
       spawning the script directly is `EFTYPE` there — which CI said and a
       Mac never would. `process.execPath` is absolute, so the child needs no
       PATH either, and the environment stays the empty allowlist a real job
       gets. */
    launch: { command: process.execPath, prefixArgs: [command] },
    argv: [],
    env: {},
    displayName: "the claude CLI",
    now: () => NOW,
    corpus: FIXTURE,
    request: {
      model: "m",
      prompt: "hello",
      timeoutMs: 20_000,
      maxOutputBytes: 64_000,
      signal: new AbortController().signal,
    },
    started: NOW,
  });

describe("a process-class CLI that is out of quota", () => {
  it("classifies as quota, and keeps the time it named", async () => {
    const result = await run(await cli(BLOCKED));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("quota-exhausted");
      expect(result.until).toBe(Date.parse("2026-09-03T08:28:00"));
      // The owner gets the CLI's own words, as the Codex path already did.
      expect(result.message).toContain("usage limit");
    }
  }, 30_000);

  it("still says signed-out when that is what happened", async () => {
    /* The control, and it is the one that matters: quota is checked before
       auth, so a mistake there would turn every signed-out CLI into "wait a
       while" and nobody would ever be told to log in. */
    const result = await run(await cli(SIGNED_OUT));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unauthorized");
      expect(result.until).toBeUndefined();
    }
  }, 30_000);
});

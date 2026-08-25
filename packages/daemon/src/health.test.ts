import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readHealth, writeHealth, FAILURES_BEFORE_ALARM } from "./health.js";

/**
 * The record `byollm status` reads to answer "is this device working", which
 * turned out to be a different question from "is the process alive".
 *
 * Its failure paths matter more than its happy one: this is a diagnostic, and
 * a diagnostic that can break the thing it describes is worse than none. Every
 * case below is a way the file can be unreadable, and none of them may throw.
 */

const dir = () => mkdtemp(join(tmpdir(), "byollm-health-"));

describe("recording how the upstream conversation is going", () => {
  it("round-trips what the daemon wrote", async () => {
    const path = join(await dir(), "health.json");
    await writeHealth(path, {
      at: 1_700_000_000_000,
      consecutiveFailures: 47,
      lastError: "request failed schema validation",
      origin: "https://hub.test",
    });
    const read = await readHealth(path);
    expect(read?.consecutiveFailures).toBe(47);
    expect(read?.lastError).toBe("request failed schema validation");
    expect(read?.origin).toBe("https://hub.test");
  });

  it("creates the directory it was pointed at", async () => {
    // A daemon whose `~/.byollm` does not exist yet still has a state worth
    // recording, and failing to record it would be the first thing to break
    // on a fresh machine.
    const path = join(await dir(), "nested", "deeper", "health.json");
    await writeHealth(path, { at: 1, consecutiveFailures: 3 });
    expect((await readHealth(path))?.consecutiveFailures).toBe(3);
  });

  it("does not throw when the path cannot be written", async () => {
    // A daemon that cannot write its health file still has work to do. This
    // is the rule the whole module is built around: the diagnostic never
    // stops the thing it diagnoses.
    //
    // The unwritable path is a file with a child path under it, which fails
    // on every platform for the same reason. The first version used
    // `/proc/...`, which is unwritable on macOS and something else entirely
    // on Linux — it hung there, and CI caught a test that only worked on the
    // machine it was written on. The same trap the wizard's detection fell
    // into, one layer out.
    const root = await dir();
    const blocker = join(root, "not-a-directory");
    await writeFile(blocker, "", "utf8");
    await expect(
      writeHealth(join(blocker, "health.json"), {
        at: 1,
        consecutiveFailures: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it("answers undefined for a file that was never written", async () => {
    // Not "healthy" — "this daemon has not said", which is also true of one
    // that predates the file. Callers must not collapse the two, and this is
    // where that distinction starts.
    expect(await readHealth(join(await dir(), "absent.json"))).toBeUndefined();
  });

  it.each([
    ["not JSON at all", "{ this is not json"],
    ["JSON that is not an object", '"a string"'],
    ["an object missing the count", '{"at":1}'],
    ["a count that is not a number", '{"at":1,"consecutiveFailures":"many"}'],
    ["null", "null"],
  ])("answers undefined for %s", async (_label, contents) => {
    // A half-written file is the ordinary case, not an exotic one: this is
    // written by a process that can be killed mid-write at any moment.
    const path = join(await dir(), "health.json");
    await writeFile(path, contents, "utf8");
    expect(await readHealth(path)).toBeUndefined();
  });

  it("writes something a person can read without a tool", async () => {
    // Somebody debugging a device will `cat` this before they find a command
    // for it, which is a good reason for it to be one line of plain JSON.
    const path = join(await dir(), "health.json");
    await writeHealth(path, { at: 1, consecutiveFailures: 2 });
    const raw = await readFile(path, "utf8");
    expect(raw.trim().startsWith("{")).toBe(true);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("puts the alarm threshold above a single blip", () => {
    // One refusal is a rolling deploy. The threshold is the entire difference
    // between a state and a log line, so it is worth asserting it is not 1.
    expect(FAILURES_BEFORE_ALARM).toBeGreaterThan(1);
  });
});

import { describe, expect, it } from "vitest";
import { LedgerWriter } from "./ledger.js";

/**
 * Writes to one ledger happen one at a time — CW's rolling review, 2026-09-03.
 *
 * Nothing in these files is thread-unsafe. The loss is in the awaits: each
 * `record` serialises its own snapshot and then suspends across open, write,
 * sync and rename, so two can finish out of order and the *earlier* snapshot
 * wins — taking every entry written between them with it. Twenty-five
 * concurrent records left twenty-one on disk. A brake that under-counts is
 * the unsafe direction, and it needs no corruption to get there.
 *
 * Driven through an injected sink rather than a real filesystem, and that is
 * the point rather than a convenience. The first version of this test asserted
 * the symptom against a real directory and **passed with the fix removed** —
 * the interleaving that loses entries on a laptop did not happen under the
 * runner. A race proved by timing is a race proved on the machine that
 * happened to lose.
 */
describe("a ledger writer", () => {
  it("never has two writes in flight", async () => {
    let inFlight = 0;
    let overlapped = false;
    const writer = new LedgerWriter("/ledger", async () => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });

    await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        writer.write(() => String(index)),
      ),
    );

    expect(overlapped).toBe(false);
  });

  it("lands them in the order they were asked for", async () => {
    /* The first write is made the slowest on purpose. Unserialised, it
       finishes last and its older content is what survives — which is the
       lost update, stated as an ordering. */
    const landed: string[] = [];
    const writer = new LedgerWriter("/ledger", async (_path, body) => {
      await new Promise((resolve) =>
        setTimeout(resolve, body === "first" ? 20 : 1),
      );
      landed.push(body);
    });

    await Promise.all([
      writer.write(() => "first"),
      writer.write(() => "second"),
      writer.write(() => "third"),
    ]);

    expect(landed).toEqual(["first", "second", "third"]);
  });

  it("reads the state at write time, not at call time", async () => {
    /**
     * The other half of the fix, and the half a queue alone does not give.
     *
     * Ordering the writes while each still carries the snapshot its caller
     * took would put them on disk in order and lose the entries just the
     * same: the last one to land would be missing whatever happened after its
     * caller looked. The body is a thunk, so a queued write reads current
     * state at the moment it runs.
     *
     * Driven by mutating the state from inside the first write, which is the
     * only place the two designs differ — a captured string cannot see it.
     */
    let state = "a";
    const landed: string[] = [];
    const writer = new LedgerWriter("/ledger", async (_path, body) => {
      landed.push(body);
      state += "b";
      await new Promise((resolve) => setTimeout(resolve, 1));
    });

    await Promise.all([writer.write(() => state), writer.write(() => state)]);

    expect(landed).toEqual(["a", "ab"]);
  });

  it("keeps writing after one fails", async () => {
    /* A rejected write must not poison the chain, or one bad moment stops
       every later record on this ledger. The caller still sees its own
       failure. */
    const landed: string[] = [];
    const writer = new LedgerWriter("/ledger", (_path, body) =>
      body === "bad"
        ? Promise.reject(new Error("disk said no"))
        : Promise.resolve(void landed.push(body)),
    );

    await expect(writer.write(() => "bad")).rejects.toThrow("disk said no");
    await writer.write(() => "good");

    expect(landed).toEqual(["good"]);
  });
});

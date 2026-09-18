import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@byollm/protocol";
import { createHarness, httpCapabilities } from "./testing.js";

/**
 * A site can tell a truncated answer from a whole one — B260.
 *
 * ## What was wrong, and it was wider than the report
 *
 * Kevin's team filed this as the cloud lane dropping `stop`. It was **both
 * lanes**, and the reason is a shared builder: `provenanceFor` took five
 * fields — audience, runnerId, runnerOwner, backendClass, model — and `stop`
 * was not one of them. `handlers.ts` and `cloud.ts` both call it, `JobRecord`
 * keeps only `outcome` and `provenance`, and `JobResultOk` is `.strict()`
 * with no `stop`. So the daemon sealed it, the site opened it, built
 * provenance, and **threw it away**, on every lane, for every site.
 *
 * The protocol's own words are that `stop` is *"present on every `ok` result,
 * always, because the whole value is the difference between `end`, `length`
 * and `unknown`"*. True on the wire, and the difference reached nobody.
 *
 * `length` is the one that costs: an answer cut off mid-thought, delivered
 * indistinguishable from a complete one. Kevin's case is book translation.
 *
 * ## `stopReported` travels with it, and separately matters
 *
 * `unknown` is two facts — an adapter that cannot report, and one that
 * reported a word we do not map. Carrying `stop` alone would let a site say
 * "we do not know why this stopped" about a `claude-cli` job forever, which
 * is true, and about a `content_filter` result, which is not the same thing.
 */

describe("the direct lane", () => {
  it("delivers the stop reason the device sealed", async () => {
    const h = createHarness();
    const runner = await h.pair();
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "translate chapter one" },
      owner: runner.owner,
    });
    await h.call(
      "claim",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        capabilities: httpCapabilities(),
        max: 8,
      },
      runner,
    );
    await h.call(
      "result",
      await h.resultBody({
        jobId: handle.id,
        runner,
        outcome: { outcome: "ok", text: "half a chapter" },
        stop: "length",
        stopReported: true,
      }),
      runner,
    );

    const delivered = await h.app.result(handle.id);
    expect(
      delivered?.provenance?.stop,
      "the device said the answer was cut off and the site was not told",
    ).toBe("length");
    expect(delivered?.provenance?.stopReported).toBe(true);
  });

  it("says nothing when the device sealed nothing", async () => {
    /**
     * The control, and the reason the field is optional rather than defaulted:
     * a cancelled job has no model to have stopped. Inventing `end` here would
     * be the exact lie `stopReported` exists to prevent, one field over.
     */
    const h = createHarness();
    const runner = await h.pair();
    const handle = await h.app.enqueue({
      kind: "llm.generate",
      payload: { prompt: "hi" },
      owner: runner.owner,
    });
    await h.call(
      "claim",
      {
        protocolVersion: PROTOCOL_VERSION,
        runnerId: runner.runnerId,
        capabilities: httpCapabilities(),
        max: 8,
      },
      runner,
    );
    await h.call(
      "result",
      await h.resultBody({
        jobId: handle.id,
        runner,
        outcome: { outcome: "ok", text: "done" },
      }),
      runner,
    );

    const delivered = await h.app.result(handle.id);
    expect(delivered?.provenance?.stop).toBeUndefined();
    /* And the rest of provenance still arrived, so this is an absent field
       rather than an absent object. */
    expect(delivered?.provenance?.model).toBe("test-model");
  });
});

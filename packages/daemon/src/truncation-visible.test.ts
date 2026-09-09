import { describe, expect, it } from "vitest";
import { stopReasonOf } from "./backends/index.js";
import type { BackendResult, StopReason } from "./backends/index.js";
import { stopLine, stopRemedy } from "./stop-remedy.js";

/**
 * Kevin's bug, from the surface he would have to read — B064 step 3.
 *
 * Detection shipped in .86 and `stopReasonOf` had zero production callers, so
 * the daemon knew an answer had been cut off and nothing said so. These are
 * about the saying.
 *
 * byollm_021 names the test this has to survive, and it is the reason the
 * cases below sit in pairs: **"a test that only asserts `length` is reported
 * when a model truncates will pass against an adapter that reports `length`
 * for everything."** So each case carries its own completing control, from
 * the same function, proving the two are distinguishable rather than proving
 * a constant.
 */
const ok = (stop?: StopReason): BackendResult =>
  stop === undefined
    ? { ok: true, text: "x", durationMs: 1 }
    : { ok: true, text: "x", durationMs: 1, stop };

describe("a truncated answer says so, and says what to do", () => {
  it("distinguishes a cut-off answer from a finished one", () => {
    /* The pair the spec asks for, from one function. */
    const cut = stopLine("ollama", stopReasonOf(ok("length")));
    const finished = stopLine("ollama", stopReasonOf(ok("end")));
    expect(cut).toContain("cut off");
    expect(finished, "a completed answer was reported as news").toBeUndefined();
    expect(cut).not.toBe(finished);
  });

  it("names the knob that exists, verified against a real server", () => {
    /**
     * `num_predict`, confirmed by running it rather than remembering it —
     * `/api/generate` with `options.num_predict: 8` returns
     * `done_reason: length` on the local Ollama.
     *
     * And it must be the MODEL's ceiling, not ours: `maxOutputBytes` fails
     * loudly as `output-too-large`, and the adapter never sends `max_tokens`,
     * so nothing byollm configures caps generation. Pointing an owner at our
     * config for their model's limit is the "this model is bad" outcome by
     * another route.
     */
    expect(stopRemedy("ollama", "length")).toContain("num_predict");
    expect(stopRemedy("ollama", "length")).not.toContain("config.json");
  });

  it("invents no knob for a CLI that has none", () => {
    /* byollm_021: "where a subscription CLI has no owner-side knob, say so
       plainly rather than invent one." An instruction that does nothing
       spends the owner's afternoon before it spends their patience. */
    expect(stopRemedy("claude-cli", "length")).toBeUndefined();
    expect(stopRemedy("codex-cli", "length")).toBeUndefined();
  });

  it("says when the device cannot tell, which is not the same as finished", () => {
    /**
     * The distinction B064's third mapping kind exists for, on the owner
     * surface. `claude-cli` declares `unavailable` — it structurally cannot
     * report a stop reason — so every one of its answers reads `unknown`.
     *
     * Reporting that as silence would tell an owner comparing two services
     * that both of them finished cleanly, when only one of them can say.
     */
    const dark = stopLine("claude-cli", "unknown");
    expect(dark).toContain("does not report");
    /* The control, and it is the whole point: a backend that CAN tell, and
       did, says nothing here. Without it "always warn" passes. */
    expect(stopLine("openai-http", "end")).toBeUndefined();
  });

  it("resolves an adapter that reports nothing to unknown, never to end", () => {
    /* The default that makes this a fix rather than a field. An adapter
       nobody updated must not claim completion by staying silent. */
    expect(stopReasonOf(ok())).toBe("unknown");
    expect(stopReasonOf(ok("end"))).toBe("end");
  });

  it("says nothing about a job that failed", () => {
    /* A refused or errored job has no model to have stopped, and a stop
       reason on that arm would be a fact about nothing. */
    const failed = {
      ok: false,
      code: "backend-unreachable",
      message: "no",
      durationMs: 0,
    } as BackendResult;
    expect(stopReasonOf(failed)).toBe("unknown");
  });
});

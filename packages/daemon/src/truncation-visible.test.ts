import { describe, expect, it } from "vitest";
import { stopReasonOf } from "./backends/index.js";
import type { BackendResult, StopReason } from "./backends/index.js";
import { BACKEND_IDS, backendName } from "@byollm/protocol";
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
    const cut = stopLine("ollama", stopReasonOf(ok("length")), "declared");
    const finished = stopLine("ollama", stopReasonOf(ok("end")), "declared");
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

  it("distinguishes an adapter that CANNOT report from one whose word we missed", () => {
    /**
     * B105, and it is the conflation B064's third mapping kind exists to
     * prevent, arriving on the surface instead of in the declaration.
     *
     * `FINISH_REASONS` maps `stop` and `length` and nothing else, so a
     * DECLARED adapter returning `content_filter` or `tool_calls` resolves to
     * `unknown` — and it did report; we did not recognise the word. Telling
     * that owner "does not report why generation stopped" is false, and it is
     * the common case rather than the corner.
     */
    const cannot = stopLine("claude-cli", "unknown", "unavailable");
    const didNotSay = stopLine("openai-http", "unknown", "declared");
    expect(cannot).toContain("does not report");
    expect(didNotSay).toContain("did not say why");
    expect(
      didNotSay,
      "a declared adapter was described as unable to report",
    ).not.toContain("does not report");
    expect(cannot).not.toBe(didNotSay);
  });

  it("puts no registry label in the sentence, because a label is not a subject", () => {
    /**
     * Second instance of the defect fixed one row earlier. `backendName` on
     * the generic backend is "Any OpenAI-compatible server" — a noun phrase
     * written for a list — and as a subject it reads "Any OpenAI-compatible
     * server does not report why generation stopped", a claim about the
     * category rather than about the service that just ran.
     */
    for (const id of ["openai-http", "claude-cli", "ollama"] as const) {
      const line = stopLine(id, "unknown", "unavailable") ?? "";
      expect(line, id).not.toContain("Any OpenAI-compatible");
      expect(line, id).not.toContain(backendName(id));
    }
  });

  it("has a remedy decision for every backend, not for the eight I listed", () => {
    /**
     * B105's third finding. The first version was a `switch` with a
     * `default`, enumerating eight of seventeen HTTP backends — so nine
     * vendor APIs fell to silence by OMISSION rather than by decision, and a
     * backend added next year would inherit that silence with nothing
     * failing.
     *
     * The table is `Record<BackendId, …>` now, so the compiler is the check
     * and this asserts the decision was made either way rather than that a
     * particular answer came back.
     */
    for (const id of BACKEND_IDS) {
      const answered = stopRemedy(id, "length");
      const isLocal = [
        "ollama",
        "llamacpp",
        "vllm",
        "lmstudio",
        "jan",
        "localai",
        "mlx",
        "openai-http",
      ].includes(id);
      if (isLocal) {
        expect(
          answered,
          `${id} owns its model and should name a knob`,
        ).toBeDefined();
      } else {
        expect(
          answered,
          `${id} has no owner-side ceiling; naming one would be invented`,
        ).toBeUndefined();
      }
    }
  });

  it("says something honest about an entry written before the kind was recorded", () => {
    /* A log is a historical record and older entries have no `stopKind`. It
       cannot be resolved either way now, so it says the thing true of both. */
    expect(stopLine("ollama", "unknown", undefined)).toContain("not recorded");
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
    const dark = stopLine("claude-cli", "unknown", "unavailable");
    expect(dark).toContain("does not report");
    /* The control, and it is the whole point: a backend that CAN tell, and
       did, says nothing here. Without it "always warn" passes. */
    expect(stopLine("openai-http", "end", "declared")).toBeUndefined();
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

import { describe, expect, it } from "vitest";
import { openSealedOutcome } from "./sealed-outcome.js";

/**
 * The one place a sealed outcome is opened — B064 step 4's prerequisite.
 *
 * Extracted from `handlers.ts` and `cloud.ts`, which each did the same three
 * things and differed only in how they reported failure. Tested here because
 * moving code is exactly when a step goes missing, and one of these three was
 * covered by nothing: deleting the disposition check left the whole suite
 * green — 1,477 tests — which is how it would have been lost in the move.
 */
const outcome = (kind: "ok" | "error") =>
  kind === "ok"
    ? { outcome: "ok", text: "hello" }
    : {
        outcome: "error",
        code: "backend-error",
        message: "no",
        retryable: true,
      };

const sealed = (kind: "ok" | "error") =>
  JSON.stringify({
    outcome: outcome(kind),
    ran: { model: "m", backendClass: "http", durationMs: 5 },
  });

describe("opening a sealed outcome", () => {
  it("returns the outcome when the seal and the hint agree", () => {
    const opened = openSealedOutcome({
      plaintext: sealed("ok"),
      disposition: "ok",
    });
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.value.outcome.outcome).toBe("ok");
  });

  it("refuses a disposition that disagrees with what was sealed", () => {
    /**
     * The check that had no test, and the reason the function exists rather
     * than the callers doing this inline.
     *
     * `disposition` travels in the CLEAR — the relay read it and routed on
     * it — while the outcome inside was sealed by the device. byollm_009
     * §6.1: this is the only party that can open the envelope, so this is
     * the only place the two can be compared. A relay that mislabels a
     * failure as a success would otherwise deliver it as one.
     */
    const opened = openSealedOutcome({
      plaintext: sealed("error"),
      disposition: "ok",
    });
    expect(opened.ok, "a mislabelled result was accepted").toBe(false);
    if (!opened.ok) expect(opened.why).toContain("disposition");

    /* The control: the same sealed error, labelled honestly, is fine. Without
       it "refuse every error" would pass. */
    expect(
      openSealedOutcome({ plaintext: sealed("error"), disposition: "error" })
        .ok,
    ).toBe(true);
  });

  it("refuses plaintext that is not JSON, and JSON that is not an outcome", () => {
    expect(openSealedOutcome({ plaintext: "{oh", disposition: "ok" }).ok).toBe(
      false,
    );
    expect(
      openSealedOutcome({ plaintext: '{"a":1}', disposition: "ok" }).ok,
    ).toBe(false);
  });

  it("names which of the three refusals happened", () => {
    /* The direct lane turns these into refusal text a person reads, so they
       have to stay distinguishable — one message for three causes is the
       "generic bad-request" defect the version handshake was fixed for. */
    const why = (plaintext: string) => {
      const opened = openSealedOutcome({ plaintext, disposition: "ok" });
      return opened.ok ? "" : opened.why;
    };
    const reasons = [why("{oh"), why('{"a":1}'), why(sealed("error"))];
    expect(new Set(reasons).size, reasons.join(" | ")).toBe(3);
  });
});

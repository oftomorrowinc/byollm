import { describe, expect, it } from "vitest";
import {
  JobRefused,
  REFUSAL_TEXT,
  REFUSED_SELECTION,
  RefusalReason,
  type SelectionFailure,
} from "./job.js";

/**
 * A refusal must not become an inventory oracle — byollm_016 Phase B.
 *
 * A site may name a service. Two different things can go wrong: the owner has
 * no such service, or they have it and do not offer it to this requester. If a
 * requester can tell those apart, refusals become a probe — walk a name list,
 * sort the answers, and enumerate what somebody else's device runs without
 * ever being offered any of it.
 *
 * The first draft of `RefusalReason` had both causes on the wire, under a
 * comment asserting they disclosed identically to a stranger. They did not.
 * The comment was the dangerous part: it described a property the code lacked,
 * so a reader checking the design would have been reassured by prose while the
 * bytes said otherwise. This file is that prose turned into arithmetic.
 */

describe("two causes, one answer", () => {
  /** Both owner-side causes, as the daemon distinguishes them internally. */
  const CAUSES: readonly SelectionFailure[] = [
    "unadvertised",
    "unoffered-to-you",
  ];

  it("answers every selection failure with the identical object", () => {
    // Not "equivalent", not "same reason" — the same bytes. Anything a
    // requester can measure includes key order and whitespace, so the
    // comparison is the serialised form.
    const answers = CAUSES.map(() => JSON.stringify(REFUSED_SELECTION));
    expect(new Set(answers).size).toBe(1);
  });

  it("offers no per-cause builder to get wrong", () => {
    // The structural half. A function taking the cause would be a place for a
    // branch, and a branch is where the oracle grows back; a frozen constant
    // has nothing to vary. If this ever becomes a function, this test should
    // be read as the argument against it rather than updated.
    expect(Object.isFrozen(REFUSED_SELECTION)).toBe(true);
    expect(REFUSED_SELECTION.reason).toBe("select-unavailable");
  });

  it("keeps the two causes off the wire entirely", () => {
    // `SelectionFailure` is a type, not a schema, and its values must not be
    // reachable as refusal reasons. A future edit that "helpfully" adds them
    // back to the enum fails here.
    const reasons: readonly string[] = RefusalReason.options;
    expect(reasons).not.toContain("unadvertised");
    expect(reasons).not.toContain("unoffered-to-you");
    expect(reasons).not.toContain("select-unadvertised");
    expect(reasons).not.toContain("select-unoffered-to-you");
  });

  it("says nothing about a service in the words it uses", () => {
    // The message is outward text. It must not name what was asked for, or
    // echoing the requested name back would rebuild the oracle one layer up:
    // "no such service 'studio'" versus "'studio' is not offered to you" are
    // different strings even when the reason field matches.
    for (const text of Object.values(REFUSAL_TEXT)) {
      expect(text).not.toMatch(/\$\{|%s|\{\{/);
    }
    expect(REFUSED_SELECTION.message).toBe(REFUSAL_TEXT["select-unavailable"]);
  });

  it("gives every outward reason text, and the schema accepts each", () => {
    // The control: a collapse that accidentally deleted a reason, or a table
    // that fell out of step with the enum, would pass the assertions above
    // while breaking the thing they protect.
    for (const reason of RefusalReason.options) {
      const text = REFUSAL_TEXT[reason];
      expect(text.length).toBeGreaterThan(20);
      expect(
        JobRefused.safeParse({ outcome: "refused", reason, message: text })
          .success,
      ).toBe(true);
    }
  });

  it("still tells the kind-level refusals apart, because they cannot be probed", () => {
    // Not everything collapses, and the line is whether a requester can walk a
    // namespace. A service name is unbounded and supplied by the asker; a job
    // kind is neither. Collapsing these too would cost an app the ability to
    // act on a real difference — "the owner has not chosen" is fixable by the
    // owner, "the default cannot serve you" is not — and would buy nothing.
    expect(REFUSAL_TEXT["default-ambiguity"]).not.toBe(
      REFUSAL_TEXT["default-unusable"],
    );
  });
});

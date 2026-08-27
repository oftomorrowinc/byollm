import { describe, expect, it } from "vitest";
import { JobRefused, JobStub, REFUSAL_TEXT, RefusalReason } from "./job.js";

/**
 * A refusal must not become an inventory oracle — and now cannot be one.
 *
 * This file used to be about a collapse. A site could name one of an owner's
 * services, and two different things could go wrong: no such service, or it
 * exists and is not offered to you. Told apart, refusals became a probe — walk
 * a name list, sort the answers, enumerate a stranger's machine. So both
 * causes returned one frozen object, and these tests compared the bytes.
 *
 * Amendment L removed the field. A site declares purposes and a person maps
 * them; the service vocabulary never crosses the boundary in either direction.
 * **A vocabulary that cannot cross cannot be enumerated across** — which is
 * the same guarantee the collapse gave, held by the shape of the wire instead
 * of by a constant somebody had to keep frozen.
 *
 * What is left is the part that was never about names, and the case that
 * proves the door stayed shut.
 */

describe("the oracle is gone by construction", () => {
  it("gives a job no way to name a service", () => {
    // The structural assertion, and the reason the rest of this file shrank.
    // `.strict()` means a stub carrying `service` does not parse at all —
    // there is no field to probe with and no refusal wording to compare.
    const stub = {
      id: "job_1",
      kind: "llm.generate" as const,
      owner: "alice",
      site: "SITE-KEY-ID",
      audience: "team" as const,
      sizeClass: "small" as const,
      streaming: false,
      deadlineAt: 1_800_000_000_000,
    };
    expect(JobStub.safeParse({ ...stub, purpose: "revenue" }).success).toBe(
      true,
    );
    expect(JobStub.safeParse({ ...stub, service: "qwen" }).success).toBe(false);
  });

  it("leaves no refusal reason that speaks about services", () => {
    // A future edit that "helpfully" reintroduces a selection refusal fails
    // here. The reasons that remain are about *kinds*, which are bounded and
    // supplied by nobody.
    for (const reason of RefusalReason.options) {
      expect(reason).not.toContain("select");
      expect(reason).not.toContain("service");
    }
  });

  it("says nothing interpolated in the words it uses", () => {
    // Outward text must not echo what was asked for. Even with names off the
    // wire this holds the line one layer up: a message with a slot in it is a
    // message that can be made to carry an input back to its sender.
    for (const text of Object.values(REFUSAL_TEXT)) {
      expect(text).not.toMatch(/\$\{|%s|\{\{/);
    }
  });
});

describe("the refusals that remain", () => {
  it("gives every reason text, and the schema accepts each", () => {
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
    // Not everything collapses, and the line is whether a requester can walk
    // a namespace. A job kind is bounded and the requester named nothing.
    // Collapsing these would cost an app the ability to act on a real
    // difference — "the owner has not chosen" is fixable by the owner, "the
    // default cannot serve you" is not — and would buy nothing.
    expect(REFUSAL_TEXT["default-ambiguity"]).not.toBe(
      REFUSAL_TEXT["default-unusable"],
    );
  });
});

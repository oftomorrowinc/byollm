import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { GRANT_CONTEXT, grantStatement } from "./grant.js";
import { ENCRYPTION_KEY_CONTEXT } from "./keys.js";
import { SUCCESSION_CONTEXT } from "./succession.js";

/**
 * No two kinds of statement share a domain.
 *
 * Every signature here says what kind of statement it is before it says
 * anything else, and each constant's doc comment explains why. What none of
 * them explained is who checks that the constants actually *differ* — and
 * nobody did. A mutation setting `GRANT_CONTEXT` to `ROSTER_CONTEXT` passed
 * 256 tests, which is the whole protection silently absent while four
 * comments described it.
 *
 * If two contexts collide, bytes signed for one purpose verify for another: a
 * captured document replays as a different one, or a control plane that
 * signed one is held to have signed the other. The separator is only a
 * separator if it separates.
 *
 * The set below is enumerated from the code rather than described in prose,
 * so it shrinks when a context dies with its machinery — `ROSTER_CONTEXT`
 * left this list the day the roster did.
 */
const CONTEXTS: Readonly<Record<string, string>> = {
  GRANT_CONTEXT,
  SUCCESSION_CONTEXT,
  ENCRYPTION_KEY_CONTEXT,
};

describe("domain separators", () => {
  it("are all different from each other", () => {
    const values = Object.values(CONTEXTS);
    expect(new Set(values).size).toBe(values.length);
  });

  it("are all namespaced and versioned", () => {
    // A bare word is a separator that a future statement type can collide
    // with by accident rather than by mutation.
    for (const [name, value] of Object.entries(CONTEXTS)) {
      expect(value, name).toMatch(/^byollm\/v\d+\/[a-z-]+$/);
    }
  });

  it("lead the bytes they protect", () => {
    // A constant nothing signs over protects nothing. Asserted on the two
    // statements that build their own bytes here; the others are covered by
    // their own suites.
    const grant = Buffer.from(
      grantStatement({
        grantId: "g",
        jobId: "j",
        site: "s",
        user: "bob",
        owner: "alice",
        purpose: "p",
        kind: "llm.generate",
        service: "qwen",
        issuedAt: 1_800_000_000_000,
      }),
    ).toString("utf8");
    expect(grant).toContain(GRANT_CONTEXT);
    expect(grant.indexOf(GRANT_CONTEXT)).toBeLessThan(4);
  });
});

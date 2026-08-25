import { describe, expect, it } from "vitest";
import {
  AUDIENCES,
  effectiveOfferScope,
  matchAudience,
  OFFER_SCOPES,
  REFUSAL_MESSAGES,
  type Audience,
  type MatchRefusal,
  type OfferScope,
} from "./audience.js";

const OWNER = "alice";
const OTHER = "bob";

/** A daemon owned by `bob`, offering `scope`, that allows nobody by default. */
function daemon(
  scope: OfferScope,
  opts: {
    cost?: "free" | "metered" | "subscription";
    /** Only meaningful for a metered backend. */
    spendAcknowledged?: boolean;
    ceilingReached?: boolean;
    allows?: readonly string[];
    owner?: string;
  } = {},
) {
  const allows = opts.allows ?? [];
  return {
    owner: opts.owner ?? OTHER,
    offerScope: scope,
    cost: opts.cost ?? ("free" as const),
    spend: {
      acknowledged: opts.spendAcknowledged ?? false,
      ceilingReached: opts.ceilingReached ?? false,
    },
    locallyAllows: (o: string) => allows.includes(o),
  };
}

describe("effectiveOfferScope", () => {
  it("passes a free backend's configured scope through", () => {
    for (const scope of OFFER_SCOPES) {
      expect(effectiveOfferScope(scope, "free")).toBe(scope);
    }
  });

  it("locks a subscription backend to self whatever config says", () => {
    for (const scope of OFFER_SCOPES) {
      expect(effectiveOfferScope(scope, "subscription")).toBe("private");
    }
  });

  it("narrows a metered backend to self until the owner agrees to spend", () => {
    // byollm_007: the bug this closes is a paid API key offered `public` by
    // accident. Silence is not consent.
    for (const scope of OFFER_SCOPES) {
      expect(effectiveOfferScope(scope, "metered")).toBe("private");
      expect(
        effectiveOfferScope(scope, "metered", { acknowledged: false }),
      ).toBe("private");
    }
  });

  it("honours a metered backend once the owner has agreed", () => {
    for (const scope of OFFER_SCOPES) {
      expect(
        effectiveOfferScope(scope, "metered", { acknowledged: true }),
      ).toBe(scope);
    }
  });

  it("never lets consent widen a subscription backend", () => {
    // Someone else's terms are not the owner's to waive.
    for (const scope of OFFER_SCOPES) {
      expect(
        effectiveOfferScope(scope, "subscription", { acknowledged: true }),
      ).toBe("private");
    }
  });
});

describe("matchAudience — the nine-way matrix", () => {
  // Expected outcome for every (audience × offer scope) pair when the job's
  // owner is NOT the daemon's owner and the daemon's local allowlist is empty.
  // This is the table byollm_001's audience model describes in prose.
  const EXPECTED: Record<
    Audience,
    Record<OfferScope, MatchRefusal | "allow">
  > = {
    private: {
      private: "audience-self-other-owner",
      team: "audience-self-other-owner",
      public: "audience-self-other-owner",
    },
    team: {
      private: "offer-scope-too-narrow",
      team: "not-locally-allowed",
      public: "allow",
    },
    public: {
      private: "offer-scope-too-narrow",
      team: "not-locally-allowed",
      public: "allow",
    },
  };

  for (const audience of AUDIENCES) {
    for (const scope of OFFER_SCOPES) {
      const expected = EXPECTED[audience][scope];
      it(`audience=${audience} × offer=${scope} → ${expected}`, () => {
        const result = matchAudience({ owner: OWNER, audience }, daemon(scope));
        if (expected === "allow") {
          expect(result.ok).toBe(true);
        } else {
          expect(result).toEqual({ ok: false, refusal: expected });
        }
      });
    }
  }

  it("always admits the daemon's own owner, at every scope and audience", () => {
    for (const audience of AUDIENCES) {
      for (const scope of OFFER_SCOPES) {
        const result = matchAudience(
          { owner: OWNER, audience },
          daemon(scope, { owner: OWNER }),
        );
        expect(result.ok, `${audience} × ${scope}`).toBe(true);
      }
    }
  });
});

describe("matchAudience — named requires the daemon's own allowlist", () => {
  it("admits a named job once the local allowlist names its owner", () => {
    const result = matchAudience(
      { owner: OWNER, audience: "team" },
      daemon("team", { allows: [OWNER] }),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a named job the local allowlist omits, whatever the server says", () => {
    // The server asserts this runner is allowed; the daemon's own list does
    // not. byollm_001 Rev 1 §B: the daemon decides.
    const result = matchAudience(
      { owner: OWNER, audience: "team", audienceAllow: [OTHER] },
      daemon("team", { allows: [] }),
    );
    expect(result).toEqual({ ok: false, refusal: "not-locally-allowed" });
  });

  it("refuses when the server's allowlist excludes this runner", () => {
    const result = matchAudience(
      { owner: OWNER, audience: "team", audienceAllow: ["carol"] },
      daemon("team", { allows: [OWNER] }),
    );
    expect(result).toEqual({
      ok: false,
      refusal: "not-in-server-allowlist",
    });
  });

  it("ignores the server allowlist for the daemon's own owner", () => {
    const result = matchAudience(
      { owner: OWNER, audience: "team", audienceAllow: ["carol"] },
      daemon("team", { owner: OWNER }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("matchAudience — the subscription self-lock", () => {
  it("refuses another owner's work even if the caller passed a widened scope", () => {
    for (const scope of OFFER_SCOPES) {
      const result = matchAudience(
        { owner: OWNER, audience: "public" },
        daemon(scope, { cost: "subscription", allows: [OWNER] }),
      );
      expect(result, `scope=${scope}`).toEqual({
        ok: false,
        refusal: "subscription-self-lock",
      });
    }
  });

  it("still runs the owner's own work on a subscription backend", () => {
    const result = matchAudience(
      { owner: OWNER, audience: "private" },
      daemon("private", { cost: "subscription", owner: OWNER }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("refusal messages", () => {
  it("gives every refusal its own distinct sentence", () => {
    const messages = Object.values(REFUSAL_MESSAGES);
    expect(new Set(messages).size).toBe(messages.length);
    for (const m of messages) expect(m.length).toBeGreaterThan(20);
  });
});

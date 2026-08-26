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

describe("matchAudience — the four-way matrix", () => {
  // Expected outcome for every (audience × offer scope) pair when the job's
  // owner is NOT the daemon's owner and nothing admits them.
  //
  // **Every cell is a refusal**, and that is the shape to notice rather than
  // the size. When `public` existed, two of nine cells returned ALLOWED
  // without the device being consulted; a matrix with no such cell is a
  // matrix where a stranger's job cannot run unless something this device
  // checked said yes. The admitting case is its own test below, where what
  // does the admitting is visible.
  const EXPECTED: Record<Audience, Record<OfferScope, MatchRefusal>> = {
    private: {
      private: "audience-self-other-owner",
      team: "audience-self-other-owner",
    },
    team: {
      private: "offer-scope-too-narrow",
      team: "not-locally-allowed",
    },
  };

  for (const audience of AUDIENCES) {
    for (const scope of OFFER_SCOPES) {
      const expected = EXPECTED[audience][scope];
      it(`audience=${audience} × offer=${scope} → ${expected}`, () => {
        const result = matchAudience({ owner: OWNER, audience }, daemon(scope));
        expect(result).toEqual({ ok: false, refusal: expected });
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

describe("matchAudience — a team job requires this device to admit", () => {
  it("admits a team job once this device admits its owner", () => {
    const result = matchAudience(
      { owner: OWNER, audience: "team" },
      daemon("team", { allows: [OWNER] }),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a team job this device does not admit, whatever the server says", () => {
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
        { owner: OWNER, audience: "team" },
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

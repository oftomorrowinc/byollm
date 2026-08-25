import { describe, expect, it } from "vitest";
import {
  BACKENDS,
  type BackendCost,
  BACKEND_IDS,
  backendDescriptor,
  isLocalHost,
  resolveCost,
} from "./backends.js";
import {
  AUDIENCES,
  OFFER_SCOPES,
  matchAudience,
  type Audience,
  type MatchRefusal,
  type OfferScope,
} from "./audience.js";

/**
 * byollm_007. The bug being closed: `openai-http` was "open", but it accepts
 * an API key, so an owner could point it at a paid endpoint, offer it
 * `public`, and donate their credit balance to strangers.
 */

describe("the provider registry", () => {
  it("gives every provider a cost class, or defers it deliberately", () => {
    for (const id of BACKEND_IDS) {
      const d = BACKENDS[id];
      // Exactly one entry may defer: the generic escape hatch, whose cost
      // depends on where it points.
      if (d.cost === null) {
        expect(id).toBe("openai-http");
      } else {
        expect(["free", "metered", "subscription"]).toContain(d.cost);
      }
    }
  });

  it("declares every local provider free and every hosted one metered", () => {
    for (const id of BACKEND_IDS) {
      const d = BACKENDS[id];
      if (d.cost === "free") {
        // A "free" provider must point somewhere local, or the label is a lie.
        expect(d.defaultBaseUrl, id).toBeDefined();
        expect(isLocalHost(new URL(d.defaultBaseUrl ?? "").hostname), id).toBe(
          true,
        );
      }
      if (d.cost === "metered" && d.defaultBaseUrl !== undefined) {
        expect(isLocalHost(new URL(d.defaultBaseUrl).hostname), id).toBe(false);
        // A metered default must be https — an API key must not cross the
        // network in the clear.
        expect(new URL(d.defaultBaseUrl).protocol, id).toBe("https:");
      }
    }
  });

  it("ships the providers byollm_007 §3 names", () => {
    for (const id of ["ollama", "mlx", "llamacpp", "vllm", "lmstudio"]) {
      expect(backendDescriptor(id as never).cost).toBe("free");
    }
    for (const id of [
      "anthropic",
      "openai",
      "gemini",
      "grok",
      "groq",
      "openrouter",
    ]) {
      expect(backendDescriptor(id as never).cost).toBe("metered");
    }
    expect(backendDescriptor("claude-cli").cost).toBe("subscription");

    // One vendor, two cost classes — the axis is about who pays and under
    // what terms, not about which company is on the other end.
    expect(backendDescriptor("anthropic").cost).not.toBe(
      backendDescriptor("claude-cli").cost,
    );
  });

  it("routes every HTTP provider through the one audited transport", () => {
    // Providers are registry entries, not implementations — which is what
    // keeps one adversarial corpus covering all of them.
    for (const id of BACKEND_IDS) {
      const d = BACKENDS[id];
      expect(d.adversarialCorpus, id).toBe(
        d.class === "process" ? "process" : "http",
      );
    }
  });
});

describe("resolveCost [REMOTE_IS_NEVER_FREE, COST_NOT_CONFIGURABLE]", () => {
  it("takes a named provider's cost from the registry, ignoring the base URL", () => {
    // Pointing the `openai` provider at localhost does not make it free.
    expect(resolveCost("openai", "http://127.0.0.1:11434/v1", undefined)).toBe(
      "metered",
    );
    // Nor does pointing `ollama` at a remote host make it metered — the
    // registry is authoritative for named providers either way.
    expect(resolveCost("ollama", "https://api.openai.com/v1", undefined)).toBe(
      "free",
    );
  });

  it.each([
    ["http://127.0.0.1:11434/v1", "free"],
    ["http://localhost:1234/v1", "free"],
    ["http://192.168.1.50:8000/v1", "free"],
    ["http://10.0.0.4:8000/v1", "free"],
    ["http://172.16.5.5:8000/v1", "free"],
    ["http://[::1]:8080/v1", "free"],
    ["https://api.openai.com/v1", "metered"],
    ["https://models.example.com/v1", "metered"],
    ["http://203.0.113.10/v1", "metered"],
  ])("infers %s as %s for the generic backend", (url, expected) => {
    expect(resolveCost("openai-http", url, undefined)).toBe(expected);
  });

  it("treats an unusable base URL as metered — the expensive side", () => {
    // Guessing "free" wrong costs the owner money; guessing "metered" wrong
    // costs them a config line.
    expect(resolveCost("openai-http", undefined, undefined)).toBe("metered");
    expect(resolveCost("openai-http", "not a url", undefined)).toBe("metered");
  });
});

describe("the hole byollm_007 closes", () => {
  const strangersJob = { owner: "alice", audience: "public" as const };

  it("no longer lets a paid key be offered publicly by default", () => {
    const result = matchAudience(strangersJob, {
      owner: "bob",
      offerScope: "public",
      cost: resolveCost("openai-http", "https://api.openai.com/v1", undefined),
      spend: { acknowledged: false },
      locallyAllows: () => true,
    });
    expect(result).toEqual({
      ok: false,
      refusal: "metered-no-spend-consent",
    });
  });

  it("still allows it deliberately, with consent", () => {
    const result = matchAudience(strangersJob, {
      owner: "bob",
      offerScope: "public",
      cost: "metered",
      spend: { acknowledged: true, ceilingReached: false },
      locallyAllows: () => true,
    });
    expect(result.ok).toBe(true);
  });

  it("stops at the ceiling [METERED_REQUIRES_CEILING]", () => {
    const result = matchAudience(strangersJob, {
      owner: "bob",
      offerScope: "public",
      cost: "metered",
      spend: { acknowledged: true, ceilingReached: true },
      locallyAllows: () => true,
    });
    expect(result).toEqual({ ok: false, refusal: "metered-ceiling-reached" });
  });

  it("never charges the owner for their own work", () => {
    // Own work on your own key is your business, ceiling or not.
    const result = matchAudience(
      { owner: "bob", audience: "private" },
      {
        owner: "bob",
        offerScope: "private",
        cost: "metered",
        spend: { acknowledged: false, ceilingReached: true },
        locallyAllows: () => false,
      },
    );
    expect(result.ok).toBe(true);
  });

  it("keeps local compute freely shareable", () => {
    const result = matchAudience(strangersJob, {
      owner: "bob",
      offerScope: "public",
      cost: resolveCost("openai-http", "http://127.0.0.1:11434/v1", undefined),
      locallyAllows: () => true,
    });
    expect(result.ok).toBe(true);
  });
});

describe("the audience matrix across all three cost classes", () => {
  // byollm_001 described a nine-way table; byollm_007 gives it a third axis.
  // The point of writing all 27 out is that a change to any rule has to be
  // argued for here, in a table a reader can check against the spec, rather
  // than discovered later by whoever gets the bill.
  const OWNER = "alice";
  const OTHER = "bob";

  const daemon = (
    scope: OfferScope,
    cost: BackendCost,
    opts: { allows?: readonly string[] } = {},
  ) => ({
    owner: OTHER,
    offerScope: scope,
    cost,
    // A metered backend its owner deliberately shared, with room left on the
    // ceiling — the only configuration where metered can behave like free.
    spend: { acknowledged: true, ceilingReached: false },
    locallyAllows: (o: string) => (opts.allows ?? []).includes(o),
  });

  const SHARED: Record<Audience, Record<OfferScope, MatchRefusal | "allow">> = {
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

  // A subscription backend refuses on its own terms before scope is even
  // considered — but the job's own audience still gets the first word, so a
  // `self` job is refused for being someone else's, not for the subscription.
  const SUBSCRIPTION: Record<
    Audience,
    Record<OfferScope, MatchRefusal | "allow">
  > = {
    private: SHARED.private,
    team: {
      private: "subscription-self-lock",
      team: "subscription-self-lock",
      public: "subscription-self-lock",
    },
    public: {
      private: "subscription-self-lock",
      team: "subscription-self-lock",
      public: "subscription-self-lock",
    },
  };

  const TABLE: Record<
    BackendCost,
    Record<Audience, Record<OfferScope, MatchRefusal | "allow">>
  > = {
    // A consented, in-budget metered backend behaves exactly like a free one.
    // That equivalence is the whole design: cost decides whether sharing is
    // *possible*, and audience decides who — the two never blur together.
    free: SHARED,
    metered: SHARED,
    subscription: SUBSCRIPTION,
  };

  for (const cost of ["free", "metered", "subscription"] as const) {
    for (const audience of AUDIENCES) {
      for (const scope of OFFER_SCOPES) {
        const expected = TABLE[cost][audience][scope];
        it(`cost=${cost} × audience=${audience} × offer=${scope} → ${expected}`, () => {
          const result = matchAudience(
            { owner: OWNER, audience },
            daemon(scope, cost),
          );
          if (expected === "allow") {
            expect(result.ok).toBe(true);
          } else {
            expect(result).toEqual({ ok: false, refusal: expected });
          }
        });
      }
    }
  }

  it("admits the daemon's own owner at every cost, scope and audience", () => {
    for (const cost of ["free", "metered", "subscription"] as const) {
      for (const audience of AUDIENCES) {
        for (const scope of OFFER_SCOPES) {
          const result = matchAudience(
            { owner: OTHER, audience },
            daemon(scope, cost),
          );
          expect(result.ok, `${cost} × ${audience} × ${scope}`).toBe(true);
        }
      }
    }
  });

  it("opens a named offer to the locally allowed owner, at every cost that can share", () => {
    for (const cost of ["free", "metered"] as const) {
      const result = matchAudience(
        { owner: OWNER, audience: "public" },
        daemon("team", cost, { allows: [OWNER] }),
      );
      expect(result.ok, cost).toBe(true);
    }
  });
});

describe("locality is decided on addresses, never on names", () => {
  /**
   * cloud_008 §0.5. Every case here returned `true` before the fix, and each
   * one is `REMOTE_IS_NEVER_FREE` inverted: `free` means no ceiling, no
   * metering, and eligible to be offered `public`.
   *
   * The last two need no attacker and no unusual configuration. `/^f[cd]/`
   * was meant for `fc00::/7` and ran against the raw hostname, so any vendor
   * whose domain begins with the letters f-c or f-d was "local" — a paid API
   * at `fchat.ai` was free, and the owner's first hint would be the bill.
   */
  it.each([
    ["10.example.com", "an ordinary domain under a private-range prefix"],
    ["127.example.com", "the same trick with loopback"],
    ["192.168.evil.com", "and with the LAN range"],
    ["172.16.example.com", "and with the carve-out range"],
    ["fdapi.example.com", "a name starting fd — the fc00::/7 test"],
    ["fchat.ai", "a real product's name would have matched"],
  ])("%s is remote (%s)", (host) => {
    expect(isLocalHost(host)).toBe(false);
    // The property, not the helper: a paid endpoint at this address is
    // metered, so it carries a ceiling and cannot be offered as free compute.
    expect(resolveCost("openai-http", `https://${host}/v1`, undefined)).toBe(
      "metered",
    );
  });

  it.each([
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.7",
    "172.16.0.1",
    "172.31.255.254",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "localhost",
    "ollama.localhost",
  ])("%s is local", (host) => {
    // The positive control. Without it the fix could be "return false" and
    // every negative above would still pass — while breaking the default
    // Ollama path, which is the entire product.
    expect(isLocalHost(host)).toBe(true);
  });

  it("keeps the bracketed IPv6 form working", () => {
    expect(isLocalHost("[::1]")).toBe(true);
    expect(resolveCost("openai-http", "http://[::1]:11434/v1", undefined)).toBe(
      "free",
    );
  });

  it("treats an IPv4-mapped IPv6 loopback as metered, not free", () => {
    // Documented rather than fixed: the safe side of a rare case. If this
    // ever changes it should change because somebody hit it, not because a
    // regex grew.
    expect(isLocalHost("::ffff:127.0.0.1")).toBe(false);
  });

  it("does not resolve names to find out", () => {
    // A DNS lookup inside a cost decision can answer differently between the
    // check and the request. `localhost` is local because RFC 6761 says so,
    // not because anything looked.
    expect(isLocalHost("localhost.evil.com")).toBe(false);
    expect(isLocalHost("notlocalhost")).toBe(false);
  });
});

describe("cloud-tagged models — byollm_007, 2026-08-24", () => {
  /**
   * Ollama serves hosted models through the same `127.0.0.1` endpoint as
   * local ones. The address says free about a model somebody is billed for,
   * so the name has to decide — and the deciding part is the tag.
   *
   * The corpus, including the two that must NOT match and the oddball that
   * must fail toward metered.
   */
  const LOCAL = "http://127.0.0.1:11434/v1";

  it("bills a bare :cloud tag", () => {
    expect(resolveCost("openai-http", LOCAL, "glm-5.2:cloud")).toBe("metered");
  });

  it("bills a dated cloud tag", () => {
    expect(
      resolveCost("openai-http", LOCAL, "deepseek-v4-flash:0731-cloud"),
    ).toBe("metered");
  });

  it("leaves `cloudless` alone — the tag ends in `less`", () => {
    expect(resolveCost("openai-http", LOCAL, "x:cloudless")).toBe("free");
  });

  it("leaves a cloud-ish model NAME alone — the tag is what counts", () => {
    expect(resolveCost("openai-http", LOCAL, "cloudmodel:7b")).toBe("free");
  });

  it("leaves an untagged local model alone", () => {
    expect(resolveCost("openai-http", LOCAL, "llama3.2")).toBe("free");
  });

  it("leaves an untagged name that merely ends in cloud alone", () => {
    // Cloud-ness lives in the *tag*. A local model somebody called
    // `nimbuscloud` has no tag at all, so there is nothing hosted about it.
    //
    // This row exists because a mutation found its absence: anchoring on the
    // whole name (`/cloud$/`) rather than the tag passed every other case
    // here. Without it the rule was "ends in cloud", which is a different and
    // wronger rule that happened to agree on the examples chosen.
    expect(resolveCost("openai-http", LOCAL, "nimbuscloud")).toBe("free");
  });

  it("fails toward metered on an oddball tag [the permitted direction]", () => {
    // `:xcloud` is not a thing Ollama serves, and if it ever is, calling it
    // metered narrows what an owner may share and costs nobody money. The
    // reverse would hand somebody else's bill to a stranger.
    expect(resolveCost("openai-http", LOCAL, "weird:xcloud")).toBe("metered");
  });

  it("does not let a cloud tag make a named provider cheaper or dearer", () => {
    // The registry still has the last word for a named provider
    // [COST_NOT_CONFIGURABLE] — a tag cannot reclassify Claude.
    expect(resolveCost("claude-cli", undefined, "anything:cloud")).toBe(
      "subscription",
    );
  });
});

import { describe, expect, it } from "vitest";
import { ControlPlane } from "./engine.js";
import type { PolicySnapshot, PolicyStore } from "./store.js";

/**
 * Whether a slot can be satisfied, answered before a job exists.
 *
 * The README has promised this since the beginning — "it learns whether a slot
 * was satisfiable, and nothing else" — and the migration note told Kevin to
 * handle it on the same branch as "unavailable". Neither was true: an unmapped
 * purpose declined transiently, the job sat queued until it expired, and the
 * site was told nothing at all. He lost an afternoon to a slot that could
 * never be satisfied and asked the two questions we should have answered.
 */
describe("can this slot be satisfied", () => {
  const site = "site-1";
  const user = "someone";

  /**
   * A store that answers one snapshot, typed rather than cast.
   *
   * `satisfiable` reads and does not sign, so the signer is never reached —
   * but it is a real shape rather than an assertion that one exists, because
   * a test that lies about its dependencies is a test that stops describing
   * the thing it covers.
   */
  const engineOver = (snapshot: Partial<PolicySnapshot>) => {
    const store: PolicyStore = {
      read: () =>
        Promise.resolve({
          consented: "yes",
          member: false,
          mappings: [],
          ...snapshot,
        }),
    };
    return new ControlPlane({
      store,
      signer: {
        publicKey: "k",
        /* Never reached — `satisfiable` reads and does not sign — but it is a
           real shape rather than an assertion that one exists. A test that
           lies about its dependencies stops describing what it covers. */
        sign: () =>
          Promise.reject(new Error("satisfiable must not author a grant")),
      },
    });
  };

  it("refuses a purpose the site does not declare", async () => {
    const engine = engineOver({ declares: new Set(["writing-assistant"]) });
    expect(
      await engine.satisfiable({
        siteId: site,
        user,
        purpose: "fact-checker",
        kind: "llm.generate",
      }),
    ).toEqual({ verdict: "not-declared" });
  });

  it("refuses a declared purpose nobody has mapped", async () => {
    const engine = engineOver({ declares: new Set(["fact-checker"]) });
    expect(
      await engine.satisfiable({
        siteId: site,
        user,
        purpose: "fact-checker",
        kind: "llm.generate",
      }),
    ).toEqual({ verdict: "unmapped" });
  });

  it("allows a declared purpose that is mapped", async () => {
    const engine = engineOver({
      declares: new Set(["fact-checker"]),
      mappings: [
        {
          purpose: "fact-checker",
          kind: "llm.generate",
          service: "qwen",
          owner: null,
        },
      ],
    });
    expect(
      await engine.satisfiable({
        siteId: site,
        user,
        purpose: "fact-checker",
        kind: "llm.generate",
      }),
    ).toEqual({ verdict: "ok" });
  });

  /* A mapping for the same purpose under a different kind is not this slot.
     Press declares `writing-assistant` for generate only; a chat job against
     it is unsatisfiable however well the generate slot is mapped. */
  it("does not count a mapping for another kind", async () => {
    const engine = engineOver({
      declares: new Set(["writing-assistant"]),
      mappings: [
        {
          purpose: "writing-assistant",
          kind: "llm.generate",
          service: "qwen",
          owner: null,
        },
      ],
    });
    expect(
      (
        await engine.satisfiable({
          siteId: site,
          user,
          purpose: "writing-assistant",
          kind: "llm.chat",
        })
      ).verdict,
    ).toBe("unmapped");
  });

  /**
   * A store that cannot say what a site declares must not make every purpose
   * undeclared.
   *
   * `undefined` is "this store does not answer that", and a site with no
   * manifest declares everything implicitly — the reading the consent screen
   * and the engine already share, and the one a stricter version once broke
   * by refusing a write through a policy with no surface.
   */
  it("does not invent a refusal when the store cannot say", async () => {
    const engine = engineOver({
      mappings: [
        {
          purpose: "anything",
          kind: "llm.generate",
          service: "qwen",
          owner: null,
        },
      ],
    });
    expect(
      (
        await engine.satisfiable({
          siteId: site,
          user,
          purpose: "anything",
          kind: "llm.generate",
        })
      ).verdict,
    ).toBe("ok");
  });
});

import { describe, expect, it } from "vitest";
import { HeartbeatResponse } from "./wire.js";
import {
  UPDATE_OFFER_SINCE,
  checkDaemonFloor,
  compareVersions,
  mayOfferUpdate,
} from "./update-offer.js";

/**
 * B053's channel, and the one way it could take the fleet down.
 *
 * `HeartbeatResponse.updateTo` is new on a `.strict()` schema. Strict means a
 * daemon built before the field does not ignore it — it rejects the entire
 * heartbeat. So the message carrying the update would be the message that
 * breaks the machines it was meant to update.
 */
describe("ordering versions", () => {
  it("compares prerelease numbers as numbers", () => {
    /**
     * The whole reason this is not a string comparison. Lexicographically
     * `alpha.9` sorts AFTER `alpha.83`, and every daemon between .10 and .82
     * would be misjudged — in the direction that sends them a field they
     * cannot parse.
     */
    expect(compareVersions("0.1.0-alpha.9", "0.1.0-alpha.83")).toBe(-1);
    expect(compareVersions("0.1.0-alpha.83", "0.1.0-alpha.9")).toBe(1);
    expect(compareVersions("0.1.0-alpha.82", "0.1.0-alpha.82")).toBe(0);
    /* The trap itself, held at arm's length from the compiler so it stays
       readable as evidence: string ordering puts .9 after .83. */
    const lexicographic = ["0.1.0-alpha.9", "0.1.0-alpha.83"].sort();
    expect(lexicographic[0]).toBe("0.1.0-alpha.83");
  });

  it("orders releases above their own prereleases", () => {
    expect(compareVersions("0.1.0", "0.1.0-alpha.99")).toBe(1);
    expect(compareVersions("0.1.0-alpha.1", "0.1.0")).toBe(-1);
  });

  it("orders the release numbers first", () => {
    expect(compareVersions("0.2.0-alpha.1", "0.1.0-alpha.99")).toBe(1);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
  });

  it("says undefined rather than guessing at a version it cannot read", () => {
    expect(compareVersions("latest", "0.1.0")).toBeUndefined();
    expect(compareVersions("0.1", "0.1.0")).toBeUndefined();
  });
});

describe("who may be offered an update", () => {
  it("offers it to the version that introduced the field, and later", () => {
    expect(mayOfferUpdate(UPDATE_OFFER_SINCE)).toBe(true);
    expect(mayOfferUpdate("0.1.0-alpha.99")).toBe(true);
    expect(mayOfferUpdate("1.0.0")).toBe(true);
  });

  it("withholds it from every daemon that predates the field", () => {
    for (const old of ["0.1.0-alpha.9", "0.1.0-alpha.64", "0.1.0-alpha.82"]) {
      expect(mayOfferUpdate(old), old).toBe(false);
    }
  });

  it("treats a version it cannot read as a no", () => {
    /* Unreadable is not permission. Guessing yes here means a refused
       heartbeat; guessing no means one missed update cycle, and those are
       not the same size of mistake. */
    expect(mayOfferUpdate("latest")).toBe(false);
    expect(mayOfferUpdate("")).toBe(false);
    expect(mayOfferUpdate("not-a-version")).toBe(false);
  });
});

describe("what an old daemon would do with the field", () => {
  it("rejects the whole heartbeat, which is why the rule exists", () => {
    /**
     * The proof, rather than the assertion. This rebuilds the pre-field
     * response schema — same shape, minus `updateTo` — and shows that strict
     * makes an unknown key fatal to the entire message rather than to the
     * field.
     *
     * Without this the module above reads as caution about a hypothetical.
     */
    const asItWasBefore = HeartbeatResponse.omit({ updateTo: true }).strict();
    const withTheNewField = {
      sites: {},
      cancel: [],
      lost: [],
      serverTime: 1_757_000_000_000,
      awaitingConsent: [],
      updateTo: "0.1.0-alpha.83",
    };
    const refused = asItWasBefore.safeParse(withTheNewField);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.code).toBe("unrecognized_keys");

    /* And the control: the same message without the field parses, so what
       failed above is the new key and not the fixture. */
    const { updateTo: _offered, ...asSentToday } = withTheNewField;
    expect(asItWasBefore.safeParse(asSentToday).success).toBe(true);
  });

  it("accepts the field on the current schema, optional and absent", () => {
    const today = {
      sites: {},
      cancel: [],
      lost: [],
      serverTime: 1_757_000_000_000,
      awaitingConsent: [],
    };
    expect(HeartbeatResponse.safeParse(today).success).toBe(true);
    expect(
      HeartbeatResponse.safeParse({ ...today, updateTo: "0.1.0-alpha.83" })
        .success,
    ).toBe(true);
  });
});

describe("the floor — which daemons a hub will still serve", () => {
  const floor = (daemonVersion: string) =>
    checkDaemonFloor({
      daemonVersion,
      floor: "0.1.0-alpha.70",
      upgradeCommand: "npm i -g byollm@latest",
    });

  it("serves a daemon at the floor, and above it", () => {
    expect(floor("0.1.0-alpha.70")).toBeNull();
    expect(floor("0.1.0-alpha.82")).toBeNull();
    expect(floor("1.0.0")).toBeNull();
  });

  it("refuses one below it, and names the fix", () => {
    const refused = floor("0.1.0-alpha.9");
    expect(refused?.error).toBe("daemon-below-floor");
    /* The remedy is the whole point. A floor without one is an outage with
       a version number in it. */
    expect(refused?.message).toContain("npm i -g byollm@latest");
    expect(refused?.message).toContain("byollm start");
    expect(refused?.message).toContain("0.1.0-alpha.70");
  });

  it("does not refuse a version it cannot read", () => {
    /**
     * The deliberate asymmetry with `mayOfferUpdate`, which treats an
     * unreadable version as "do not offer". Both decline to act when they
     * cannot tell, and declining to act means opposite booleans: there,
     * guessing yes sends a field that breaks the heartbeat; here, guessing
     * yes takes a working machine out of service over a string.
     */
    expect(floor("not-a-version")).toBeNull();
    expect(floor("")).toBeNull();
    /* And the control, so this cannot pass by refusing nothing at all. */
    expect(floor("0.1.0-alpha.9")).not.toBeNull();
  });

  it("compares as versions here too", () => {
    /* The same trap as the offer: `alpha.9` sorts after `alpha.70` as a
       string, which would serve a daemon the floor exists to refuse. */
    expect(floor("0.1.0-alpha.9")).not.toBeNull();
    expect(floor("0.1.0-alpha.71")).toBeNull();
  });
});

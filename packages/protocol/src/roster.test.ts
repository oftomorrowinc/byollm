import { describe, expect, it } from "vitest";
import { generateKeys } from "./keys.js";
import {
  ROSTER_MAX_AGE_MS,
  rosterStatement,
  signRoster,
  verifyRoster,
} from "./roster.js";

/**
 * Amendment G's roster, and the four ways it must refuse.
 *
 * The amendment's whole claim is that a compromised *relay* cannot change who
 * a device serves. Every negative below is a relay trying, and each one would
 * pass a verifier that checked only "is this signature genuine".
 */
const NOW = 1_800_000_000_000;
const plane = generateKeys(NOW);
const other = generateKeys(NOW);
const PUB = plane.identityPublic;

const roster = (over: Partial<Parameters<typeof signRoster>[1]> = {}) =>
  signRoster(plane, {
    owner: "alice",
    members: ["bob", "carol"],
    issuedAt: NOW,
    ...over,
  });

const check = (
  r: ReturnType<typeof roster>,
  over: { owner?: string; now?: number; key?: string } = {},
) =>
  verifyRoster({
    roster: r,
    owner: over.owner ?? "alice",
    controlPlanePublic: over.key ?? PUB,
    now: over.now ?? NOW,
  });

describe("a roster the control plane signed", () => {
  it("verifies", () => {
    expect(check(roster())).toBeNull();
  });

  it("sorts members, so one membership is one document", () => {
    // A document that differed by iteration order would produce a new
    // signature on every read, and no way to tell a change from a shuffle.
    const a = signRoster(plane, {
      owner: "alice",
      members: ["carol", "bob"],
      issuedAt: NOW,
    });
    const b = roster();
    expect(a.signature).toBe(b.signature);
    expect(a.members).toEqual(["bob", "carol"]);
  });
});

describe("what a hostile relay cannot do", () => {
  it("cannot add a member", () => {
    const r = { ...roster(), members: ["bob", "carol", "mallory"] };
    expect(check(r)).toBe("bad-signature");
  });

  it("cannot remove a member", () => {
    const r = { ...roster(), members: ["bob"] };
    expect(check(r)).toBe("bad-signature");
  });

  it("cannot deliver one owner's roster to another's devices", () => {
    // The signature is perfectly genuine; it is about somebody else. A
    // verifier that read the owner out of the document would accept this.
    expect(check(roster(), { owner: "dave" })).toBe("wrong-owner");
  });

  it("cannot re-address one owner's roster by editing the field", () => {
    /**
     * The substitution the `wrong-owner` check above does **not** catch, found
     * by mutation: dropping `owner` from the signed bytes left every test
     * passing.
     *
     * A relay takes Alice's roster, rewrites `owner` to "dave", and delivers
     * it to Dave's devices. The comparison in `verifyRoster` reads the
     * rewritten field and finds it matches, so the only thing standing here is
     * that `owner` is inside the signature — which is why it is.
     *
     * Dave's devices would then serve Alice's teammates, and every check in
     * the system would have passed.
     */
    const stolen = { ...roster(), owner: "dave" };
    expect(check(stolen, { owner: "dave" })).toBe("bad-signature");
  });

  it("cannot move the issue time without breaking the signature", () => {
    // `issuedAt` is the freshness anchor, so it has to be signed over too —
    // otherwise a withheld roster is refreshed by editing one number.
    const forward = { ...roster(), issuedAt: NOW + 1 };
    expect(check(forward, { now: NOW + 2 })).toBe("bad-signature");
  });

  it("cannot sign one itself", () => {
    expect(check(roster(), { key: other.identityPublic })).toBe(
      "bad-signature",
    );
  });

  it("cannot backdate one to extend a removed member's access", () => {
    const r = roster({ issuedAt: NOW - ROSTER_MAX_AGE_MS - 1 });
    expect(check(r, { now: NOW })).toBe("stale");
  });

  it("cannot replay a valid roster past its age", () => {
    // The attack the anchor exists for: withhold every update and keep
    // re-delivering the last good document. Age is measured from `issuedAt`,
    // so simply holding it does not keep it alive.
    const r = roster();
    expect(check(r, { now: NOW + ROSTER_MAX_AGE_MS - 1 })).toBeNull();
    expect(check(r, { now: NOW + ROSTER_MAX_AGE_MS + 1 })).toBe("stale");
  });

  it("cannot post-date one to outlive the bound", () => {
    // A clock far ahead is as much a problem as one behind.
    expect(check(roster({ issuedAt: NOW + 60_000 }), { now: NOW })).toBe(
      "from-the-future",
    );
  });

  it("cannot pass a roster's bytes off as another kind of statement", () => {
    // The domain separator, asserted rather than assumed: the signed bytes
    // announce what they are before they say anything else.
    const bytes = Buffer.from(
      rosterStatement({ owner: "alice", members: ["bob"], issuedAt: NOW }),
    ).toString("utf8");
    expect(bytes.startsWith("byollm/v1/roster\n")).toBe(true);
  });

  it("cannot smuggle a membership through a member's name", () => {
    // NUL-joined, so no arrangement of names can imitate a different
    // membership. Comma-joined, `["bob,carol"]` and `["bob","carol"]` would
    // sign identically.
    const one = rosterStatement({
      owner: "alice",
      members: ["bob,carol"],
      issuedAt: NOW,
    });
    const two = rosterStatement({
      owner: "alice",
      members: ["bob", "carol"],
      issuedAt: NOW,
    });
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(false);
  });
});

describe("the bound itself", () => {
  it("is one hour, and the shortest thing in the protocol", () => {
    // Pinned so a change is deliberate: this is the only constant here that
    // bounds a *person's* access after the owner has said no.
    expect(ROSTER_MAX_AGE_MS).toBe(3_600_000);
  });
});

describe("the wire, and the order Phase C must deploy in", () => {
  it("accepts a response with no roster, so an older hub still works", async () => {
    const { HeartbeatResponse } = await import("./wire.js");
    const base = {
      sites: {},
      cancel: [],
      lost: [],
      serverTime: NOW,
      awaitingConsent: [],
    };
    expect(HeartbeatResponse.safeParse(base).success).toBe(true);
    expect(
      HeartbeatResponse.safeParse({ ...base, roster: roster() }).success,
    ).toBe(true);
  });

  it("rejects an unknown key, which is the deploy-order hazard", async () => {
    /**
     * These schemas are `.strict()` on purpose — a relay's answer is checked
     * before it is believed. The consequence is a one-way compatibility:
     * **a new field is safe to add and unsafe to send early.**
     *
     * A daemon on the previous release parsing a response that carries
     * `roster` fails the whole parse, not just the field — so its heartbeat
     * fails entirely, and it stops working for reasons that have nothing to do
     * with rosters.
     *
     * So Phase C deploys in one order and only one: publish the protocol, let
     * daemons update, *then* let the hub start sending. This test exists to
     * make that constraint something a reader trips over rather than
     * rediscovers in production.
     */
    const { HeartbeatResponse } = await import("./wire.js");
    const result = HeartbeatResponse.safeParse({
      sites: {},
      cancel: [],
      lost: [],
      serverTime: NOW,
      awaitingConsent: [],
      somethingNewerHubsSend: true,
    });
    expect(result.success).toBe(false);
  });
});

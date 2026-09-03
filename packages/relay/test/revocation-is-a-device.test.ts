import { describe, expect, it } from "vitest";
import { generateKeys, publicIdentityOf } from "@byollm/protocol";
import { Projection, type RelayFixture } from "../src/fixture.js";

/**
 * Revocation is a fact about one device, never a mood about an owner.
 *
 * This guard has now been wrong in both directions, which is why the matrix
 * below is shaped the way it is rather than testing one case.
 *
 * **First direction.** It answered "is there nothing to serve", so an empty or
 * half-written projection read as a human's decision. One bad control-plane
 * push and every daemon deleted its pinned keys.
 *
 * **Second direction — the walk, 2026-09-03.** The fix asked for evidence, and
 * asked it of the *owner*: any revocation on record plus no live site consents
 * refused every device that owner had. Todd paired a device, `install` started
 * the daemon, the hub answered 403 revoked, and the daemon deleted the pairing
 * it had written thirty seconds earlier. `byollm status` then said "paired apps
 * (none)" and the service exited 2 with nothing in the log.
 *
 * The person that kills is the ordinary new user: revoke an experiment, pair a
 * replacement, before enabling any site. So both failures are held here at
 * once, and the guard is asked about a device.
 */
const SITE = publicIdentityOf(generateKeys(1_800_000_000_000));
const device = (n: number) =>
  publicIdentityOf(generateKeys(1_700_000_000_000 + n));

/** Alice has three machines: A revoked, B live, C paired a minute ago. */
function fleet(over: Partial<RelayFixture> = {}): RelayFixture {
  return {
    sites: [{ siteId: "site_1", site: SITE }],
    consents: [{ owner: "alice", siteId: "site_1", paused: false }],
    devices: [
      { owner: "alice", runnerId: "A", device: device(1), revoked: true },
      { owner: "alice", runnerId: "B", device: device(2) },
      { owner: "alice", runnerId: "C", device: device(3), revoked: false },
    ],
    rosters: [],
    revoked: [],
    ...over,
  } satisfies RelayFixture;
}

describe("the three-device matrix", () => {
  it("refuses the revoked one and only the revoked one", () => {
    const projection = new Projection(fleet());
    expect(projection.revokedDevice("A"), "A was revoked").toBe(true);
    expect(projection.revokedDevice("B"), "B is untouched").toBe(false);
    expect(projection.revokedDevice("C"), "C was paired a minute ago").toBe(
      false,
    );
  });

  it("still serves B and C when the owner has no live consent", () => {
    /**
     * The walk's exact condition, and the one the old guard got wrong.
     *
     * Revoking an experiment and pairing a replacement *before* enabling a
     * site is the ordinary first hour. Under the owner-keyed guard that
     * combination — a revocation on record, zero consents — refused every
     * machine the account had.
     */
    const projection = new Projection(fleet({ consents: [] }));
    expect(projection.revokedDevice("B")).toBe(false);
    expect(projection.revokedDevice("C")).toBe(false);
    // And A is still refused: dropping the softener must not soften anything.
    expect(projection.revokedDevice("A")).toBe(true);
  });

  it("does not change its answer when a site is enabled", () => {
    /* A guard whose answer moves with unrelated state is not a guard. Under
       the old shape, enabling a site un-revoked a machine — the same fixture,
       one consent apart, gave opposite answers. */
    const withSite = new Projection(fleet());
    const without = new Projection(fleet({ consents: [] }));
    for (const runner of ["A", "B", "C"]) {
      expect(
        withSite.revokedDevice(runner),
        `enabling a site changed the answer for ${runner}`,
      ).toBe(without.revokedDevice(runner));
    }
  });

  it("loses nobody's pins when the projection knows nothing", () => {
    /* The first direction, kept. An empty push is not a decision: it must
       revoke no one, so a daemon reading it keeps everything it holds. */
    const empty = new Projection({
      sites: [],
      consents: [],
      devices: [],
      rosters: [],
      revoked: [],
    });
    for (const runner of ["A", "B", "C"]) {
      expect(empty.revokedDevice(runner)).toBe(false);
    }
  });

  it("reads a control plane that predates the field as revoking nobody", () => {
    /* `revoked` is optional, and absent must mean not revoked. The other
       reading — a missing field stopping the fleet — is this entry's own
       failure mode with a different cause. */
    const older = new Projection(
      fleet({
        devices: [{ owner: "alice", runnerId: "A", device: device(1) }],
      }),
    );
    expect(older.revokedDevice("A")).toBe(false);
  });

  it("says nothing about a runner it has never heard of", () => {
    // Unknown is `deviceFor`'s question, answered with 401 — a different
    // sentence for a different situation. This one must not claim it.
    expect(new Projection(fleet()).revokedDevice("nobody")).toBe(false);
  });
});

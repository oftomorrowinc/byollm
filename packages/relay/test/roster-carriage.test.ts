import { generateKeys, signRoster, verifyRoster } from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import { Projection } from "../src/fixture.js";

/**
 * The relay carries a roster and cannot author one — Amendment G, Phase C.
 *
 * The amendment's steer is **non-authorship, not opacity**: this relay may go
 * on knowing who is on a roster, because it needs to in order to route. What
 * it may not do is be the party anybody trusts about it.
 *
 * So the property under test is not that the relay is blind. It is that the
 * document it hands over is the control plane's own words, byte for byte —
 * because anything the relay did to it on the way past would be an opinion the
 * daemon has no way to tell from the control plane's.
 */
const NOW = 1_800_000_000_000;
const plane = generateKeys(NOW);

const fixtureWith = (members: string[]) =>
  new Projection({
    sites: [],
    consents: [],
    devices: [],
    // The relay's own advisory copy, which it routes on...
    rosters: [{ id: "g1", owner: "alice", members }],
    // ...and the control plane's signed statement, which it only carries.
    signedRosters: [
      {
        owner: "alice",
        roster: signRoster(plane, { owner: "alice", members, issuedAt: NOW }),
      },
    ],
    revoked: [],
  });

describe("what the relay does with a signed roster", () => {
  it("hands it over unchanged, so it still verifies at the device", () => {
    const carried = fixtureWith(["bob", "carol"]).signedRosterFor("alice");
    expect(carried).toBeDefined();
    expect(
      verifyRoster({
        roster: carried!,
        owner: "alice",
        controlPlanePublic: plane.identityPublic,
        now: NOW,
      }),
      "the relay altered a document it is only carrying",
    ).toBeNull();
  });

  it("has nothing for an owner the control plane did not sign for", () => {
    // Absent, not empty. "No roster" and "a roster admitting nobody" are
    // different facts, and only one of them is the control plane's.
    expect(fixtureWith(["bob"]).signedRosterFor("dave")).toBeUndefined();
  });

  it("cannot make its own advisory list into an admission", () => {
    /**
     * The two lists are allowed to disagree — that is what makes the second
     * one worth having. Here the relay's routing copy names somebody the
     * signed document does not, which is precisely the tampering the daemon
     * must catch.
     */
    const projection = new Projection({
      sites: [],
      consents: [],
      devices: [],
      rosters: [{ id: "g1", owner: "alice", members: ["bob", "mallory"] }],
      signedRosters: [
        {
          owner: "alice",
          roster: signRoster(plane, {
            owner: "alice",
            members: ["bob"],
            issuedAt: NOW,
          }),
        },
      ],
      revoked: [],
    });

    const carried = projection.signedRosterFor("alice");
    // `mayRunFor(deviceOwner, jobOwner)` — alice's device, mallory's work.
    // The relay would route it; the document it hands over does not name her,
    // and the document is what the device admits from.
    //
    // Asserted `true`, not `toBeDefined()`: this returns a boolean, so
    // "defined" passes on `false` and the disagreement this test exists to
    // show would evaporate without failing.
    expect(projection.mayRunFor("alice", "mallory")).toBe(true);
    expect(carried?.members).toEqual(["bob"]);
  });
});

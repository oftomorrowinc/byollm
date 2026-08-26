import { generateKeys, publicIdentityOf, signRoster } from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import { Relay } from "../src/index.js";
import type { RelayFixture } from "../src/fixture.js";

/**
 * The heartbeat actually carries the roster — Amendment G, Phase C.
 *
 * `roster-carriage.test.ts` proves the projection hands one over unchanged. A
 * mutation showed that says nothing about whether the *heartbeat* asks for it:
 * replacing the lookup with `undefined` left 162 relay tests green.
 *
 * That is last night's lesson arriving again — a mechanism covered and the one
 * line invoking it not — so the wire gets its own exchange rather than a
 * second test of the same accessor.
 */
const NOW = 1_800_000_000_000;
const plane = generateKeys(NOW);

describe("what a daemon receives on a heartbeat", () => {
  it("includes the signed roster for its owner", async () => {
    const site = publicIdentityOf(generateKeys(NOW));
    const device = generateKeys(NOW);
    const deviceIdentity = publicIdentityOf(device);
    const runnerId = "runner-roster-1";

    const roster = signRoster(plane, {
      owner: "alice",
      members: ["bob"],
      issuedAt: NOW,
    });

    const fixture: RelayFixture = {
      sites: [{ siteId: "site_1", site }],
      consents: [{ owner: "alice", siteId: "site_1", paused: false }],
      devices: [{ owner: "alice", runnerId, device: deviceIdentity }],
      rosters: [{ id: "g1", owner: "alice", members: ["bob"] }],
      signedRosters: [{ owner: "alice", roster }],
      revoked: [],
    };

    const relay = new Relay({
      fixture,
      now: () => NOW,
      controlPlanePublic: plane.identityPublic,
    });

    const body = JSON.stringify({
      protocolVersion: "0",
      runnerId,
      daemonVersion: "0.0.0",
      capabilities: [],
      withheld: [],
      activeLeases: [],
      paused: false,
    });
    const { signRequest } = await import("@byollm/protocol");
    const signature = signRequest(device, {
      endpoint: "heartbeat",
      runnerId,
      issuedAt: NOW,
      body,
    });

    const response = await relay.handle(
      new Request("https://hub.test/byollm/heartbeat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-byollm-runner": runnerId,
          "x-byollm-issued-at": String(NOW),
          "x-byollm-signature": signature.signature,
        },
        body,
      }),
    );

    expect(response.status).toBe(200);
    const answer = (await response.json()) as { roster?: typeof roster };
    // Byte-identical to what the control plane signed. Anything else and the
    // daemon's verification would fail for a reason nobody could explain.
    expect(answer.roster).toEqual(roster);
  });

  it("hands over the control-plane key at pairing, and only there", async () => {
    /**
     * The other half of the same gap: removing this from the pair response
     * left 163 relay tests green, because the roster tests all begin with a
     * device that is already paired.
     *
     * Without it a daemon holds no key, so every roster it is later sent is
     * refused — the flow would fail at the last step, one release after the
     * step that broke it.
     */
    const site = publicIdentityOf(generateKeys(NOW));
    const device = publicIdentityOf(generateKeys(NOW));
    const relay = new Relay({
      fixture: {
        sites: [{ siteId: "site_1", site }],
        consents: [{ owner: "alice", siteId: "site_1", paused: false }],
        devices: [{ owner: "alice", runnerId: "r1", device }],
        rosters: [],
        signedRosters: [],
        revoked: [],
      },
      now: () => NOW,
      controlPlanePublic: plane.identityPublic,
    });

    const response = await relay.handle(
      new Request("https://hub.test/byollm/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: "0",
          owner: "alice",
          device,
        }),
      }),
    );

    expect(response.status).toBe(200);
    const answer = (await response.json()) as { controlPlanePublic?: string };
    expect(answer.controlPlanePublic).toBe(plane.identityPublic);
  });

  it("omits the key when there is no control plane behind it", async () => {
    // A relay with none keeps working unchanged, and a daemon that receives
    // none holds no roster — which is the correct amount of function for a
    // relationship whose membership authority was never established.
    const site = publicIdentityOf(generateKeys(NOW));
    const device = publicIdentityOf(generateKeys(NOW));
    const relay = new Relay({
      fixture: {
        sites: [{ siteId: "site_1", site }],
        consents: [{ owner: "alice", siteId: "site_1", paused: false }],
        devices: [{ owner: "alice", runnerId: "r1", device }],
        rosters: [],
        signedRosters: [],
        revoked: [],
      },
      now: () => NOW,
    });

    const response = await relay.handle(
      new Request("https://hub.test/byollm/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocolVersion: "0", owner: "alice", device }),
      }),
    );
    const answer = (await response.json()) as { controlPlanePublic?: string };
    expect(answer.controlPlanePublic).toBeUndefined();
  });
});

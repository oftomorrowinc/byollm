import { describe, expect, it } from "vitest";
import { generateKeys, publicIdentityOf } from "@byollm/protocol";
import { connect } from "./connect.js";
import type { ProtocolClient } from "./client.js";

/**
 * A first install pairs before it has anything to serve, and that must work.
 *
 * This is the order the product asks for and the only order available:
 * install, pair, then connect a site — because until you have paired there is
 * nothing to connect a site *to*. So at the moment of pairing, a brand-new
 * account offers zero sites, always.
 *
 * `connect` used to refuse exactly that, with "this app approved the pairing
 * and then offered no sites to serve. Nothing was paired." Every genuinely new
 * user hit it, and it was invisible from the other side: the control plane had
 * already approved, so the dashboard showed the device and promised it would
 * "start taking work within a few seconds", while this end had thrown the
 * pairing away. What the person then saw was a device that never reports, a
 * services list that stays empty, and jobs timing out into "nothing was
 * listening" — three symptoms, none of which mentions a pairing.
 *
 * Serving nothing yet is a state the rest of the design already models: sites
 * arrive later and announce themselves with a fingerprint on their first job,
 * `byollm status` prints "(serving nothing right now)", and `known` exists to
 * hold ids that are pinned but not currently offered.
 */

const device = publicIdentityOf(generateKeys(1_700_000_000_000));

function client(sites: Record<string, unknown>): ProtocolClient {
  return {
    origin: "https://hub.test",
    pairStart: async () => ({
      userCode: "ABCD-EFGH",
      deviceCode: "dc",
      verificationUrl: "https://hub.test/devices?pair=1",
      expiresAt: 2_000_000_000_000,
      pollIntervalMs: 0,
    }),
    pairPoll: async () => ({
      status: "approved" as const,
      runnerId: "runner-1",
      owner: "owner-1",
      sites,
    }),
  } as unknown as ProtocolClient;
}

const options = {
  daemonVersion: "0.0.0-test",
  label: "a-laptop",
  capabilities: [],
  device,
  onCode: () => undefined,
  now: () => 1_700_000_000_000,
  sleep: async () => undefined,
};

describe("pairing with nothing to serve yet", () => {
  it("succeeds, because that is what a first install looks like", async () => {
    const result = await connect({ ...options, client: client({}) });
    expect(result.ok, "a new account cannot pair at all if this refuses").toBe(
      true,
    );
  });

  it("keeps the pairing, so the device can report and take later work", async () => {
    const result = await connect({ ...options, client: client({}) });
    if (!result.ok) throw new Error(result.message);
    expect(result.pairing.origin).toBe("https://hub.test");
    expect(result.pairing.owner).toBe("owner-1");
    expect(Object.keys(result.pairing.sites)).toEqual([]);
  });
});

describe("pairing with sites offered", () => {
  it("pins every site it was given", async () => {
    const site = publicIdentityOf(generateKeys(1_700_000_000_001));
    const result = await connect({
      ...options,
      client: client({ "site-a": site }),
    });
    if (!result.ok) throw new Error(result.message);
    expect(Object.keys(result.pairing.sites)).toEqual(["site-a"]);
    // Pinned as known too: a key that later moves under this id is refused
    // rather than read as somebody new.
    expect(Object.keys(result.pairing.known ?? {})).toEqual(["site-a"]);
  });

  /**
   * And the refusal that must survive: a site whose encryption key is not
   * signed by the identity presenting it. Pinning that would make an
   * impersonation permanent — the exact failure pinning exists to prevent,
   * arrived at by pinning. Every site, not the first: one unverifiable member
   * refuses the whole pairing.
   */
  it("refuses a site whose keys do not verify, and pins nothing", async () => {
    const good = publicIdentityOf(generateKeys(1_700_000_000_002));
    const forged = {
      ...publicIdentityOf(generateKeys(1_700_000_000_003)),
      encryption: publicIdentityOf(generateKeys(1_700_000_000_004)).encryption,
    };
    const result = await connect({
      ...options,
      client: client({ "site-a": good, "site-b": forged }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toMatch(/do not verify/);
  });
});

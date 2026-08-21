import { cryptoReady, generateKeys, publicIdentityOf } from "@byollm/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import {
  MAX_OUTSTANDING_PAIRINGS,
  MemoryPairingCodes,
  newDeviceCode,
  newUserCode,
  PAIRING_CODE_TTL_MS,
  type PendingPairing,
} from "../src/pairing-codes.js";

/**
 * The ceiling on pending pairings — readiness A10.
 *
 * Anybody can ask to pair; a machine with no pairing has no credential to
 * present, so this is the one door on the hub that opens to a stranger with a
 * script. Each request parks state in a shared store for ten minutes. Without
 * a ceiling the only limit is somebody's patience.
 */

beforeAll(async () => {
  await cryptoReady();
});

let clock = 1_000_000;
const now = () => clock;

const pendingFor = (seed: number): PendingPairing => ({
  deviceCode: newDeviceCode(),
  userCode: newUserCode(),
  device: publicIdentityOf(generateKeys(2_100_000_000_000 + seed)),
  label: `machine-${String(seed)}`,
  platform: "linux",
  expiresAt: now() + PAIRING_CODE_TTL_MS,
});

describe("how many pairings may be in flight", () => {
  it("refuses past its capacity instead of growing", async () => {
    const codes = new MemoryPairingCodes(now, 3);
    for (let i = 0; i < 3; i += 1) {
      expect(await codes.put(pendingFor(i))).toBe("stored");
    }
    expect(await codes.put(pendingFor(99))).toBe("at-capacity");
  });

  it("does not latch — expiry frees the capacity it was holding", async () => {
    const codes = new MemoryPairingCodes(now, 2);
    await codes.put(pendingFor(1));
    await codes.put(pendingFor(2));
    expect(await codes.put(pendingFor(3))).toBe("at-capacity");

    // The failure this guards: a ten-minute flood fills the cap, every entry
    // expires, and nothing ever pairs again because the count was never
    // revisited. That outage would outlast the attack by the life of the
    // process, which is worse than the flood.
    clock += PAIRING_CODE_TTL_MS + 1;
    expect(await codes.put(pendingFor(4))).toBe("stored");
  });

  it("keeps one outstanding code per keypair, replacing the old one", async () => {
    const codes = new MemoryPairingCodes(now, 10);
    const device = publicIdentityOf(generateKeys(2_100_000_000_777));

    const first: PendingPairing = { ...pendingFor(1), device };
    const second: PendingPairing = { ...pendingFor(2), device };
    await codes.put(first);
    await codes.put(second);

    // Todd typed a code wrong and started again; the stale one lingered for
    // ten minutes. The code on screen should be the only live one.
    expect(await codes.byDeviceCode(first.deviceCode)).toBeUndefined();
    expect(await codes.byDeviceCode(second.deviceCode)).toMatchObject({
      label: second.label,
    });
    expect(await codes.byUserCode(first.userCode)).toBeUndefined();
  });

  it("a repeating device cannot consume the capacity by itself", async () => {
    const codes = new MemoryPairingCodes(now, 2);
    const device = publicIdentityOf(generateKeys(2_100_000_000_778));
    for (let i = 0; i < 20; i += 1) {
      expect(await codes.put({ ...pendingFor(i), device })).toBe("stored");
    }
    // Somebody else can still pair: one keypair holds one slot, however many
    // times it asks.
    expect(await codes.put(pendingFor(500))).toBe("stored");
  });

  it("ships a ceiling nobody legitimate will meet", () => {
    // Sized against reality: a pairing takes under a minute of human
    // attention. If this number ever needs raising it will be because the
    // product succeeded, which is a good day to revisit it.
    expect(MAX_OUTSTANDING_PAIRINGS).toBeGreaterThanOrEqual(100);
  });
});

import { generateKeys, publicIdentityOf, type JobStub } from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import {
  AWAITING_PAYLOAD_MS,
  CHURN_EXPIRIES,
  CHURN_WINDOW_MS,
  RelayState,
  routeKey,
  UNSEALED_PER_PAIR,
  type UnsealedChurn,
} from "./state.js";

/**
 * B187's other half: the cap buys time, and this is what spends it.
 *
 * Which device claims is deliberately random (B194 — ties are luck), so a
 * patient site still samples a small fleet over minutes even at two unsealed
 * grants per pair. **You cannot cap your way out of a slow walk. You can
 * notice one** — and the shape is unmistakable, because an honest site never
 * reaches it: it seals in about a round trip, long before
 * `AWAITING_PAYLOAD_MS`.
 */
const SITE = "site_1";
const SITE_KEY_ID = "sk_1";

const stub = (id: string, owner = "alice"): JobStub => ({
  id,
  kind: "llm.generate",
  owner,
  site: SITE_KEY_ID,
  audience: "private",
  sizeClass: "small",
  streaming: false,
  deadlineAt: 4_102_444_800_000,
});

/** A sealed payload's shape, as the store checks it. */
const ENVELOPE = {
  ciphertext: "AAAA",
  recipientKeyId: "r",
  senderKeyId: "s",
  direction: "payload" as const,
  deadlineAt: 4_102_444_800_000,
};

const claimArgs = (owner = "alice", runnerId = "runner_1") => ({
  runnerId,
  owner,
  device: publicIdentityOf(generateKeys(Date.now())),
  kinds: new Set(["llm.generate"]),
  routes: new Set([routeKey(SITE, owner)]),
  max: 10,
  leaseMs: 60_000,
});

/** Claim, never seal, let the grants lapse — one turn of the walk. */
async function walkOnce(
  state: RelayState,
  clock: { at: number },
  from: number,
): Promise<void> {
  for (const n of [0, 1, 2]) {
    await state.enqueue({
      id: `job_${String(from + n)}`,
      siteId: SITE,
      stub: stub(`job_${String(from + n)}`),
    });
  }
  await state.claim(claimArgs());
  clock.at += AWAITING_PAYLOAD_MS + 1;
  await state.sweep();
}

describe("a site that claims and never seals", () => {
  it("is reported once it has burned enough grants to be a walk", async () => {
    const clock = { at: 1_000_000 };
    const told: UnsealedChurn[] = [];
    const state = new RelayState({
      now: () => clock.at,
      onUnsealedChurn: (churn) => told.push(churn),
    });

    /* Each turn burns `UNSEALED_PER_PAIR` grants, so the threshold is reached
       in a handful of turns — under a minute of real time. */
    for (let turn = 0; turn < CHURN_EXPIRIES; turn += 1) {
      await walkOnce(state, clock, turn * 10);
    }

    expect(told.length, "reported").toBeGreaterThan(0);
    expect(told[0]?.siteId).toBe(SITE);
    expect(told[0]?.owner).toBe("alice");
    expect(told[0]?.expiries).toBeGreaterThanOrEqual(CHURN_EXPIRIES);
  });

  it("reports a pair once, not once per expiry", async () => {
    /* A walk produces one of these every ten seconds. An alert per expiry is
       an alert somebody writes a filter for, which is worse than none. */
    const clock = { at: 1_000_000 };
    const told: UnsealedChurn[] = [];
    const state = new RelayState({
      now: () => clock.at,
      onUnsealedChurn: (churn) => told.push(churn),
    });

    for (let turn = 0; turn < CHURN_EXPIRIES * 3; turn += 1) {
      await walkOnce(state, clock, turn * 10);
    }

    expect(told).toHaveLength(1);
  });

  it("counts inside a window, so old expiries do not accumulate into an alert", async () => {
    /**
     * Found by mutation: removing the window trim left every case green,
     * because nothing here spread expiries across time.
     *
     * It matters. Without the window, a site with an occasional lapse — a
     * flaky network, a deploy mid-seal — reaches the threshold eventually
     * however long it takes, and the alert becomes a slow false positive that
     * teaches somebody to ignore it. A walk is a RATE.
     */
    const clock = { at: 1_000_000 };
    const told: UnsealedChurn[] = [];
    const state = new RelayState({
      now: () => clock.at,
      onUnsealedChurn: (churn) => told.push(churn),
    });

    /* Enough expiries to cross the threshold twice over — but each pair of
       turns separated by more than the window, so no window ever holds them. */
    for (let turn = 0; turn < CHURN_EXPIRIES * 2; turn += 1) {
      await walkOnce(state, clock, turn * 10);
      clock.at += CHURN_WINDOW_MS + 1;
    }

    expect(told, "spread out is not a walk").toEqual([]);
  });

  it("says nothing about a site that seals, which is every honest one", async () => {
    /**
     * The control, and the one that makes this alert worth reading. A site
     * that seals never lets a grant reach `AWAITING_PAYLOAD_MS`, so it cannot
     * produce this shape at all — which is why the threshold can sit low.
     */
    const clock = { at: 1_000_000 };
    const told: UnsealedChurn[] = [];
    const state = new RelayState({
      now: () => clock.at,
      onUnsealedChurn: (churn) => told.push(churn),
    });

    for (let turn = 0; turn < CHURN_EXPIRIES * 2; turn += 1) {
      await state.enqueue({
        id: `ok_${String(turn)}`,
        siteId: SITE,
        stub: stub(`ok_${String(turn)}`),
      });
      /* EVERY grant, not just the first. A claim returns up to the cap, and
         an honest site seals what it was given — sealing one of two is the
         churn shape, which is what this control must not accidentally be. */
      for (const granted of await state.claim(claimArgs())) {
        await state.seal({
          siteId: SITE,
          jobId: granted.id,
          envelope: ENVELOPE,
        });
      }
      clock.at += AWAITING_PAYLOAD_MS + 1;
      await state.sweep();
    }

    expect(told).toEqual([]);
  });

  it("does not let a thrown report take the sweep with it", async () => {
    /* A report is evidence ABOUT the sweep, not part of it: a mail server
       being down must not stop jobs being requeued. */
    const clock = { at: 1_000_000 };
    const state = new RelayState({
      now: () => clock.at,
      onUnsealedChurn: () => {
        throw new Error("the mailer is down");
      },
    });

    for (let turn = 0; turn < CHURN_EXPIRIES + 1; turn += 1) {
      await expect(walkOnce(state, clock, turn * 10)).resolves.not.toThrow();
    }
  });

  it("caps the walk at two grants a turn, which is what buys the time", async () => {
    /* The cap and the alert are one fix: without the cap a single turn takes
       the whole fleet and there is no window to notice anything in. */
    const clock = { at: 1_000_000 };
    const state = new RelayState({ now: () => clock.at });
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      await state.enqueue({
        id: `j${String(n)}`,
        siteId: SITE,
        stub: stub(`j${String(n)}`),
      });
    }
    expect(await state.claim(claimArgs())).toHaveLength(UNSEALED_PER_PAIR);
  });
});

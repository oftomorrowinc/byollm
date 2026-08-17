import { cryptoReady, generateKeys, publicIdentityOf } from "@byollm/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { RelayState } from "../src/index.js";

/**
 * The routing store's operations, each tested for the guard it carries.
 *
 * Written because a mutation run over `state.ts` after the operations moved
 * there from `DaemonPlane` killed three of eight. The five survivors were
 * guards that had never been tested **in either location** — moving them made
 * the gap visible rather than creating it, which is the useful half of a
 * refactor that changes no behaviour.
 *
 * Four of the five are protocol MUSTs:
 *
 * | guard | MUST |
 * | --- | --- |
 * | `claim` respects the owners set | `AUDIENCE_BOTH_SIDES` |
 * | `takePayload` checks the lease id | `LEASE_HONORED` |
 * | `complete` is a no-op when done | `RESULT_IDEMPOTENT` |
 * | `releaseLeases` checks the lease id | `LEASE_HONORED`, per instance |
 *
 * **The relay implements those MUSTs and nothing was checking that it does.**
 * The conformance kit certifies a *target*, and its target has always been
 * `@byollm/server`. The relay is a second implementation of the same daemon
 * plane — a different upstream a daemon talks to — and it has never been run
 * through the kit. Recorded in `packages/conformance/MUTATIONS.md`; these
 * tests are the local floor, not the answer.
 */

const KEYS = () => publicIdentityOf(generateKeys(Date.now()));
const SITE = "site_store";

const stub = (id: string, owner = "alice") => ({
  id,
  kind: "llm.generate" as const,
  owner,
  audience: "self" as const,
  sizeClass: "small" as const,
  streaming: false,
  deadlineAt: 4_102_444_800_000,
});

const claimArgs = (over: Partial<Parameters<RelayState["claim"]>[0]> = {}) => ({
  runnerId: "runner_1",
  owner: "alice",
  device: KEYS(),
  siteId: SITE,
  kinds: new Set(["llm.generate"]),
  owners: new Set(["alice"]),
  max: 10,
  leaseMs: 60_000,
  now: Date.now(),
  ...over,
});

beforeAll(async () => {
  await cryptoReady();
});

describe("claim", () => {
  it("offers nothing whose owner is not in the owners set", async () => {
    // AUDIENCE_BOTH_SIDES, the relay's half. `owners` is the projection
    // collapsed to data; a store that ignored it would route a stranger's work
    // to somebody's machine and rely entirely on the daemon refusing it.
    const state = new RelayState();
    await state.enqueue({
      id: "mine",
      siteId: SITE,
      stub: stub("mine", "alice"),
    });
    await state.enqueue({
      id: "theirs",
      siteId: SITE,
      stub: stub("theirs", "mallory"),
    });

    const granted = await state.claim(claimArgs());

    expect(granted.map((job) => job.id)).toEqual(["mine"]);
    expect((await state.job("theirs"))?.state).toBe("queued");
  });

  it("grants at most `max`, and leaves the rest claimable", async () => {
    // A daemon asks for what it can run *now*. A store that ignored `max`
    // would hand one device the whole queue and starve every other.
    const state = new RelayState();
    for (const id of ["a", "b", "c"]) {
      await state.enqueue({ id, siteId: SITE, stub: stub(id) });
    }

    const granted = await state.claim(claimArgs({ max: 2 }));

    expect(granted).toHaveLength(2);
    expect(
      (await state.jobs()).filter((job) => job.state === "queued"),
    ).toHaveLength(1);
  });

  it("sweeps first, so an abandoned job is claimable again", async () => {
    // `claim` sweeps before it grants, and this is the only thing that makes
    // that visible: a job whose site never sealed sits in `awaiting-payload`
    // until the timeout requeues it, and the requeue happens on somebody
    // else's claim rather than on a timer. Without the sweep the job is stuck
    // holding a grant nobody is using, and the queue silently shortens.
    const state = new RelayState();
    const now = 1_800_000_000_000;
    await state.enqueue({ id: "a", siteId: SITE, stub: stub("a") });

    const first = await state.claim(claimArgs({ now }));
    expect(first).toHaveLength(1);

    // The site never sealed. Past AWAITING_PAYLOAD_MS, a different device
    // asks — and gets it, because the claim swept the abandoned grant.
    const second = await state.claim(
      claimArgs({ runnerId: "runner_2", now: now + 11_000 }),
    );

    expect(second).toHaveLength(1);
    expect((await state.job("a"))?.claimedBy?.runnerId).toBe("runner_2");
    // A new grant, not the old one handed over.
    expect(second[0]?.lease.id).not.toBe(first[0]?.lease.id);
  });

  it("offers nothing of a kind the device did not advertise", async () => {
    const state = new RelayState();
    await state.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
    expect(
      await state.claim(claimArgs({ kinds: new Set(["llm.chat"]) })),
    ).toEqual([]);
  });
});

describe("takePayload", () => {
  const claimed = async () => {
    const state = new RelayState();
    await state.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
    const [granted] = await state.claim(claimArgs());
    await state.seal({ jobId: "a", siteId: SITE, envelope: ENVELOPE });
    return { state, leaseId: granted!.lease.id };
  };

  it("refuses a lease id that is not the current grant", async () => {
    // LEASE_HONORED per *instance*. A stale lease id names a grant that is
    // over, and answering it hands work to a previous holder — the shape that
    // made `release` need a lease id of its own in byollm_009 §4.2.
    const { state } = await claimed();
    const taken = await state.takePayload({
      jobId: "a",
      runnerId: "runner_1",
      leaseId: "a-grant-that-ended",
    });
    expect(taken).toEqual({ refused: "stale-lease" });
    // And the job is untouched: a refusal must not advance the state machine.
    expect((await state.job("a"))?.state).toBe("ready");
  });

  it("hands over the payload to the current holder", async () => {
    const { state, leaseId } = await claimed();
    const taken = await state.takePayload({
      jobId: "a",
      runnerId: "runner_1",
      leaseId,
    });
    expect(taken).toEqual({ envelope: ENVELOPE });
    expect((await state.job("a"))?.state).toBe("running");
  });

  it("refuses a runner that does not hold the job", async () => {
    const { state, leaseId } = await claimed();
    expect(
      await state.takePayload({
        jobId: "a",
        runnerId: "someone_else",
        leaseId,
      }),
    ).toEqual({ refused: "not-holder" });
  });
});

describe("complete", () => {
  it("is idempotent — a replayed result changes nothing", async () => {
    // RESULT_IDEMPOTENT. §4.2's argument for signing the request rather than
    // issuing a nonce rests on every write being idempotent per the instance
    // it names, so this is load-bearing for the auth scheme and not only for
    // the state machine.
    const state = new RelayState();
    await state.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
    await state.claim(claimArgs());

    const first = await state.complete({
      jobId: "a",
      runnerId: "runner_1",
      envelope: ENVELOPE,
      disposition: "ok",
    });
    const replay = await state.complete({
      jobId: "a",
      runnerId: "runner_1",
      envelope: { ...ENVELOPE, ciphertext: "a-different-result" },
      disposition: "error",
    });

    expect(first).toEqual({ accepted: true, state: "done" });
    expect(replay).toEqual({ accepted: false, state: "done" });
    // The second result did not overwrite the first — which is the property,
    // not the boolean.
    expect((await state.job("a"))?.result).toEqual(ENVELOPE);
    expect((await state.job("a"))?.disposition).toBe("ok");
  });
});

describe("releaseLeases", () => {
  it("refuses a lease id that is not the current grant", async () => {
    // The §4.2 bug exactly: `release` named a job and a runner, both of which
    // survive a claim-release-reclaim cycle, so a replayed release yanked a
    // later grant. It has to name the grant it means.
    const state = new RelayState();
    await state.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
    await state.claim(claimArgs());

    const released = await state.releaseLeases({
      runnerId: "runner_1",
      leases: [{ jobId: "a", leaseId: "an-older-grant" }],
    });

    expect(released).toEqual([]);
    expect((await state.job("a"))?.state).toBe("awaiting-payload");
  });

  it("gives back the grant it names", async () => {
    const state = new RelayState();
    await state.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
    const [granted] = await state.claim(claimArgs());

    expect(
      await state.releaseLeases({
        runnerId: "runner_1",
        leases: [{ jobId: "a", leaseId: granted!.lease.id }],
      }),
    ).toEqual(["a"]);
    expect((await state.job("a"))?.state).toBe("queued");
    expect((await state.job("a"))?.claimedBy).toBeUndefined();
  });
});

const ENVELOPE = {
  ciphertext: "AAAA",
  recipientKeyId: "r",
  senderKeyId: "s",
  direction: "payload" as const,
  deadlineAt: 4_102_444_800_000,
};

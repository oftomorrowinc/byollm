import { cryptoReady, generateKeys, publicIdentityOf } from "@byollm/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { AWAITING_PAYLOAD_MS, RelayState } from "../src/index.js";

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

/** A site's identity key id, standing in for a real one — Amendment A §A.3. */
const SITE_KEY_ID = "BYOLLM-TEST-SITE-KEY-ID";

const stub = (id: string, owner = "alice") => ({
  id,
  kind: "llm.generate" as const,
  owner,
  site: SITE_KEY_ID,
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
    // The clock is the store's now, so a test moves time by moving *it* —
    // which is also the only way a test can, and is the property that makes a
    // Valkey-backed store swap in without touching this file.
    let clock = 1_800_000_000_000;
    const state = new RelayState({ now: () => clock });
    await state.enqueue({ id: "a", siteId: SITE, stub: stub("a") });

    const first = await state.claim(claimArgs());
    expect(first).toHaveLength(1);

    // The site never sealed. Past AWAITING_PAYLOAD_MS, a different device
    // asks — and gets it, because the claim swept the abandoned grant.
    clock += 11_000;
    const second = await state.claim(claimArgs({ runnerId: "runner_2" }));

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

describe("audience, which the relay was ignoring", () => {
  /**
   * cloud_008 §2.1 — the relay's `claim` never looked at `stub.audience`.
   *
   * `owners` is `ownersRunnableBy(deviceOwner)`: everyone whose work this
   * device may run, which for a Team owner's machine is the whole roster.
   * Right for `public` and `named`, wrong for `self` — and `self` is the
   * audience a user picks *because* they want their own machine.
   *
   * The visible symptom was a ping-pong: the owner's daemon was offered a
   * member's private job, refused it against its local allowlist, released
   * it, and was offered it straight back. The invisible one is worse, and it
   * is the reason this is Tier 2 rather than Tier 4 — the relay was routing
   * work to a machine the job's owner had never chosen, and only the
   * daemon's own refusal stopped it.
   */
  const rosterClaim = (over = {}) =>
    claimArgs({
      // The Team owner's machine: it may run its own work and every roster
      // member's — which is exactly the projection this test is about.
      owner: "owner",
      owners: new Set(["owner", "alice"]),
      ...over,
    });

  it("does not offer a member's `self` job to the roster owner's machine", async () => {
    const state = new RelayState();
    await state.enqueue({
      id: "private",
      siteId: SITE,
      stub: { ...stub("private", "alice"), audience: "self" },
    });

    expect(await state.claim(rosterClaim())).toEqual([]);
    // Still queued, not consumed — the owner's machine simply is not a
    // candidate for it.
    expect((await state.job("private"))?.state).toBe("queued");
  });

  it("offers that same job to the owner's own machine", async () => {
    // The positive control. Without it, "refuse every `self` job" passes the
    // test above and breaks the most common audience in the product.
    const state = new RelayState();
    await state.enqueue({
      id: "private",
      siteId: SITE,
      stub: { ...stub("private", "alice"), audience: "self" },
    });

    const granted = await state.claim(
      claimArgs({ owner: "alice", owners: new Set(["alice"]) }),
    );
    expect(granted.map((job) => job.id)).toEqual(["private"]);
  });

  it("still offers a roster member's `public` job to the owner's machine", async () => {
    // The other positive control, and the one that says the fix narrowed
    // exactly one audience rather than breaking shared compute outright.
    const state = new RelayState();
    await state.enqueue({
      id: "shared",
      siteId: SITE,
      stub: { ...stub("shared", "alice"), audience: "public" },
    });

    expect((await state.claim(rosterClaim())).map((j) => j.id)).toEqual([
      "shared",
    ]);
  });
});

describe("a refusal is remembered", () => {
  /**
   * `REFUSAL_NOT_REOFFERED`, unimplemented on the relay — §2.1.
   *
   * `ReleaseRequest.reason` reached the handler and was dropped. Its own
   * docstring says why that matters: an upstream cannot evaluate a daemon's
   * *local* `named` allowlist, so it may legitimately offer work the daemon
   * declines, and without a record the two spin between claim and release
   * forever.
   */
  it("does not offer a job back to the runner that refused it", async () => {
    const state = new RelayState();
    await state.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
    const [granted] = await state.claim(claimArgs());

    await state.releaseLeases({
      runnerId: "runner_1",
      leases: [{ jobId: "a", leaseId: granted!.lease.id }],
      reason: "refused",
    });

    expect(await state.claim(claimArgs())).toEqual([]);
    // Queued, not gone: somebody else may still run it.
    expect((await state.job("a"))?.state).toBe("queued");
  });

  it("offers it to a different runner", async () => {
    const state = new RelayState();
    await state.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
    const [granted] = await state.claim(claimArgs());
    await state.releaseLeases({
      runnerId: "runner_1",
      leases: [{ jobId: "a", leaseId: granted!.lease.id }],
      reason: "refused",
    });

    const second = await state.claim(claimArgs({ runnerId: "runner_2" }));
    expect(second.map((job) => job.id)).toEqual(["a"]);
  });

  it("keeps a job claimable by a runner that only went away", async () => {
    // `shutdown`, `pause`, `backend-down` and `revoked` all mean "not now".
    // Treating them as refusals would strand a daemon's own work across a
    // restart — the failure mode is silent and permanent, which is why the
    // reason is checked rather than the fact of a release.
    const state = new RelayState();
    await state.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
    const [granted] = await state.claim(claimArgs());

    await state.releaseLeases({
      runnerId: "runner_1",
      leases: [{ jobId: "a", leaseId: granted!.lease.id }],
      reason: "shutdown",
    });

    expect((await state.claim(claimArgs())).map((j) => j.id)).toEqual(["a"]);
  });
});

describe("the store's clock", () => {
  /**
   * Every deadline is stamped from `state.now()` — cloud_006 §3.4.
   *
   * Asserted as exact arithmetic rather than through behaviour, because
   * behaviour cannot tell these apart. A mutation replacing the store's clock
   * with `Date.now()` survived every behavioural test: the deadlines still
   * expired, still swept, still requeued — just measured against a different
   * clock, which is precisely the bug that appears only when two replicas
   * hold different ones and nothing looks wrong on either.
   *
   * A lease granted by a pod whose clock runs fast is short; the same lease
   * swept by a pod whose clock runs slow outlives it. Neither pod is wrong,
   * and the lease has no length. So the test has to be about the number.
   */
  const CLOCK = 1_800_000_000_000;

  it("stamps a lease's expiry from its own clock", async () => {
    const state = new RelayState({ now: () => CLOCK });
    await state.enqueue({ id: "a", siteId: SITE, stub: stub("a") });

    const [granted] = await state.claim(claimArgs({ leaseMs: 45_000 }));

    expect(granted?.lease.expiresAt).toBe(CLOCK + 45_000);
  });

  it("stamps the awaiting-payload window from its own clock", async () => {
    const state = new RelayState({ now: () => CLOCK });
    await state.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
    await state.claim(claimArgs());

    // The third clock byollm_009 §7.1 requires: how long we wait for a site,
    // distinct from the lease and from the job's TTL.
    expect((await state.job("a"))?.awaitingUntil).toBe(
      CLOCK + AWAITING_PAYLOAD_MS,
    );
  });

  it("stamps presence from its own clock", async () => {
    const state = new RelayState({ now: () => CLOCK });
    const seen = await state.seen({
      runnerId: "runner_1",
      owner: "alice",
      device: KEYS(),
    });
    expect(seen.lastSeenAt).toBe(CLOCK);
  });

  it("accepts an async clock, which is what a shared store returns", async () => {
    // Valkey answers `TIME` over the wire. The memory store's clock is
    // synchronous and the interface takes either, so swapping one for the
    // other touches no caller — which is the whole reason the clock moved
    // into the store rather than staying a parameter.
    const state = new RelayState({ now: () => Promise.resolve(CLOCK) });
    await state.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
    const [granted] = await state.claim(claimArgs({ leaseMs: 1_000 }));
    expect(granted?.lease.expiresAt).toBe(CLOCK + 1_000);
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
    const [granted] = await state.claim(claimArgs());
    const leaseId = granted!.lease.id;

    const first = await state.complete({
      jobId: "a",
      runnerId: "runner_1",
      leaseId,
      envelope: ENVELOPE,
      disposition: "ok",
    });
    // The same grant, replayed — which is what idempotency is about. A
    // *different* grant is the case below, and it is not a replay.
    const replay = await state.complete({
      jobId: "a",
      runnerId: "runner_1",
      leaseId,
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

  it("refuses a result produced under a grant that ended", async () => {
    // LEASE_HONORED per instance — cloud_008 §1.4a, the gap `takePayload` and
    // `releaseLeases` never had. `complete` checked the runner id, which
    // survives a claim-release-reclaim cycle, so a device whose lease had been
    // swept and reissued could still write the result.
    //
    // Refused rather than reported as a replay: the sender's work was real and
    // is being rejected because its grant ended, and `accepted: false` would
    // tell it the result had already been recorded.
    const state = new RelayState();
    await state.enqueue({ id: "a", siteId: SITE, stub: stub("a") });
    await state.claim(claimArgs());

    const late = await state.complete({
      jobId: "a",
      runnerId: "runner_1",
      leaseId: "a-grant-that-ended",
      envelope: ENVELOPE,
      disposition: "ok",
    });

    expect(late).toEqual({ refused: "stale-lease" });
    // And the job is untouched: the current holder can still finish it.
    expect((await state.job("a"))?.state).toBe("awaiting-payload");
    expect((await state.job("a"))?.result).toBeUndefined();
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

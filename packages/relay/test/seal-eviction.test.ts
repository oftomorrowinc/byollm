import { generateKeys, publicIdentityOf } from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import {
  AWAITING_PAYLOAD_MS,
  RelayState,
  routeKey,
  SEAL_ATTEMPTS_BEFORE_EVICTION,
} from "../src/state.js";

/**
 * A job whose site never seals is dropped by the hub — B042.
 *
 * The daemon's own patience is per-device by construction, so it cannot
 * solve this: device A waits its ten seconds and gives up, the job is
 * requeued, device B waits its ten seconds, and so on through the fleet
 * until the job's deadline — which can be an hour away. Every machine does
 * the same nothing, and none of them can tell that the last one already
 * tried.
 *
 * B041 stops one device looping. Only the hub can stop the job, which is why
 * this is the half that kills the poison at its source.
 */
const SITE = "site_a";

const stub = (id: string, deadlineAt: number) => ({
  id,
  kind: "llm.generate" as const,
  audience: "private" as const,
  owner: "me",
  site: SITE,
  sizeClass: "small" as const,
  streaming: false,
  deadlineAt,
});

/** A store whose clock the test moves, and the claim arguments it needs. */
function make() {
  let clock = 1_800_000_000_000;
  const store = new RelayState({ now: () => clock });
  const advance = (ms: number) => {
    clock += ms;
  };
  const claim = () =>
    store.claim({
      runnerId: "runner_1",
      owner: "me",
      device: publicIdentityOf(generateKeys(1_800_000_000_000)),
      kinds: new Set(["llm.generate"]),
      routes: new Set([routeKey(SITE, "me")]),
      leaseMs: 60_000,
      max: 10,
    });
  return { store, advance, claim, at: () => clock };
}

describe("a job whose payload never arrives", () => {
  it("is dropped by the hub after three devices have waited", async () => {
    const { store, advance, claim, at } = make();
    await store.enqueue({
      id: "a",
      siteId: SITE,
      stub: stub("a", at() + 3_600_000),
    });

    for (let round = 0; round < SEAL_ATTEMPTS_BEFORE_EVICTION - 1; round += 1) {
      const granted = await claim();
      expect(granted, `round ${String(round)} was not offered`).toHaveLength(1);
      advance(AWAITING_PAYLOAD_MS + 1);
      await store.sweep();
      /* Still here: a site that is merely slow keeps its job, and the next
         device gets a turn. */
      expect((await store.job(SITE, "a"))?.state).toBe("queued");
    }

    const last = await claim();
    expect(last).toHaveLength(1);
    advance(AWAITING_PAYLOAD_MS + 1);
    const swept = await store.sweep();

    expect(
      await store.job(SITE, "a"),
      "the hub kept handing round a job nobody can complete",
    ).toBeUndefined();
    expect(swept.map((job) => job.id)).toContain("a");
  });

  it("keeps offering a job whose site does seal, however slow it was", async () => {
    /**
     * The control, and the one that matters: an eviction rule that trips on
     * work a site is still doing is worse than handing the job round. Two
     * devices give up, the third gets a payload, and the job survives — with
     * its counter reset, so a later lease lapse does not evict it for a
     * problem it no longer has.
     */
    const { store, advance, claim, at } = make();
    await store.enqueue({
      id: "a",
      siteId: SITE,
      stub: stub("a", at() + 3_600_000),
    });

    for (let round = 0; round < 2; round += 1) {
      await claim();
      advance(AWAITING_PAYLOAD_MS + 1);
      await store.sweep();
    }

    await claim();
    const sealed = await store.seal({
      jobId: "a",
      siteId: SITE,
      envelope: { v: 1, ciphertext: "x" } as never,
    });
    expect(sealed).toMatchObject({ state: "ready" });

    /* And the reset is real: two more give-ups do not evict it, because the
       count measures CONSECUTIVE failures rather than a lifetime quota. */
    for (let round = 0; round < 2; round += 1) {
      advance(70_000); // the lease lapses, the job is requeued
      await store.sweep();
      await claim();
      advance(AWAITING_PAYLOAD_MS + 1);
      await store.sweep();
    }
    expect(
      await store.job(SITE, "a"),
      "a job that sealed once was evicted for its earlier waits",
    ).toBeDefined();
  });

  it("does not evict a job that is merely waiting, before its window is up", async () => {
    /* The other control. Without it, "evict everything awaiting" passes the
       first case — and a hub that drops jobs the instant they are claimed
       serves nobody. */
    const { store, advance, claim, at } = make();
    await store.enqueue({
      id: "a",
      siteId: SITE,
      stub: stub("a", at() + 3_600_000),
    });
    await claim();
    advance(AWAITING_PAYLOAD_MS - 1);
    await store.sweep();
    expect((await store.job(SITE, "a"))?.state).toBe("awaiting-payload");
  });
});

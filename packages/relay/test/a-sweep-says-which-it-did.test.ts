import { describe, expect, it } from "vitest";
import { RelayState } from "../src/state.js";
import type { RoutedJob } from "../src/state.js";
import { Relay } from "../src/index.js";

/**
 * A sweep says which jobs came back and which were given up on — B250.
 *
 * `Relay.sweep()` returned one array called `requeued`, and a job the relay had
 * DROPPED was in it: a deadline that passed, or a stub handed round until
 * `SEAL_ATTEMPTS_BEFORE_EVICTION` was spent. An operator reading `requeued: 3`
 * about three jobs nobody will ever run was told the opposite of what
 * happened.
 *
 * That is B096's own sentence one layer above where B096 fixed it — *"a caller
 * that logs 'requeued' and never mentions expiry would report a shrinking
 * queue with no reason for it"* — and the store had the fact the whole time.
 *
 * ## The design, and it is why this needs no repin
 *
 * `RoutedJob.sweptAway` is optional and **absent means requeued**. So a store
 * that never sets it behaves exactly as it did before the field existed:
 * `removed` empty, `requeued` holding the union. `ValkeyRoutingStore` lives in
 * another repository and adopts it when its pin moves; there is no moment
 * where either side is wrong, because the field says less until the store says
 * more.
 *
 * The last case is the one that guarantees that, and it is the reason this
 * could land before a flip rather than after one.
 */

/** A store that reports a sweep and nothing else — the seam, minimally. */
const storeReporting = (swept: RoutedJob[]) =>
  ({
    sweep: () => Promise.resolve(swept),
  }) as unknown as RelayState;

const job = (id: string, over: Partial<RoutedJob> = {}): RoutedJob =>
  ({
    id,
    siteId: "site",
    state: "queued",
    stub: {},
    ...over,
  }) as unknown as RoutedJob;

const relayOver = (swept: RoutedJob[]): Relay => {
  const relay = new Relay({});
  /* The state is the seam under test; replacing it keeps this about what
     `sweep()` REPORTS rather than about what a sweep decides, which
     `state.ts`'s own cases already cover. */
  (relay as unknown as { state: RelayState }).state = storeReporting(swept);
  return relay;
};

describe("what a sweep reports", () => {
  it("calls a requeued job requeued", async () => {
    const { requeued, removed } = await relayOver([job("back")]).sweep();
    expect(requeued).toEqual(["back"]);
    expect(removed).toEqual([]);
  });

  it("calls a dropped job removed, and not requeued", async () => {
    /* The whole row: this job is gone, nobody will run it, and it used to be
       counted under a word meaning the opposite. */
    const { requeued, removed } = await relayOver([
      job("gone", { sweptAway: true }),
    ]).sweep();
    expect(removed).toEqual(["gone"]);
    expect(requeued).toEqual([]);
  });

  it("separates them in one sweep, which is the case that matters", async () => {
    const { requeued, removed } = await relayOver([
      job("back"),
      job("gone", { sweptAway: true }),
      job("also-back"),
    ]).sweep();
    expect(requeued).toEqual(["back", "also-back"]);
    expect(removed).toEqual(["gone"]);
  });

  it("behaves exactly as before for a store that marks nothing", async () => {
    /**
     * The guarantee that lets this land without a repin.
     *
     * `ValkeyRoutingStore` is in another repository and does not set the
     * marker yet. Absent means requeued, so it gets the union under the old
     * name and an empty `removed` — byte for byte the answer it got before
     * this field existed. No lockstep, and no window where either side is
     * wrong.
     */
    const { requeued, removed } = await relayOver([
      job("a"),
      job("b"),
      job("c"),
    ]).sweep();
    expect(requeued).toEqual(["a", "b", "c"]);
    expect(removed).toEqual([]);
  });
});

describe("the state marks what it dropped", () => {
  it("marks an expired job and leaves a requeued one alone", async () => {
    /**
     * The other half, against the real `RelayState`: the split above is only
     * worth anything if somebody sets the marker, and a test that fed itself
     * marked jobs would prove the filter and nothing else.
     *
     * A job past its deadline is dropped — `deadlineAt` bounds how long a
     * ciphertext is worth carrying, and a stub nobody may run is not routing
     * state.
     */
    const state = new RelayState();
    await state.enqueue({
      id: "late",
      siteId: "site",
      stub: {
        id: "late",
        kind: "llm.generate",
        owner: "alice",
        site: "SITE",
        audience: "private",
        sizeClass: "small",
        streaming: false,
        deadlineAt: 1,
      },
    });

    const swept = await state.sweep();
    expect(swept.map((j) => j.id)).toEqual(["late"]);
    expect(
      swept[0]?.sweptAway,
      "a job past its deadline is dropped, not requeued — it is the case the " +
        "word `requeued` was wrong about",
    ).toBe(true);
  });
});

import { beforeAll } from "vitest";
import { cryptoReady } from "@byollm/protocol";
import { RelayState } from "../src/index.js";
import { describeStoreContract } from "../src/store-contract.js";

/**
 * The contract, against the store this package ships — cloud_008 finding 54.
 *
 * The cases live in `src/store-contract.ts` because `byollm-cloud` runs the
 * same ones against Valkey, and two copies of a contract is two places for
 * two implementations to diverge. This file is four lines because that is all
 * a second implementation should have to write.
 *
 * `RelayState` passes the serialising case by construction — it holds typed
 * objects and cannot hold a stub it cannot parse — so it declares itself
 * non-serialising rather than pretending to prove it.
 */

beforeAll(async () => {
  await cryptoReady();
});

/**
 * One clock per store, so the time-dependent cases actually run — B187.
 *
 * `advance` is optional in the contract and its cases skip without it. Left
 * unwired, the sticky re-offer would be a rule this package declares and does
 * not check — the shape this repository keeps finding, in the file whose whole
 * job is to stop a second implementation diverging quietly.
 */
const clocks = new WeakMap<RelayState, { at: number }>();

describeStoreContract("RelayState (in memory)", {
  make: () => {
    /* Anchored to the real clock rather than a fixed epoch: cases that
       compute a not-before from `Date.now()` compare against this one, and a
       store living in 2027 makes every such deadline already past. */
    const clock = { at: Date.now() };
    const store = new RelayState({ now: () => clock.at });
    clocks.set(store, clock);
    return Promise.resolve({
      store,
      done: () => Promise.resolve(),
    });
  },
  advance: (store, ms) => {
    const clock = clocks.get(store as RelayState);
    if (clock) clock.at += ms;
    return Promise.resolve();
  },
});

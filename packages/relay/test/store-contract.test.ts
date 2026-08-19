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

describeStoreContract("RelayState (in memory)", {
  make: () =>
    Promise.resolve({
      store: new RelayState(),
      done: () => Promise.resolve(),
    }),
});

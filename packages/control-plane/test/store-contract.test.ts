import { MemoryPolicyStore } from "../src/index.js";
import { describePolicyStoreContract } from "../src/store-contract.js";

/**
 * The contract, against the store this package ships.
 *
 * The cases live in `src/store-contract.ts` because byollm.cloud runs the same
 * ones against Postgres, and two copies of a contract is two places for two
 * implementations to diverge. This file is short because that is all a second
 * implementation should have to write.
 */
describePolicyStoreContract("MemoryPolicyStore", {
  make: () => {
    const store = new MemoryPolicyStore();
    return Promise.resolve({
      store,
      consent: (input) => {
        store.consent(input);
      },
      revoke: (input) => {
        store.revoke(input);
      },
      pause: (input) => {
        store.pause(input);
      },
      addMember: (input) => {
        store.addMember(input);
      },
      removeMember: (input) => {
        store.removeMember(input);
      },
      done: () => Promise.resolve(),
    });
  },
});

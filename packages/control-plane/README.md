# @byollm/control-plane

> **Alpha (`0.1.0-alpha.74`) — under active development. Don't use this yet.**

The reference control plane: it resolves a person's mapping and authors one
signed grant per job, against a policy store it does not own and with a key it
never sees.

```ts
import { ControlPlane, MemoryPolicyStore, keypairSigner } from "@byollm/control-plane";
import { Relay } from "@byollm/relay";

const engine = new ControlPlane({
  store: new MemoryPolicyStore(),
  signer: keypairSigner(keys),
});

const relay = new Relay({
  fixture,
  controlPlanePublic: engine.publicKey,
  authorGrant: (input) => engine.authorGrant(input),
});
```

## What this is for

A byollm device runs nothing on somebody else's behalf without a **grant**: a
short-lived, single-use, signed statement that this job, for this person, on
this device, may run — and which of the owner's services should answer. The
device verifies it against a key it pinned when it paired, so the party
routing the job can withhold a grant and cannot forge one.

This package is what writes them.

## Two things it deliberately does not hold

**Your data.** Accounts, consents, memberships and mappings live behind
[`PolicyStore`](src/store.ts). This package reads; it never owns. That is the
split that lets a hosted product keep its database while the *rule* over that
database stays readable — because a rule nobody can read is a rule nobody can
check.

**Your key.** [`GrantSigner`](src/signer.ts) is a function, not a keypair, so
custody can sit behind a KMS and this code cannot tell.

## The contract

`@byollm/control-plane/store-contract` is a suite any `PolicyStore` can run
against itself:

```ts
import { describePolicyStoreContract } from "@byollm/control-plane/store-contract";

describePolicyStoreContract("my store", { make: async () => ({ /* … */ }) });
```

It ships in the package because the implementation that matters most is in
somebody else's repository, and a contract only its author can run is a
description.

## The law it applies

In order, and the order is by whose fact each step is:

1. **A device always runs its own owner's work**, and no store is asked. It is
   a law rather than an optimisation — routing it through a store would put it
   somewhere an implementation could get wrong.
2. The person has **consented** to this site, and has not paused it.
3. They are a **member** of this device owner's team — asked only about other
   people.
4. Their **mapping** for this (purpose, kind) names a service.
5. This device **actually offers** it, for this kind.

Any step failing stops the rest, so the reason returned names the first thing
that was wrong rather than whichever check ran last.

## Declining says whether it is forever

A relay releases a declined job, and a release can be permanent — never offer
this job to this device again. Getting that wrong permissively is a
claim-refuse loop, which announces itself. Getting it wrong strictly is a job
that can never reach the machine it was always meant for, and no error
anywhere. So only two reasons are permanent: a person removed from a team, and
consent withdrawn. An unfilled slot, a mapping that resolved to another
machine, and a policy store that was briefly unreachable are all states that
can change, and the job goes back in the queue.

## Licence

MIT.

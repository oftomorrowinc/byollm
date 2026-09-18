> [!WARNING]
> **Alpha (`0.1.0-alpha.102`) — under active development. Don't use this yet.**
>
> Install it deliberately: `npm install @byollm/agreements@alpha`.
>
> The protocol is v0 and **will** change without a deprecation path, this has
> never run outside its own test suite, and nothing here has production miles.
> Read it, take the ideas, tell us what's wrong — but don't put it in front of
> your users.
>
> npm assigns `latest` on a first publish and won't let it be removed, so a
> bare install resolves here too. This notice is the only guard — deliberately
> not an npm deprecation, which would read as *abandoned* rather than *early*.
> Ask for `@alpha` explicitly so your lockfile records that you meant to.

# @byollm/agreements

The sentences and rules more than one byollm repository has to state
identically.

## Why this is a package

byollm is built across three repositories, and some facts have to be true in
more than one of them at once. The clearest case is the sentence on the privacy
page describing what the hosted service can see: it is printed by one
repository and checked, clause by clause against the columns actually recorded,
by another.

**A check cannot read another repository.** So a promise like that gets written
out twice, and two copies of a promise drift — in the copy that is not the one
with the check under it. The page stays reassuring and stops being true, which
is worse than never having made the promise.

There are only two ways to fix that, and neither removes the problem so much as
choose which failure to have:

1. **A copy in each repository.** They diverge, silently.
2. **One package both import.** It goes stale — but staleness is a version pin,
   and a pin is a number something can compare.

This is the second, ruled 2026-09-17. The comparison that makes staleness loud
is the cross-repository pin check that runs before any release is tagged.

## Why it is published

A promise about what a hosted service can see is worth more when anybody can
install the package, read the exact sentence, and hold the service to it. The
alternative — keeping it in a private repository — asks you to take our word
for both the promise and its wording.

## What belongs here

Something belongs in this package when **two repositories would otherwise
write it out separately and drift.** A constant used in one repository belongs
in that repository. The admission criterion is deliberately narrow: a shared
package with a loose one becomes a junk drawer, and a junk drawer is a place
nobody checks.

## Usage

```ts
import { HUB_FENCE, HUB_FENCE_CLAUSES } from "@byollm/agreements";
```

`HUB_FENCE` is the sentence, verbatim. `HUB_FENCE_CLAUSES` maps each clause to
the recorded columns it accounts for, so the repository that holds the schema
can fail when a new column is not claimed by any clause.

## License

MIT

<!-- family:start -->

## The rest of byollm

Seven packages, and they are only interesting together:

- [`byollm`](https://www.npmjs.com/package/byollm) — the daemon — runs models on your own machine and answers for it
- [`@byollm/protocol`](https://www.npmjs.com/package/@byollm/protocol) — the wire: envelopes, signatures and the closed vocabularies both ends validate against
- [`@byollm/server`](https://www.npmjs.com/package/@byollm/server) — the SDK a site uses to ask a device for work
- [`@byollm/relay`](https://www.npmjs.com/package/@byollm/relay) — the broker that holds jobs between a site and a device, and can read neither
- [`@byollm/control-plane`](https://www.npmjs.com/package/@byollm/control-plane) — who may ask whom, and the policy store behind it
- [`@byollm/conformance`](https://www.npmjs.com/package/@byollm/conformance) — the kit that proves an implementation is one — including a posture audit that holds nothing but a URL

<!-- family:end -->

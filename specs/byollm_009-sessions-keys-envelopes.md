# byollm_009 — Sessions, keys, and sealed envelopes

**Status: FROZEN, 2026-08-15.** The condition stated below was met: a
real job round-trips end to end between a real daemon and a real
`@byollm/server` site, in both direct mode and through the reference
relay, with the demonstrations running in CI (`freeze-gate` and
`freeze-gate-postgres`).

**Eight findings, none of which a review caught.** Every one came from
a new real consumer, and each was an assumption the previous plane had
hidden:

1. `claim`-then-`fetch` assumed `fetch` always succeeds — true only
   where the site *is* the upstream. The first relayed job was claimed,
   answered `not-ready`, and abandoned while holding a good lease.
2. `awaiting-payload` (§7) was unreachable on the direct plane and is
   load-bearing off it, with a clock distinct from the lease and TTL.
3. `complete` enforced `LEASE_HONORED` against a lease the site never
   granted, so a relayed result could never be written.
4. The same gap expired jobs a device was actively running.
5. Relay lease ids were composite strings; `lease_id` is `uuid`.
6. The relay let the daemon name itself; a device has never named
   itself on the direct plane.
7. `lease_runner` is a foreign key, and a relayed device has no row —
   so the site records the **grant, not the machine**.
8. Reading a lease from `lease_runner` made an actively-held job look
   claimable once that column was correctly left null.

Findings 5–8 appeared only against real Postgres, after the same code
was green against the in-memory store. That is the argument for the
freeze condition, restated as evidence: **a real-infrastructure path
with no real-infrastructure test is a promise, not a property.**

All eight were package-internal. Nothing in the wire surface moved —
envelope, handshake, MUSTs and stub schema are as specified here — so
a third-party daemon or server built to this document needs no change.
That distinction is the freeze test: not "did anything change" but
"would an independent implementation have to."

*Original condition, for the record:* this design is not adopted until
a real job has round-tripped through it between a real daemon and a
real server. Protocol specs that freeze before their first consumer
freeze the wrong things.

This is the largest breaking change on the roadmap. It is taken while
the protocol is v0 and says plainly that it will change without a
deprecation path, and before anything real depends on the current
envelope — which is the cheapest this will ever be.

---

## 1. What this changes

Today a daemon pairs with **a site** and polls it. Three things about
that are load-bearing and none of them are stated anywhere:

1. **The daemon has no identity.** A runner token is a bearer secret
   the server minted. Anyone holding it is the runner.
2. **Jobs are stored in plaintext** by whoever runs the server, and
   read in plaintext by anything with database access.
3. **The connection is versionless.** A daemon and a server discover
   they disagree by failing.

This spec replaces all three, and introduces one new idea that makes
the rest reusable: **the thing a daemon connects to is an _upstream_,
not necessarily the app itself.**

A site running `@byollm/server` is one upstream. A relay that routes
between many users and many sites is another. **They implement the
same interface, and this spec is written about the interface.** Nothing
here requires a relay to exist, and every part of it is worth having
without one — §10 is explicit about what direct mode gains, and about
what it does not.

### Terms

| Term | Meaning |
|---|---|
| **device** | One daemon install, with one keypair. A user may have several. |
| **site** | An application using `@byollm/server`. Holds a keypair. |
| **upstream** | Whatever a daemon connects to: a site directly, or a relay. |
| **relay** | An upstream that routes between users and sites it does not own. |
| **endpoint** | A party that holds keys and sees plaintext: a device or a site. Never a relay. |

---

## 2. Cryptography

**Established primitives only, via libsodium:** Ed25519 signatures,
X25519 key agreement, XChaCha20-Poly1305 AEAD, sealed boxes. No novel
constructions. The cleverness budget goes to key *management*, which is
where these systems actually fail.

A concrete consequence: this spec names no algorithm agility mechanism.
Negotiating primitives is a downgrade surface, and a v0 protocol that
can break compatibility freely does not need one — a change of
primitive is a change of protocol version.

---

## 3. Identity and keys

**Each party holds two keypairs, and the distinction is load-bearing:**

- an **Ed25519 identity key**, used to sign — challenges, and every
  envelope the party sends;
- an **X25519 encryption key**, used to receive sealed envelopes.

The encryption key is signed by the identity key at exchange time, and
**the identity key is what gets pinned.** That separation lets an
encryption key rotate without re-establishing trust, and it keeps the
"who sent this" and "who can read this" questions answered by different
keys — which §6 depends on.

- **Device keys.** Generated at first run. Private halves never leave
  the machine — OS keychain where available, a `0600` file otherwise.
  This replaces the bearer token as the daemon's identity: a stolen
  file still needs to be on a machine that can use it, and a
  compromised upstream cannot mint a device.
- **Site keys.** Same pair, same rules. A site key compromise is
  revocable without touching users.
- **An upstream holds public keys only.** No escrow, no content
  recovery. Losing every device means re-pairing, which is acceptable
  precisely because no content exists at rest in a relay.

**Fingerprints are displayable on both sides.** `byollm status` shows
the site keys a daemon has pinned; a site's settings page shows the
device keys it has pinned. This is what makes key distribution
trust-on-first-use rather than trust-the-middle: an out-of-band
comparison is possible for anyone who wants it.

---

## 4. The session

Runs on every connection, cheap enough to run on every reconnect.

1. **Version first.** The daemon sends build version, platform, and
   protocol semver. The upstream answers with an accepted version or a
   structured refusal naming a minimum and a human-readable fix.
   `VERSION_HANDSHAKE_REQUIRED`: no versionless connection is accepted,
   in either direction.
2. **Challenge auth.** No passwords, no bearer tokens on the daemon
   plane: the daemon proves possession of its device key.

   **Amended in implementation (2026-08-14).** This first said the
   upstream issues a nonce and the daemon signs it. Building it showed
   that costs one of two things — a round trip before every request, or
   server-side session state — and a session token is a bearer
   credential, which is the thing being removed.

   So the daemon signs **the request itself**: endpoint, runner id,
   timestamp, and a hash of the exact body, verified against the
   identity pinned at consent. A captured signature is valid only for
   the request it covers, and every authenticated endpoint here is
   already idempotent — `RESULT_IDEMPOTENT` makes a replayed result a
   no-op, a replayed claim returns what that runner already holds — so
   a replay inside the freshness window gains an attacker nothing they
   could not get by forwarding the original, which a relay can do
   anyway.

   That argument rests entirely on the endpoints being idempotent. **A
   future endpoint that is not idempotent cannot use this scheme
   unchanged**; it needs a server-issued nonce.

   Freshness is bounded in both directions by a clock-skew window,
   which couples a daemon's clock to its upstream's: a server whose
   clock is wrong by more than the window refuses every daemon, and
   says only that the signature is invalid.
3. **Capability declaration — effective offers only.** The daemon
   declares kind, model, cost class and *effective* offer scope, with
   consent already applied locally. `EFFECTIVE_OFFER_ONLY`: an upstream
   never learns raw config, allowlist contents, spend ceilings, or
   capacity the owner has not agreed to share. It learns what is on
   offer, not what exists.
4. **Session and resume.** Heartbeat cadence is agreed; a short-lived
   resume token lets a dropped connection continue without a full
   handshake. Resume tokens are single-use and bound to the device key.
   **Resume re-asserts the protocol version.** Skipping it would make
   resume a way to keep an unsupported daemon connected indefinitely
   across a version cutover — the one path around a minimum-version
   policy, opened by an optimisation.

The version tuple from byollm_010 §5 lands here — `--version` and the
handshake report the same thing, because a support conversation and a
minimum-version policy need the same facts.

---

## 5. Consent and key exchange

A user connects a site to their compute by an explicit approval — the
same shape as today's device-code pairing, extended to carry keys. The
result is a **consent record** binding {user, site, scopes}, plus an
exchange: each side receives the other's **identity public key and its
signed encryption public key**, verifies the signature, and **pins the
identity key**. An encryption key presented later without a valid
signature from the pinned identity is refused — which is what stops an
upstream swapping in a key of its own.

`CONSENT_BEFORE_ROUTE`: no consent record, no routing, ever. There is
no discovery path, no directory lookup, and no "sites you might like"
that bypasses the click.

**Revocation** deletes the routing entry at the upstream *and* is
pushed to the daemon, which drops the pinned key.
`REVOCATION_IMMEDIATE`: upstream-side removal takes effect at once and
the upstream refuses routes meanwhile; the daemon-side key drop lands
by the next heartbeat. Stating both halves matters — a revocation that
is only enforced at one end is a revocation that survives a compromise
of that end.

---

## 6. Envelope v2 — stub and sealed payload

The core change. A job becomes two things instead of one.

**Phase 1 — the stub.** The site enqueues routing metadata only:

```
{ jobId, user, site, kind, audience, sizeClass, deadlineAt, streaming }
```

This list is **exhaustive and normative**. It is what an upstream can
see, stated as a commitment rather than left as an accident of
implementation. `kind` is visible because capability matching happens
upstream; if a later revision moves matching to the daemon, `kind`
moves into the ciphertext.

`audience` was added by **Amendment A** (below), which also fixes what
`site` contains — the site's identity key id — and records why
`audienceAllow` was never on this list and is now off the schema too.
The rule Amendment A leaves behind, for every field proposed after it:

> **A class the router acts on may travel. Membership never does.**

**Phase 2 — claim, then fetch.** A device claims the stub (audience,
capability and budget checks daemon-side exactly as today). The
upstream tells the site which device claimed. The site then sends the
payload sealed to that device's encryption key.

### Envelopes are signed, then sealed

An earlier draft of this section specified a bare X25519 sealed box.
That was wrong, and wrong in the direction that matters, so the
reasoning is kept rather than quietly corrected.

`crypto_box_seal` is **anonymous-sender by construction**: it derives a
key from an ephemeral pair and discards the secret, so the recipient
can decrypt but learns nothing about who sent it. Both public keys here
are, by definition, public — the upstream distributed them. So **any
holder of a public key can produce an envelope that decrypts cleanly**,
and a relay holds both. The consequences were concrete:

- **Payload leg.** A relay could substitute its own payload for a
  claimed job. The daemon would decrypt it successfully and run it —
  arbitrary prompts injected onto the owner's subscription. That is the
  same class the fixed-argv discipline exists to prevent, arriving
  through the front door instead of the argument vector.
- **Result leg.** Anyone holding the site's public key could forge a
  result for a known job id. `PROVENANCE_NAMES_DEVICE` would carry a
  device key id, but **carrying an id is not proving possession** — an
  id is data, and a forger writes whatever they like.

The earlier draft also attached `AAD` to a sealed box, which
`crypto_box_seal` does not accept; and even given AAD, a forger who
writes the ciphertext also writes the AAD. Authentication cannot be
retrofitted onto an anonymous primitive by adding associated data.

**The construction, corrected.** Every envelope is **signed with the
sender's Ed25519 identity key, then sealed to the recipient's X25519
encryption key.** The signature covers a bound context:

```
signed = Ed25519-Sign(sender_identity_sk,
                      jobId ‖ sender_key_id ‖ recipient_key_id ‖
                      deadlineAt ‖ direction ‖ H(plaintext))
envelope = crypto_box_seal(plaintext ‖ signed, recipient_encryption_pk)
```

The recipient decrypts, then verifies the signature **against the
identity key it pinned at consent**. An envelope that does not verify
is refused, not run.

Three details earn their place:

- **Both key ids are inside the signature**, so an envelope cannot be
  lifted from one recipient and replayed to another, or re-signed by a
  third party claiming authorship.
- **`direction` is inside it**, so a payload envelope can never be
  replayed as a result envelope.
- **Sign-then-encrypt, not encrypt-then-sign.** The signature lives
  *inside* the ciphertext, so a relay never accumulates a
  non-repudiable record of who sent what to whom. Signing the outside
  would hand the relay exactly the attestation trail that `RELAY_BLIND`
  exists to deny it.

Ed25519 signatures also make `PROVENANCE_NAMES_DEVICE` mean something:
a result is attributable to a device by proof of possession, not by a
field anyone can populate.

### 6.1 What the return leg leaves in the clear

A result is sealed the same way, in the other direction. One thing does
not travel inside the envelope: a `disposition` field carrying the
outcome's discriminator — `ok`, `error` or `canceled`.

It is there because a relay has to know a job reached a terminal state,
and whether it failed, or it cannot stop dispatching it and the app can
never be told it may re-enqueue. Collapsing the three into ok/not-ok
was considered and rejected: a cancelled job and a failed one are
different routing outcomes, and a relay that has to guess will guess
wrong somewhere.

The rule that keeps this from becoming a hole: **`disposition` is a
routing hint, never a fact.** The recipient opens the envelope and
compares. A daemon that sealed an error and declared `ok` is refused —
otherwise a field outside the signature would decide what the app
believes happened, which is the whole property this section exists to
establish.

Sealing after the claim rather than before is what makes multi-device
fall out for free: there is no N-device encryption problem because the
payload is only ever sealed once, to whoever actually took the work.

**Replay defence.** Job ids are single-use at both endpoints, and
`deadlineAt` inside the signature bounds how long a captured envelope
is worth keeping.

---

## 7. What two-phase claiming does to the state machine

**Status (2026-08-14): not built, and deliberately so — see §7a.** The
analysis below is correct for the plane it was written about, and the
implementation has not reached that plane yet.

This is the part a design draft can gloss and a protocol spec cannot.
Claim-then-fetch introduces a window that does not exist today: a job
that has been claimed but whose payload has not yet been sealed.

```
queued ──claim──▶ awaiting-payload ──sealed──▶ running ──▶ ok | error
   ▲                    │
   └────────────────────┘  site never seals, or seals too late
```

Three consequences, each of which needs an answer in the frozen spec:

1. **`awaiting-payload` needs its own timeout**, distinct from the
   lease. A site that goes down between claim and seal must not strand
   the job on a daemon that is waiting politely. On expiry the job
   returns to `queued` and may be claimed again.
2. **Payload delivery requires a reachable site — at every claim, not
   only at reclaim.** This was first written as a reclaim-specific
   regression, which framed it wrongly: a first claim needs the site to
   seal just as much as a second one does. So `LEASE_RECLAIMABLE` is
   restated rather than footnoted:

   > A lapsed lease returns the **stub** to the queue with no loss.
   > Payload delivery requires a reachable site at claim time.

   In direct mode the qualifier is vacuous — the site *is* the upstream
   and the store host, so a site that cannot seal is also a site with
   no queue to reclaim from. On a relay plane it is real and bounded:
   §7.1's `awaiting-payload` timeout returns the stub to `queued`, and
   one site's outage pauses that site's jobs and nobody else's.
3. **`TTL_EXPIRY` measures unclaimed time.** It now has two kinds of
   waiting to distinguish. A job in `awaiting-payload` is not
   unclaimed, and treating it as such would expire jobs that are
   progressing normally.

The `NO_RUNNER_SIGNAL` contract is unaffected in shape but gains a
reason: a job can now be blocked on a site that will not seal, which is
neither "no runner" nor "running" and must not report as either.

---

## 7a. Why `awaiting-payload` is not implemented yet

Direct mode seals the payload **at enqueue**, to the site's own key.
The work therefore already exists, sealed, before anyone claims it, and
`fetch` is a synchronous open-and-hand-over.

So the window §7 describes does not exist here. There is no moment when
a site must go away and seal something before a waiting daemon can
proceed — which is the only thing `awaiting-payload` is for.

Building it now would add a state nothing can enter, a timeout nothing
can fire, and a `TTL_EXPIRY` interaction nothing can exercise. That is
worse than leaving it out: unreachable machinery reads as a guarantee,
and the first person to rely on it would be relying on code that has
never run.

**What makes it reachable.** The state is needed the moment a payload
is sealed *to the claiming device* rather than to the site itself,
because the site cannot do that until it knows who claimed. That is:

- a relay plane, where the site and the upstream are different parties.

**That list was longer, and wrong (corrected 2026-08-14).** It also named
re-sealing to the claiming device in direct mode. That work is now
done — the site opens its at-rest envelope and re-seals to the device
at fetch — and it did *not* make the state reachable, because the
re-seal happens inside the fetch request. Nothing waits.

The precise condition is narrower than first written: `awaiting-payload`
is reachable only when **the party that must seal is not the party
answering the fetch.** In direct mode they are the same party and
always will be. It is a relay-plane state, and only that.

## 8. Streaming, reserved but not built

byollm_006 stays parked. What this spec must do is make sure streaming
arrives later as an *addition* rather than a second breaking change.
Three reservations, all in the frozen schema from day one:

1. **A streaming marker in the stub.** Streamed jobs have no size up
   front, so `sizeClass` needs an unbounded value and the stub needs a
   `streaming` flag. Adding a field to a published envelope later is
   the v2 break all over again.
2. **A streamed job still ends in a terminal sealed result.** Deltas
   are ephemeral; the final envelope — full text or digest, token
   counts, provenance — is sealed and stored exactly like a
   non-streamed result. Without this, streaming quietly exits the
   result model and takes `RESULT_IDEMPOTENT`, `RESULT_PROVENANCE` and
   every ledger with it.
3. **The store contract carries a push-capable delivery seam.**
   byollm_006 located streaming's real difficulty at the server→app
   leg: polling cannot carry deltas by construction. If v2 reshapes the
   store as request/response only, streaming forces a *second*
   adapter-breaking reshape. So v2 defines a subscription channel —
   Supabase Realtime implements it natively, the memory reference over
   SSE — even though v1 uses it only for availability and result
   readiness. One reshape, not two.

When streaming does land, the per-job symmetric key is derived at claim
time by X25519 agreement over the already-pinned keys, and deltas are
XChaCha20-Poly1305 frames with a frame counter in the AAD. A relay
forwards opaque frames and sees sizes and timing. Ordering and loss
handling live at the endpoints.

---

## 9. Multi-device, and provenance that names the machine

An account is a set of device keys. Claim-then-fetch makes this
natural: whoever claims is who the payload is sealed to.

`RESULT_PROVENANCE` extends to name **the claiming device and its
relationship to the requester** — `own`, `shared`, or `pool`. A result
that ran on someone else's machine is already marked untrusted; this
says *whose*, which is what a ledger, a trust decision and a debugging
session all actually need.

Two requirements that are trivial now and painful to retrofit:

- **Zero-device accounts must be representable.** A user who never
  installs a daemon still has an identity, for consent and routing.
- **Rosters are not disclosed to sites.** A capability declaration says
  at most "shared, N seats". Who else is in a group is the owner's
  data, and a site learns whether *this* consenting user has reachable
  compute, never who else does. `ROSTER_NOT_DISCLOSED`.

And one that is a disclosure obligation rather than a mechanism:
when a job runs on someone else's machine, **that machine's owner can
see the prompt** — `byollm log` shows every prompt that has run, by
design, and that is not going to change. A consent flow that widens a
user's work onto shared compute must say so in plain language before
the first such job. Disclosed, it is a property. Undisclosed, it is a
betrayal. `SHARED_COMPUTE_DISCLOSED`.

---

## 10. Direct mode: what it gains, and what it does not

Every part of this is adopted by direct mode first, with no relay
anywhere. That is the covenant working, and it is also how the design
gets proven.

**What direct mode gains:**

- **Signed-challenge auth** replacing a bearer token. Strictly better,
  no third party involved.
- **Jobs encrypted at rest, for free.** The site's own store — Supabase,
  Postgres, memory — holds ciphertext. The app sees plaintext at
  enqueue and at result because the app is the endpoint; everything in
  between is sealed. A database backup, a log aggregator, a support
  engineer with read access: none of them see prompts.
- **A version handshake**, so a daemon and a server that disagree say
  so instead of failing obscurely.
- **Key pinning with visible fingerprints**, so a site whose DNS is
  hijacked cannot silently become a different site.

**What direct mode does not gain, stated plainly:** the app can read
its own jobs. It holds the site key; it is the endpoint. Encryption
here protects the payload from *storage and intermediaries*, not from
the application the user deliberately sent it to. Anyone reading "E2E"
as "my app operator cannot see my prompts" has misread it, and this
spec would rather say so than let the acronym do work it cannot.

The distinction only becomes a separation of powers when the upstream
and the endpoint are different parties — which is exactly the case a
relay introduces, and exactly why `RELAY_BLIND` is stated separately in
§11 and verified differently.

---

## 11. New MUSTs

Each carries a verification kind (byollm_011). The distribution is the
point: what conformance can check, it checks; what it cannot, is
labelled rather than implied.

| MUST | Statement | Verified by |
|---|---|---|
| `VERSION_HANDSHAKE_REQUIRED` | No connection is established without an explicit protocol version exchange; a mismatch MUST produce a structured refusal naming the minimum. | conformance |
| `EFFECTIVE_OFFER_ONLY` | A daemon MUST declare effective offers only; an upstream MUST NOT receive raw config, allowlists, or unshared capacity. | conformance |
| `CONSENT_BEFORE_ROUTE` | An upstream MUST NOT route a job to a device without a consent record binding that user, site and scope. | conformance |
| `REVOCATION_IMMEDIATE` | Revocation MUST take effect at the upstream at once, and MUST reach the daemon by its next heartbeat. | conformance |
| `ENVELOPE_SEALED_AND_SIGNED` | Every payload and result MUST be signed by the sender's pinned identity key and sealed to the recipient's encryption key. An endpoint MUST NOT emit plaintext, and MUST refuse any envelope that is unsealed, unsigned, or whose signature does not verify against the pinned identity. | conformance |
| `STUB_METADATA_EXHAUSTIVE` | A stub MUST carry exactly the enumerated fields. An endpoint MUST NOT emit a stub carrying others, and an upstream MUST reject one that does. | conformance |
| `PROVENANCE_NAMES_DEVICE` | A result MUST carry the claiming device key id and its relationship to the requester. | conformance |
| `ROSTER_NOT_DISCLOSED` | A site MUST NOT learn the membership of a group whose compute it uses. | conformance |
| `FALLBACK_LABELED` | Work served by anything other than the user's own compute MUST be labelled as such wherever it is reported, and MUST NOT be silently substituted. | conformance |
| `RELAY_BLIND` | A relay MUST NOT hold any key capable of decrypting a payload, a result, or a delta frame. | **operator** |
| `SHARED_COMPUTE_DISCLOSED` | Before a user's work first runs on compute they do not own, they MUST be told in plain language that the machine's owner can see it. | **operator** |

### On the two operator-kind MUSTs

This is the case byollm_011 built the taxonomy for, and it is worth
being exact rather than reassuring.

`RELAY_BLIND` is **not testable over the wire.** A relay that holds
decryption keys and declines to use them passes every check a relay
that never had them passes. Key non-possession is not observable from
outside.

What *is* testable is decomposed out of it deliberately:
`ENVELOPE_SEALED_AND_SIGNED` says an endpoint never emits plaintext and
refuses anything that does not verify against a pinned identity. That
is conformance-checkable against any implementation, and checkable in
the strong direction: the kit can hand a daemon a well-formed envelope
signed by the *wrong* key and assert it is refused. A relay that
tampers is caught by the endpoints, by construction, in a way a test
can observe. So the checkable half is checked, and `RELAY_BLIND`
covers only the residue: what an operator does with what it receives.

An honest account of what a third party can verify about `RELAY_BLIND`:
the client code is open, the envelope format is published, and the stub
metadata is enumerated — so anyone can confirm that a *correct client*
sends nothing readable. Whether a given relay operator also holds keys
out of band is a question about that operator, answerable by audit or
by source, and by nothing this project ships. It is stated as a MUST
because it is a real obligation. It is labelled `operator` so that
"passes conformance" never silently includes it.

`SHARED_COMPUTE_DISCLOSED` is the same shape for a different reason: a
consent screen's wording is not wire-observable, and a boolean saying
"we disclosed" would be exactly the box-ticking the MUST exists to
prevent.

---

## 12. Threat model

**A hostile or compelled upstream can:** drop jobs, refuse routes,
observe the stub metadata in §6 — user, site, kind, size class,
deadline, streaming flag — observe each job's `disposition` (§6.1), and
observe timing and volume.

`disposition` is a **deliberate** addition to this list, not an
oversight, and it is worth being precise about what it costs. Per-job
outcome is more than a per-job fact in aggregate: an upstream learns
failure rates by site, by user, and by backend, which is real
operational telemetry about somebody else's system. It is here because
a relay that cannot tell `canceled` from `error` cannot tell an app it
may re-enqueue, and §6.1 takes that consumer over the smaller leak.

The rule this is an instance of: the enumerated metadata surface is a
commitment, so a leak we chose is still a leak and belongs on the list.
A deliberate disclosure missing from the disclosure list is how
"exhaustive" quietly stops meaning anything — at which point the
commitment is worth nothing even where it is still accurate.

**It cannot:** read payloads or results; **inject a payload** (an
envelope must verify against the site's pinned identity key, which a
relay does not hold); **forge a result** (same, against the claiming
device's key); forge a claim (claims are signed by a device key it does
not hold); or mint consent (records are displayed and revocable at the
daemon, which pins independently).

The first two of those were **not true of the first draft of this
spec**, which specified anonymous sealed boxes — see §6. They are true
of the construction above, and they are the reason it changed.

**Traffic analysis is not addressed.** Size class and timing are
visible by construction, and padding at this layer is not obviously
worth its cost. Anyone whose threat model includes an upstream
correlating their activity should run direct mode, where there is no
third party to correlate it.

**A compromised device** exposes that device's pinned site keys and any
job sealed to it. It does not expose other devices: keys are per-device
and payloads are sealed to one.

---

## 13. What this breaks

Everything about the job envelope, and the store interface with it.
Taken once, deliberately, while v0 permits it.

- **`workspace`-level:** the store contract reshapes to stub/payload
  separation, plus the subscription seam from §8.3. Both shipped
  adapters change; a third-party adapter must too.
- **Wire:** the claim response carries a stub, not a payload. A fetch
  step is new. Result submission is sealed.
- **Pairing:** device-code pairing gains a key exchange. Existing
  runner tokens do not carry a device key and cannot be upgraded in
  place — **every paired runner must re-pair.**
- **`@byollm/server` API:** `enqueue` is unchanged in shape, which is
  the point. Apps see the same call.

The conformance kit gains the checks above and the hub simulator as a
fixture, so a third-party server can be certified against the new plane
without running one.

---

## 14. Open questions

Named rather than resolved, because resolving them on paper is how a
spec freezes the wrong thing.

0. **`awaiting-payload`, and re-sealing to the claiming device.**
   Deferred together, for the reason in §7a. The state is unreachable
   until the site seals to the device rather than to itself.

1. ~~Reclaim without a reachable site.~~ **Resolved 2026-08-13:
   accepted, and the promise rewritten (§7.2).**

   The old property is not preservable under end-to-end encryption, and
   that is arithmetic rather than a design shortfall. Letting a new
   claimant decrypt without the site being reachable requires *someone
   other than the site* to hold decryption capability: escrow at the
   relay, which breaks `RELAY_BLIND`, or pre-sealing to every device,
   which leaks the payload to non-claimants and abandons the
   sealed-to-the-claimant model that makes multi-device free.

   A re-seal queue does not restore it either — it automates the
   re-seal once the site returns, but the job still cannot run during
   the outage. So the real choice was never "accept vs preserve"; it
   was **accept, versus accept plus machinery that pretends
   otherwise.** Machinery that implies a guarantee it does not deliver
   is worse than the honest sentence.

   Revisit only if skeleton telemetry shows claim-during-site-outage is
   actually frequent.
2. **Sealed box per job vs a Noise-XX session per site↔device pair.**
   Sealed boxes are simpler and stateless; a session is cheaper at
   volume. Start sealed-box, measure, revisit — but the envelope must
   not make the second impossible.
3. **Metadata minimisation.** Size-class buckets vs exact sizes;
   whether timing padding buys anything real.
4. **Post-quantum.** Hybrid X25519+ML-KEM sealed boxes when
   libsodium's story settles. Designed as a swap, not a redesign.
5. **Per-frame deadline semantics** for streaming, owned jointly with
   byollm_006.

---

## 15. Freeze condition, and Done when

**This spec does not freeze on review.** It freezes when a job has
round-tripped end to end through a real implementation of it: real
daemon, real `@byollm/server`, sealed envelope, signed claim. The
prove-in-a-real-consumer rule, applied to ourselves.

Done when: direct mode has adopted sessions, keys and envelope v2 in
full, with no relay involved; every `conformance`-kind MUST above has a
check, mutation-verified per `packages/conformance/MUTATIONS.md` —
including one that hands an endpoint an envelope signed by the wrong
key and asserts refusal, since the injection path in §6 is the most
expensive thing this spec fixes and a check that only tests the happy
path would not have caught it; the
two `operator`-kind MUSTs are labelled as such in the registry and in
the certification report; revocation is observed to kill routing within
one heartbeat; a store adapter that has not implemented the
subscription seam fails the kit rather than passing quietly; and
`docs/security.md` carries §12's threat model including what an
upstream can see, stated as a list rather than a reassurance.

---

# Amendment A — the stub's enumerated list (RATIFIED)

**Status: RATIFIED 2026-08-18 by Todd and Cowork, drafted by CC. Read
before ratification per cloud_009 §4.1 and cloud_001's "Governance — slow
by design", which makes the default answer *not yet*. This amendment is
in force; §6's enumerated list is amended as below.**

§6 declares the stub's field list "exhaustive and normative… what an
upstream can see, stated as a commitment rather than left as an accident
of implementation." Three things have drifted from it, in both
directions, and the drift is why this is one amendment rather than three
fixes.

## A.1 `audience` joins the list

The schema has always carried it; §6 never named it. It is **not** an
accident of implementation and should not be removed: the relay narrows
on it, and Tier 2.1 makes that narrowing correct (today a roster
member's `self` job is offered to the owner's daemon and ping-pongs).
A routing party that acts on a field is the definition of metadata this
list is for.

The rule that settles this and the next one, and which should decide
every future field:

> **A class the router acts on may travel. Membership never does.**

`audience` is a class — self, named, public. It says what *kind* of
routing decision this job is, and the router makes that decision.

## A.2 `audienceAllow` leaves, and cannot come back

A list of *which people* may run the job. It was on the schema, never on
§6's list, and travelled to every routing party on every `named` job.

byollm_001 Rev 1 §B settled who decides `named` before this spec
existed: *the daemon's own list decides, not the server's.*
`allowlist.predicateFor(origin)` is the enforcement in both lanes. So
this field was a second answer to a question the daemon already owned —
able only to agree, in which case it was redundant, or to disagree, in
which case nothing was written down about which wins.

It is membership, and it is gone (cloud_008 §0.2, shipped in alpha.14).
`JobStub.strict()` is what keeps it gone, and `stub.test.ts` now refuses
it by name. **`ROSTER_NOT_DISCLOSED` holds on this path by absence**,
which is the strongest way for a MUST to hold: there is no field to
leak, so there is no check to get wrong.

## A.3 `site` gains a schema field — and the open question

§6's list already reads `{ jobId, user, site, kind, sizeClass,
deadlineAt, streaming }`. The schema has no `site`. This half is a
conformance fix, not protocol evolution: the spec has said it since it
was frozen.

It is also what cloud_009 stands on. A daemon serving two sites needs a
pinned key per site and must know which site each claimed job came from;
it cannot, and the failure is silent — it would verify a payload from
site B against site A's key, fail to open it, and report what looks like
a corrupt envelope.

**What `site` contains: the site's identity key id.** Ratified. Two
candidates were weighed:

| | **the site's identity key id** | **an opaque relay-assigned id** |
| --- | --- | --- |
| daemon's lookup | direct, into the map pairing built | direct, same |
| verifiable locally? | **yes** — the payload envelope's `senderKeyId` must equal it | no; the daemon takes the relay's word for which site this is |
| namespaces | one: the id *is* the key's id | two: a control-plane UUID beside a key id |
| what a hostile relay can do | claim site A and seal as B → the daemon can *notice*, not merely fail | claim site A and seal as B → the daemon fails to open and reports a corrupt envelope |
| direct plane | works unchanged: a site knows its own key id | needs an id a direct site does not have |

The ruling is **the key id**, on three grounds: it is
self-describing, so nothing has to distribute a registry; it makes the
stub's claim checkable against the envelope rather than trusted; and it
avoids inventing a second namespace, which is the shape of cloud_008
finding 41 (two owner namespaces compared for equality) and of finding
fourteen before it.

### A.3.1 Rotation, which the key id makes a designed transition

The objection to the key id is real and is answered here rather than
left as a table row: a key id changes when a site rotates its identity
key, so a daemon's pinned map is re-keyed rather than merely updated.

**Site key rotation is a first-class event, on the mechanism §3 already
establishes.** §3 pins an identity key and requires the encryption key
to be signed by it. Rotation extends that one link into a chain:

- A site publishes a new identity key **signed by the outgoing one**.
- Both keys are valid through an **overlap window**. Stubs may name
  either; a daemon accepts a payload sealed under either.
- Consents and pins migrate **by that signature**, not by an
  administrator's assertion: a daemon presented with a new key id and a
  signature from a key it already pinned can re-key its own map without
  asking anyone, because the old key vouched for the new one.
- After the window, only the new key id appears.

This is the same trust step the daemon already performs at pairing —
verify a signature against a key it holds — applied to the site's own
succession. It turns "the map's keys move" from a cost into a
transition somebody designed, and it is strictly stronger than an
opaque id, under which a rotation is invisible to the daemon and
therefore unverifiable by it.

The rotation flow itself is not specified here beyond this shape; it is
the natural home of a later revision, and nothing in cloud_009 depends
on it existing first.

## A.4 What §12 does and does not gain

Nothing. §12 enumerates what a hostile upstream observes, and a relay
already knows which site it is routing for — routing *is* that
knowledge. `audience` likewise: the relay acts on it, so it observes it
by construction.

The list §12 carries gets **shorter**, because `audienceAllow` was on
the wire and is not enumerated anywhere. That is the honest direction
for a threat model to move.

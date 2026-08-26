import { cryptoReady, generateKeys, publicIdentityOf } from "@byollm/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Relay, RelayState } from "../src/index.js";
import { fixtureFor, makeDaemon } from "./harness.js";

/**
 * Presence is written by the heartbeat — cloud_009, 2026-08-24.
 *
 * It was not, and that is the point of this file. `seen()` was called from the
 * two pairing paths and nowhere else, so a machine's record was stamped once
 * when it paired and never touched again.
 *
 * Two things rested on it and both were quietly wrong. `lastSeenAt` is read as
 * liveness — by the debug page, and by the `/devices` endpoint a machines page
 * is about to be built on — and it was reporting the pairing time under that
 * name. And in the hub, presence is a Valkey hash with a one-hour TTL whose
 * own comment says it is "refreshed on every heartbeat": nothing refreshed it,
 * so an hour after pairing the record expired, and `#authed` answers a request
 * from an unknown runner with `401 this runner is not recognised`. A machine
 * stopped working an hour after somebody set it up.
 *
 * Nothing caught it because the memory store has no TTL and every round trip
 * pairs a fresh device and finishes in seconds — the check never lived long
 * enough to experience the failure.
 */

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers) await dispose();
  disposers = [];
});

beforeAll(async () => {
  await cryptoReady();
});

describe("a daemon that has only ever heartbeat", () => {
  it("keeps its presence record fresh, and says what it can run", async () => {
    // Near real time: the daemon signs with its own `Date.now()` and the
    // relay refuses a signature too far from its clock, so a fixed epoch here
    // would test the skew check instead of presence.
    let clock = Date.now();
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    const relay = new Relay({ fixture, now: () => clock });
    const daemon = await makeDaemon(relay, fixture, {
      owner: "alice",
      site,
      offer: "private",
    });
    disposers.push(daemon.dispose);

    const atPairing = await relay.state.presence(daemon.runnerId);
    expect(atPairing).toBeDefined();
    // Read out as a number, not held as a record. The memory store hands back
    // its live object, so keeping the reference would compare the value to
    // itself after the beat mutates it — and the comparison would pass for
    // the bug as readily as for the fix.
    const pairedAt = atPairing!.lastSeenAt;

    // Time passes. Seconds rather than the hour the hub's TTL cares about,
    // because the daemon's signature must stay inside the skew window — the
    // movement is the property; the duration is the store's business.
    clock += 2_000;

    const beat = await daemon.signedFetch("heartbeat", {
      runnerId: daemon.runnerId,
      daemonVersion: "test",
      capabilities: await daemon.runner.detectCapabilities(),
      activeLeases: [],
      paused: false,
    });
    expect(beat.status).toBe(200);

    const after = await relay.state.presence(daemon.runnerId);
    // The record moved. Before this, an hour-old daemon's record was an
    // hour old — and in the hub it was gone.
    expect(after?.lastSeenAt).toBe(clock);
    expect(after?.lastSeenAt).toBeGreaterThan(pairedAt);

    // And it carries what the machine advertised on that same beat, which is
    // the whole reason capabilities belong on presence rather than beside it.
    expect(after?.capabilities.length).toBeGreaterThan(0);
    expect(after?.capabilities.every((row) => row.model.length > 0)).toBe(true);
  });

  it("survives the store losing every record", async () => {
    // **The outage this replaces.** The hub keeps presence in Valkey with
    // persistence disabled and no volume, so a reschedule drops every record
    // at once. Presence was the gate, so every daemon alive was told
    // `this runner is not recognised` until a human re-paired it — one
    // machine at a time, for a cache miss.
    //
    // Who a runner is lives in the projection, put there by a person
    // comparing a fingerprint. A miss is repaired from there.
    let clock = Date.now();
    const siteKeys = generateKeys(Date.now() + 2);
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    // The store is held directly here: `relay.state` is the `RoutingStore`
    // interface, and losing a record on purpose is an implementation's
    // business rather than something the contract should offer.
    const store = new RelayState({ now: () => clock });
    const relay = new Relay({ fixture, store, now: () => clock });
    const daemon = await makeDaemon(relay, fixture, {
      owner: "alice",
      site,
      offer: "private",
    });
    disposers.push(daemon.dispose);

    // Everything the store held, gone — a reschedule, in one line.
    await store.dropPresenceForTests(daemon.runnerId);
    expect(await store.presence(daemon.runnerId)).toBeUndefined();

    clock += 2_000;
    const beat = await daemon.signedFetch("heartbeat", {
      runnerId: daemon.runnerId,
      daemonVersion: "test",
      capabilities: await daemon.runner.detectCapabilities(),
      activeLeases: [],
      paused: false,
    });

    // Not a 401. The machine is approved, it signed with the key that was
    // approved, and nothing about a lost cache changes either fact.
    expect(beat.status).toBe(200);
    expect(await store.presence(daemon.runnerId)).toBeDefined();
  });

  it("repairs the record on a claim, which never writes presence itself", async () => {
    // The heartbeat records presence on its own, so it would recover with or
    // without the repair. `claim` does not — and a daemon whose store blipped
    // between beats claims constantly. This is the case that proves the
    // repair is a repair rather than a coincidence.
    const clock = Date.now();
    const siteKeys = generateKeys(Date.now() + 4);
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    const store = new RelayState({ now: () => clock });
    const relay = new Relay({ fixture, store, now: () => clock });
    const daemon = await makeDaemon(relay, fixture, {
      owner: "alice",
      site,
      offer: "private",
    });
    disposers.push(daemon.dispose);

    await store.dropPresenceForTests(daemon.runnerId);

    const claim = await daemon.signedFetch("claim", {
      runnerId: daemon.runnerId,
      capabilities: await daemon.runner.detectCapabilities(),
      max: 1,
    });
    expect(claim.status).toBe(200);
    expect(await store.presence(daemon.runnerId)).toBeDefined();
  });

  it("does not restore a record on a signature it could not verify", async () => {
    // **The ordering is the safety argument.** Repairing before the signature
    // is checked would let anybody who knows a runner id repopulate presence
    // for a machine whose keys they do not hold.
    const clock = Date.now();
    const siteKeys = generateKeys(Date.now() + 5);
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    const store = new RelayState({ now: () => clock });
    const relay = new Relay({ fixture, store, now: () => clock });
    const daemon = await makeDaemon(relay, fixture, {
      owner: "alice",
      site,
      offer: "private",
    });
    disposers.push(daemon.dispose);

    await store.dropPresenceForTests(daemon.runnerId);

    const forged = await relay.handle(
      new Request("http://relay.test/byollm/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // A runner the projection *does* know — so the repair path is
          // reached — with a signature nobody could have produced.
          "x-byollm-runner": daemon.runnerId,
          "x-byollm-issued-at": String(clock),
          "x-byollm-signature": "forged",
        },
        body: JSON.stringify({
          protocolVersion: "0",
          runnerId: daemon.runnerId,
          capabilities: [],
          max: 1,
        }),
      }),
    );

    expect(forged.status).toBe(401);
    // Nothing was written. The cache is still empty, and the forger has not
    // created a record for a machine they cannot sign for.
    expect(await store.presence(daemon.runnerId)).toBeUndefined();
  });

  it("still refuses a runner no human ever approved", async () => {
    // The refusal that must survive: repairing a cache miss from the
    // projection is not the same as trusting whoever names a runner id.
    //
    // Built by hand rather than through the harness, which signs as the
    // daemon it made. No real key is needed — the projection is asked who
    // this runner is *before* the signature is checked, so an id nobody
    // approved is refused without the question ever reaching cryptography.
    const clock = Date.now();
    const siteKeys = generateKeys(Date.now() + 3);
    const site = publicIdentityOf(siteKeys);
    const relay = new Relay({ fixture: fixtureFor(site), now: () => clock });

    const body = JSON.stringify({
      protocolVersion: "0",
      runnerId: "runner_nobody_approved",
      daemonVersion: "test",
      capabilities: [],
      activeLeases: [],
      paused: false,
    });
    const stranger = await relay.handle(
      new Request("http://relay.test/byollm/heartbeat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-byollm-runner": "runner_nobody_approved",
          "x-byollm-issued-at": String(clock),
          "x-byollm-signature": "not-a-real-signature",
        },
        body,
      }),
    );

    expect(stranger.status).toBe(401);
    expect(await stranger.json()).toMatchObject({
      message: "this runner is not recognised",
    });
  });

  it("forgets a backend the machine has lost", async () => {
    // The matrix is replaced, not merged. A relay that kept the union would
    // go on advertising a model the daemon can no longer serve, and work
    // would route to it — worse than forgetting one it still has.
    let clock = Date.now();
    const siteKeys = generateKeys(Date.now() + 1);
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    const relay = new Relay({ fixture, now: () => clock });
    const daemon = await makeDaemon(relay, fixture, {
      owner: "alice",
      site,
      offer: "private",
    });
    disposers.push(daemon.dispose);

    const full = await daemon.runner.detectCapabilities();
    await daemon.signedFetch("heartbeat", {
      runnerId: daemon.runnerId,
      daemonVersion: "test",
      capabilities: full,
      activeLeases: [],
      paused: false,
    });
    expect((await relay.state.presence(daemon.runnerId))?.capabilities).toEqual(
      full,
    );

    clock += 5_000;
    await daemon.signedFetch("heartbeat", {
      runnerId: daemon.runnerId,
      daemonVersion: "test",
      capabilities: [],
      activeLeases: [],
      paused: false,
    });

    // Empty is an answer: a paired machine whose backend died, which is the
    // state connect-first exists to show rather than refuse.
    expect((await relay.state.presence(daemon.runnerId))?.capabilities).toEqual(
      [],
    );
  });
});

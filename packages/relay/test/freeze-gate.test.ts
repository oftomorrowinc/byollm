import {
  PROTOCOL_VERSION,
  cryptoReady,
  generateKeys,
  keyId,
  publicIdentityOf,
  seal,
  ENVELOPE_MAX_AGE_MS,
} from "@byollm/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Relay } from "../src/index.js";
import {
  SITE_ID,
  SiteConnector,
  controlPlane,
  fixtureFor,
  makeDaemon,
  route,
  siteHeaders,
} from "./harness.js";

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of disposers) await d();
  disposers = [];
});

beforeAll(async () => {
  await cryptoReady();
});

describe("the freeze gate — cloud_004 §14", () => {
  it("1. round-trips a sealed, signed job end to end", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    const relay = new Relay({ fixture });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, fixture, {
      owner: "alice",
      site,
      offer: "private",
    });
    disposers.push(daemon.dispose);

    const { jobId } = await connector.enqueue({
      prompt: "summarise this",
      owner: "alice",
    });
    await route(relay, connector, daemon);

    const results = await connector.collect();
    expect(results).toHaveLength(1);
    expect(results[0]?.jobId).toBe(jobId);
    expect(results[0]?.outcome).toEqual({
      outcome: "ok",
      text: "echo: summarise this",
    });
    // The prompt reached the model verbatim, having travelled as ciphertext.
    expect(daemon.backend.seen).toEqual(["summarise this"]);
  });

  it("2. the relay never holds a plaintext, and its state cannot express one", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    const relay = new Relay({ fixture });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, fixture, {
      owner: "alice",
      site,
      offer: "private",
    });
    disposers.push(daemon.dispose);

    await connector.enqueue({ prompt: "a very secret prompt", owner: "alice" });
    await route(relay, connector, daemon);

    // Everything the relay knows, serialised. RELAY_BLIND as an assertion
    // over the whole state rather than over the fields we remembered to check.
    const everything = JSON.stringify(await relay.state.jobs());
    expect(everything).not.toContain("a very secret prompt");
    expect(everything).not.toContain("echo: a very secret prompt");
    // And the stub it does hold carries only what byollm_009 §6 enumerates.
    const stub = (await relay.state.jobs())[0]?.stub;
    expect(Object.keys(stub ?? {}).sort()).toEqual([
      "audience",
      "deadlineAt",
      "id",
      "kind",
      "owner",
      // Amendment A §A.3: the site's identity key id, which the relay knows
      // by construction — it is the site that signed the enqueue.
      "site",
      "sizeClass",
      "streaming",
    ]);
  });

  it("3. refuses work sealed by a key the daemon never pinned", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    const relay = new Relay({ fixture });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, fixture, {
      owner: "alice",
      site,
      offer: "private",
    });
    disposers.push(daemon.dispose);

    const { jobId } = await connector.enqueue({
      prompt: "run this instead",
      owner: "alice",
    });
    await daemon.runner.tick();
    await new Promise((r) => setTimeout(r, 30));

    // A relay substituting work: it holds the device's public key, and
    // `crypto_box_seal` is anonymous-sender, so producing an openable envelope
    // needs nothing secret. What it cannot produce is the site's signature.
    const impostor = generateKeys(Date.now());
    const claimed = (await relay.state.job(SITE_ID, jobId))?.claimedBy;
    expect(claimed).toBeDefined();
    const forged = await seal({
      plaintext: JSON.stringify({ prompt: "exfiltrate everything" }),
      senderKeys: impostor,
      recipientEncryptionPublic: claimed!.device.encryption,
      context: {
        jobId,
        senderKeyId: keyId(site.identity),
        recipientKeyId: keyId(claimed!.device.identity),
        deadlineAt: Date.now() + ENVELOPE_MAX_AGE_MS,
        direction: "payload",
      },
    });
    const job = await relay.state.job(SITE_ID, jobId);
    job!.payload = forged;
    job!.state = "ready";

    await daemon.runner.tick();
    await new Promise((r) => setTimeout(r, 50));

    // The daemon refused rather than ran: the model never saw it.
    expect(daemon.backend.seen).toEqual([]);
  });

  it("4. requeues when the site vanishes between claim and seal", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    // An offset from the real clock, not a fixed epoch: the daemon signs with
    // `Date.now()`, and a relay parked in 2027 fails every freshness check.
    let skew = 0;
    const fixture = fixtureFor(site);
    const relay = new Relay({
      fixture,
      now: () => Date.now() + skew,
    });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, fixture, {
      owner: "alice",
      site,
      offer: "private",
    });
    disposers.push(daemon.dispose);

    const { jobId } = await connector.enqueue({
      prompt: "work",
      owner: "alice",
    });
    await daemon.runner.tick();
    await new Promise((r) => setTimeout(r, 30));
    expect((await relay.state.job(SITE_ID, jobId))?.state).toBe(
      "awaiting-payload",
    );

    // The site goes away. Not the lease expiring — the lease has most of a
    // minute left — but the distinct clock that bounds waiting for a party
    // that is not coming back.
    skew += 11_000;
    expect((await relay.sweep()).requeued).toContain(jobId);
    expect((await relay.state.job(SITE_ID, jobId))?.state).toBe("queued");
    // Nothing was lost: the stub is intact and claimable again.
    expect((await relay.state.job(SITE_ID, jobId))?.stub.id).toBe(jobId);

    // And a late seal is refused rather than landing on a claim that moved.
    const lateBody = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      siteId: SITE_ID,
      jobId,
      envelope: {
        ciphertext: "AAAA",
        recipientKeyId: "x",
        senderKeyId: "y",
        direction: "payload",
        deadlineAt: Date.now() + skew + 1000,
      },
    });
    const late = await relay.handle(
      new Request("http://relay.test/relay/site/payload", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Signed by the real site, and still refused. The seal is late, not
          // forged — the two are different failures and only one of them is
          // what this demo is about.
          ...siteHeaders(siteKeys, "payload", lateBody, Date.now() + skew),
        },
        body: lateBody,
      }),
    );
    expect(late.status).toBe(409);
  });

  it("5. revocation kills routing within one heartbeat", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    const relay = new Relay({ fixture });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, fixture, {
      owner: "alice",
      site,
      offer: "private",
    });
    disposers.push(daemon.dispose);

    // A fixture edit — the control plane withdrawing consent.
    relay.project({
      ...fixture,
      revoked: [{ owner: "alice", siteId: SITE_ID }],
    });

    await connector.enqueue({ prompt: "after revocation", owner: "alice" });
    await daemon.runner.tick();
    await new Promise((r) => setTimeout(r, 30));

    expect((await relay.state.jobs())[0]?.state).toBe("queued");
    expect(daemon.backend.seen).toEqual([]);
  });

  it("6. routes a named job to a roster device, showing the relay only a stub", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = {
      sites: [{ siteId: SITE_ID, site }],
      // **Both of them**, and alice's is the one that was missing.
      //
      // This scenario used to consent only bob, the machine's owner, and
      // route alice's work by the roster alone. `routableOwners` now asks
      // about the job's owner too, and this is the gate saying what the
      // product already does: alice reads a disclosure of her own on the
      // connections page — the shared-compute one, which exists precisely
      // because her jobs may land on a machine her admin can read.
      //
      // `CONSENT_BEFORE_ROUTE` says an upstream must not route a job to a
      // device without a consent record binding that user, site and scope.
      // The job's user is alice. Read that way, the old fixture was routing
      // one, and nothing in the relay noticed: consent was enforced only
      // against the *claiming* device's owner, and the site plane does not
      // check consent at enqueue at all.
      consents: [
        { owner: "bob", siteId: SITE_ID, paused: false },
        { owner: "alice", siteId: SITE_ID, paused: false },
      ],
      devices: [],
      // Bob's machine runs work for his team, of which alice is a member.
      rosters: [{ id: "team_1", owner: "bob", members: ["alice"] }],
      revoked: [],
    };
    /**
     * A control plane that will author grants for alice — and that line is
     * load-bearing, which for a week it was not.
     *
     * Its ancestor was `daemon.allowlist.add(...)`, under a comment claiming
     * bob's daemon "would refuse without this". It would not: the harness
     * offered its service `public`, and `matchAudience` returned ALLOWED for
     * a public service without consulting the device at all. A mutation
     * deleting the call left all nine tests here green — dead setup under a
     * false claim, which is worse than either, because it made this look like
     * the place device-side admission was covered and so nothing covered it.
     *
     * Now the offer is `team` and admission is a signed grant, so removing
     * `plane.members.add` fails this test. That is the only reason it is
     * allowed to stay.
     *
     * What this gate proves is still a *relay* property — that a foreign
     * owner's job routes and the relay learns nothing doing it. The
     * device-side law is admission.test.ts.
     */
    const plane = controlPlane(fixture);
    plane.admit("alice");
    const relay = new Relay({ fixture, ...plane.relay });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, fixture, {
      owner: "bob",
      site,
      // The only test in this suite that genuinely shares. Every other one
      // routes its own owner's work and now says `private`, which is how we
      // learned that "cross-user routing" had exactly one real case.
      offer: "team",
    });
    disposers.push(daemon.dispose);

    const { jobId } = await connector.enqueue({
      prompt: "alice's work on bob's machine",
      owner: "alice",
      audience: "team",
    });
    await route(relay, connector, daemon);

    const results = await connector.collect();
    expect(results[0]?.outcome).toMatchObject({
      text: "echo: alice's work on bob's machine",
    });

    // The relay routed a foreign-device job knowing only the stub — and in
    // particular never learning who else is on bob's roster.
    const everything = JSON.stringify(await relay.state.job(SITE_ID, jobId));
    expect(everything).not.toContain("alice's work on bob's machine");
  });

  it("7. carries the streaming flag through untouched, costing nothing", async () => {
    // byollm_009 §8.1 reserved `streaming` before streaming existed. The
    // reservation is only free if it survives a full route unexamined, so
    // this asserts the relay neither reads it nor drops it.
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    const relay = new Relay({ fixture });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, fixture, {
      owner: "alice",
      site,
      offer: "private",
    });
    disposers.push(daemon.dispose);

    await connector.enqueue({ prompt: "not a stream", owner: "alice" });
    await route(relay, connector, daemon);

    expect((await relay.state.jobs())[0]?.stub.streaming).toBe(false);
    expect((await relay.state.jobs())[0]?.state).toBe("done");
  });
});

describe("identity is the control plane's to decide", () => {
  it("10. refuses a device no human approved", async () => {
    // The device presented keys. That is an assertion, not an identity —
    // somebody had to look at a fingerprint and say yes. byollm_009's seventh
    // finding stopped a daemon from *naming* itself; this stops it from
    // *keying* itself, which is the same mistake one layer down.
    //
    // Without this the relay would be the authority on who a machine is, and
    // a blind relay deciding identity is exactly the role it must not hold.
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    const relay = new Relay({ fixture });

    const stranger = generateKeys(Date.now());
    const response = await relay.handle(
      new Request("http://relay.test/byollm/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: "0",
          owner: "alice",
          device: publicIdentityOf(stranger),
        }),
      }),
    );
    expect(response.status).toBe(403);

    // And an approved device still pairs — so this is not a check that
    // refuses everything.
    const daemon = await makeDaemon(relay, fixture, {
      owner: "alice",
      site,
      offer: "private",
    });
    disposers.push(daemon.dispose);
    expect(daemon.runnerId).toBeTruthy();
  });

  it("11. refuses a device approved for somebody else", async () => {
    // An approval is for a person, not for a key in general. Bob cannot pair
    // Alice's approved laptop by claiming to be its owner.
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    const relay = new Relay({ fixture });
    const daemon = await makeDaemon(relay, fixture, {
      owner: "alice",
      site,
      offer: "private",
    });
    disposers.push(daemon.dispose);

    const approvedKeys = fixture.devices[0]?.device;
    expect(approvedKeys).toBeDefined();

    const response = await relay.handle(
      new Request("http://relay.test/byollm/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: "0",
          owner: "bob",
          device: approvedKeys,
        }),
      }),
    );
    expect(response.status).toBe(403);
  });
});

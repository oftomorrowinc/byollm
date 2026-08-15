import {
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
  fixtureFor,
  makeDaemon,
  route,
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
    const relay = new Relay({ siteId: SITE_ID, fixture: fixtureFor(site) });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, {
      owner: "alice",
      site,
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
    const relay = new Relay({ siteId: SITE_ID, fixture: fixtureFor(site) });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, {
      owner: "alice",
      site,
    });
    disposers.push(daemon.dispose);

    await connector.enqueue({ prompt: "a very secret prompt", owner: "alice" });
    await route(relay, connector, daemon);

    // Everything the relay knows, serialised. RELAY_BLIND as an assertion
    // over the whole state rather than over the fields we remembered to check.
    const everything = JSON.stringify(relay.state.jobs());
    expect(everything).not.toContain("a very secret prompt");
    expect(everything).not.toContain("echo: a very secret prompt");
    // And the stub it does hold carries only what byollm_009 §6 enumerates.
    const stub = relay.state.jobs()[0]?.stub;
    expect(Object.keys(stub ?? {}).sort()).toEqual([
      "audience",
      "deadlineAt",
      "id",
      "kind",
      "owner",
      "sizeClass",
      "streaming",
    ]);
  });

  it("3. refuses work sealed by a key the daemon never pinned", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const relay = new Relay({ siteId: SITE_ID, fixture: fixtureFor(site) });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, {
      owner: "alice",
      site,
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
    const claimed = relay.state.job(jobId)?.claimedBy;
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
    const job = relay.state.job(jobId);
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
    const relay = new Relay({
      siteId: SITE_ID,
      fixture: fixtureFor(site),
      now: () => Date.now() + skew,
    });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, {
      owner: "alice",
      site,
    });
    disposers.push(daemon.dispose);

    const { jobId } = await connector.enqueue({
      prompt: "work",
      owner: "alice",
    });
    await daemon.runner.tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(relay.state.job(jobId)?.state).toBe("awaiting-payload");

    // The site goes away. Not the lease expiring — the lease has most of a
    // minute left — but the distinct clock that bounds waiting for a party
    // that is not coming back.
    skew += 11_000;
    expect(relay.sweep().requeued).toContain(jobId);
    expect(relay.state.job(jobId)?.state).toBe("queued");
    // Nothing was lost: the stub is intact and claimable again.
    expect(relay.state.job(jobId)?.stub.id).toBe(jobId);

    // And a late seal is refused rather than landing on a claim that moved.
    const late = await relay.handle(
      new Request("http://relay.test/relay/site/payload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          siteId: SITE_ID,
          jobId,
          envelope: {
            ciphertext: "AAAA",
            recipientKeyId: "x",
            senderKeyId: "y",
            direction: "payload",
            deadlineAt: Date.now() + skew + 1000,
          },
        }),
      }),
    );
    expect(late.status).toBe(409);
  });

  it("5. revocation kills routing within one heartbeat", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const relay = new Relay({ siteId: SITE_ID, fixture: fixtureFor(site) });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, {
      owner: "alice",
      site,
    });
    disposers.push(daemon.dispose);

    // A fixture edit — the control plane withdrawing consent.
    relay.project(fixtureFor(site, { revoked: [`alice:${SITE_ID}`] }));

    await connector.enqueue({ prompt: "after revocation", owner: "alice" });
    await daemon.runner.tick();
    await new Promise((r) => setTimeout(r, 30));

    expect(relay.state.jobs()[0]?.state).toBe("queued");
    expect(daemon.backend.seen).toEqual([]);
  });

  it("6. routes a named job to a roster device, showing the relay only a stub", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const relay = new Relay({
      siteId: SITE_ID,
      fixture: {
        consents: [{ owner: "bob", siteId: SITE_ID, site }],
        // Bob's machine runs work for his team, of which alice is a member.
        rosters: [{ id: "team_1", owner: "bob", members: ["alice"] }],
        revoked: [],
      },
    });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, {
      owner: "bob",
      site,
    });
    disposers.push(daemon.dispose);
    // AUDIENCE_BOTH_SIDES: the relay's roster is not enough — bob's daemon
    // keeps its own list and would refuse without this.
    await daemon.allowlist.add(
      { origin: "http://relay.test", owner: "alice" },
      Date.now(),
    );

    const { jobId } = await connector.enqueue({
      prompt: "alice's work on bob's machine",
      owner: "alice",
      audience: "named",
      audienceAllow: ["bob"],
    });
    await route(relay, connector, daemon);

    const results = await connector.collect();
    expect(results[0]?.outcome).toMatchObject({
      text: "echo: alice's work on bob's machine",
    });

    // The relay routed a foreign-device job knowing only the stub — and in
    // particular never learning who else is on bob's roster.
    const everything = JSON.stringify(relay.state.job(jobId));
    expect(everything).not.toContain("alice's work on bob's machine");
  });

  it("7. carries the streaming flag through untouched, costing nothing", async () => {
    // byollm_009 §8.1 reserved `streaming` before streaming existed. The
    // reservation is only free if it survives a full route unexamined, so
    // this asserts the relay neither reads it nor drops it.
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const relay = new Relay({ siteId: SITE_ID, fixture: fixtureFor(site) });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, {
      owner: "alice",
      site,
    });
    disposers.push(daemon.dispose);

    await connector.enqueue({ prompt: "not a stream", owner: "alice" });
    await route(relay, connector, daemon);

    expect(relay.state.jobs()[0]?.stub.streaming).toBe(false);
    expect(relay.state.jobs()[0]?.state).toBe("done");
  });
});

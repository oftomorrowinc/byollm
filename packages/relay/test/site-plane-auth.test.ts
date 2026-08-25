import {
  PROTOCOL_VERSION,
  generateKeys,
  publicIdentityOf,
  signRequest,
  signSiteRequest,
  type JobStub,
} from "@byollm/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Relay } from "../src/index.js";
import {
  SITE_ID,
  SiteConnector,
  fixtureFor,
  makeDaemon,
  siteHeaders,
} from "./harness.js";

/**
 * The site plane's authentication — the ninth finding.
 *
 * Found by reading this code in preparation for the first public deploy, not
 * by any test: every site-plane endpoint took the `siteId` in a body or query
 * at its word. On a relay reachable from the internet that is an open enqueue
 * endpoint into consenting users' machines, an open metadata read of who is
 * online, and a way to burn a claimed job by substituting an envelope its
 * daemon will refuse.
 *
 * `RELAY_BLIND` held the whole time. Nothing here could open a payload. The
 * lesson is that blind is not the same as safe, and that the freeze gate
 * proved the *protocol* while leaving the plane it runs over untested — eight
 * findings against a relay nobody could reach.
 *
 * Every test below fails if the corresponding check is removed.
 */

const stubFor = (jobId: string, site = "BYOLLM-TEST-SITE-KEY-ID"): JobStub => ({
  id: jobId,
  kind: "llm.generate",
  owner: "alice",
  site,
  audience: "private",
  sizeClass: "small",
  streaming: false,
  deadlineAt: Date.now() + 300_000,
});

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers) await dispose();
  disposers = [];
});

describe("the site plane refuses anyone it cannot verify", () => {
  beforeAll(async () => {
    const { cryptoReady } = await import("@byollm/protocol");
    await cryptoReady();
  });

  const setup = () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    const relay = new Relay({ fixture });
    return { siteKeys, site, fixture, relay };
  };

  const post = (relay: Relay, endpoint: string, body: unknown, headers = {}) =>
    relay.handle(
      new Request(`http://relay.test/relay/site/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        // A well-formed request in every respect but the one under test:
        // the version check runs before authentication (§B.4, and byollm_009
        // §4's "version before anything else"), so a request omitting it is
        // refused for the wrong reason and proves nothing about signatures.
        body: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          ...(body as Record<string, unknown>),
        }),
      }),
    );

  it("refuses an unsigned enqueue", async () => {
    const { relay } = setup();
    const response = await post(relay, "enqueue", {
      siteId: SITE_ID,
      stub: stubFor("job_anon"),
    });
    expect(response.status).toBe(401);
    // And nothing was routed: a refusal that still queued the work would be
    // an audit-log entry rather than a control.
    expect(await relay.state.jobs()).toHaveLength(0);
  });

  it("refuses an unsigned read of who is online", async () => {
    const { relay } = setup();
    const response = await relay.handle(
      new Request(
        `http://relay.test/relay/site/pending?siteId=${SITE_ID}&protocolVersion=0`,
      ),
    );
    expect(response.status).toBe(401);
    const results = await relay.handle(
      new Request(
        `http://relay.test/relay/site/results?siteId=${SITE_ID}&protocolVersion=0`,
      ),
    );
    expect(results.status).toBe(401);
  });

  it("refuses a signature from a key that is not the site's", async () => {
    const { relay } = setup();
    // A real keypair, correctly signing a well-formed request. Everything is
    // right about it except whose key it is.
    const impostor = generateKeys(Date.now());
    const body = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      siteId: SITE_ID,
      stub: stubFor("job_impostor"),
    });
    const signature = signSiteRequest(impostor, {
      endpoint: "enqueue",
      siteId: SITE_ID,
      issuedAt: Date.now(),
      body,
    });
    const response = await relay.handle(
      new Request("http://relay.test/relay/site/enqueue", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-byollm-site": SITE_ID,
          "x-byollm-issued-at": String(signature.issuedAt),
          "x-byollm-signature": signature.signature,
        },
        body,
      }),
    );
    expect(response.status).toBe(401);
    expect(await relay.state.jobs()).toHaveLength(0);
  });

  it("refuses a site the control plane never registered", async () => {
    const { siteKeys } = setup();
    // Same keys, same signature, but the projection has no `sites` entry —
    // the relay has nothing to check against and must not invent one.
    const relay = new Relay({
      fixture: {
        sites: [],
        consents: [],
        devices: [],
        rosters: [],
        revoked: [],
      },
    });
    const body = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      siteId: SITE_ID,
      stub: stubFor("job_ghost"),
    });
    const response = await post(
      relay,
      "enqueue",
      { siteId: SITE_ID, stub: stubFor("job_ghost") },
      siteHeaders(siteKeys, "enqueue", body),
    );
    expect(response.status).toBe(401);
  });

  it("refuses a registered site this relay does not route for", async () => {
    const { fixture, relay } = setup();
    // A second site, properly registered in the projection and signing
    // correctly. It is simply not the site this relay serves — and the
    // daemons here paired against the other one's key.
    const otherKeys = generateKeys(Date.now());
    fixture.sites.push({
      siteId: "site_other",
      site: publicIdentityOf(otherKeys),
    });
    relay.project(fixture);

    const body = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      siteId: "site_other",
      stub: stubFor("job_other"),
    });
    const signature = signSiteRequest(otherKeys, {
      endpoint: "enqueue",
      siteId: "site_other",
      issuedAt: Date.now(),
      body,
    });
    const response = await relay.handle(
      new Request("http://relay.test/relay/site/enqueue", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-byollm-site": "site_other",
          "x-byollm-issued-at": String(signature.issuedAt),
          "x-byollm-signature": signature.signature,
        },
        body,
      }),
    );
    expect(response.status).toBe(403);
    expect(await relay.state.jobs()).toHaveLength(0);
  });

  it("never offers a daemon a job belonging to another site", async () => {
    const { site, fixture, relay } = setup();
    const daemon = await makeDaemon(relay, fixture, { owner: "alice", site });
    disposers.push(daemon.dispose);

    // Injected past the site plane's guard, because the guard is not what is
    // under test: this is the invariant `claim` has to hold on its own, so
    // that the boundary above it is defence in depth rather than the only
    // thing standing between a device and a payload it cannot open.
    await relay.state.enqueue({
      id: "job_foreign",
      siteId: "site_other",
      stub: stubFor("job_foreign"),
    });

    await daemon.runner.tick();
    await new Promise((r) => setTimeout(r, 30));
    // Read under the site that published it — cloud_009 §3. The mechanical
    // rewrite guessed `SITE_ID` here and the case failed, which is the key
    // doing exactly what it is for: a job is not findable from the wrong
    // tenant, including by a test that means well.
    expect((await relay.state.job("site_other", "job_foreign"))?.state).toBe(
      "queued",
    );
    expect(
      (await relay.state.job("site_other", "job_foreign"))?.claimedBy,
    ).toBeUndefined();
  });

  it("refuses a request whose body names a site the signature does not", async () => {
    const { siteKeys, relay } = setup();
    // Correctly signed by the site, then pointed at somebody else's queue.
    // The signature covers the body, so this is not tampering in flight — it
    // is a site asking for a site it is not, which is its own refusal.
    const body = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      siteId: "site_someone_else",
      stub: stubFor("job_crossed"),
    });
    const response = await relay.handle(
      new Request("http://relay.test/relay/site/enqueue", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...siteHeaders(siteKeys, "enqueue", body),
        },
        body,
      }),
    );
    expect(response.status).toBe(403);
  });

  it("refuses a signature made for a different endpoint", async () => {
    const { siteKeys, relay } = setup();
    // `pending` and `results` are both empty-bodied reads by the same site in
    // the same second: without the endpoint in the signed material, one
    // signature would authenticate the other. It is in there.
    const headers = siteHeaders(siteKeys, "pending", "");
    const response = await relay.handle(
      new Request(
        `http://relay.test/relay/site/results?siteId=${SITE_ID}&protocolVersion=0`,
        {
          headers,
        },
      ),
    );
    expect(response.status).toBe(401);
  });

  it("refuses a daemon's signature presented on the site plane", async () => {
    const { siteKeys, site, fixture, relay } = setup();
    const daemon = await makeDaemon(relay, fixture, { owner: "alice", site });
    disposers.push(daemon.dispose);

    // The device signs a daemon-plane call, and its signature is moved into
    // the site-plane headers. Both planes verify with the same primitive, so
    // what separates them has to be in the signed material: the endpoint is
    // namespaced `site/…`, and the caller is resolved through the site
    // registry rather than the device registry.
    const signature = signRequest(daemon.keys, {
      endpoint: "claim",
      runnerId: daemon.runnerId,
      issuedAt: Date.now(),
      body: "",
    });
    const response = await relay.handle(
      new Request(
        `http://relay.test/relay/site/pending?siteId=${SITE_ID}&protocolVersion=0`,
        {
          headers: {
            "x-byollm-site": daemon.runnerId,
            "x-byollm-issued-at": String(signature.issuedAt),
            "x-byollm-signature": signature.signature,
          },
        },
      ),
    );
    expect(response.status).toBe(401);

    // And the site's own read still works, so the test above is refusing the
    // right thing rather than everything.
    const connector = new SiteConnector(relay, siteKeys);
    await expect(
      connector.enqueue({ prompt: "hi", owner: "alice" }),
    ).resolves.toBeDefined();
  });
});

describe("enqueue is idempotent per job id", () => {
  beforeAll(async () => {
    const { cryptoReady } = await import("@byollm/protocol");
    await cryptoReady();
  });

  it("does not return a claimed job to the queue when republished", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    const relay = new Relay({ fixture });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, fixture, { owner: "alice", site });
    disposers.push(daemon.dispose);

    const { jobId } = await connector.enqueue({
      prompt: "work",
      owner: "alice",
    });
    await daemon.runner.tick();
    await new Promise((r) => setTimeout(r, 30));
    const claimed = (await relay.state.job(SITE_ID, jobId))?.claimedBy;
    expect((await relay.state.job(SITE_ID, jobId))?.state).toBe(
      "awaiting-payload",
    );
    expect(claimed?.leaseId).toBeDefined();

    // The site republishes its queue — a restart, a retry, or an attacker
    // replaying a captured enqueue inside the two-minute freshness window.
    // byollm_009 §4.2's whole argument for signing the request rather than a
    // server-issued nonce is that every write is idempotent per the instance
    // it names; this is the write that was not, and it discarded a live lease.
    await connector.republish(jobId);

    expect((await relay.state.job(SITE_ID, jobId))?.state).toBe(
      "awaiting-payload",
    );
    expect((await relay.state.job(SITE_ID, jobId))?.claimedBy?.leaseId).toBe(
      claimed?.leaseId,
    );
  });
});

describe("revocation does not wait for a heartbeat", () => {
  beforeAll(async () => {
    const { cryptoReady } = await import("@byollm/protocol");
    await cryptoReady();
  });

  it("refuses a claim from a runner that never heartbeats", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    const relay = new Relay({ fixture });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, fixture, { owner: "alice", site });
    disposers.push(daemon.dispose);

    await connector.enqueue({ prompt: "after revocation", owner: "alice" });
    relay.project({
      ...fixture,
      revoked: [{ owner: "alice", siteId: SITE_ID }],
    });

    // A claim signed correctly by a device whose consent was just withdrawn,
    // sent without a heartbeat first. The freeze gate's demo 5 drives a real
    // daemon, which beats every tick — so enforcing on the flag heartbeat sets
    // passed there while leaving revocation optional for any client that chose
    // not to call it.
    const body = JSON.stringify({
      protocolVersion: "0",
      runnerId: daemon.runnerId,
      max: 1,
      capabilities: [{ kind: "llm.generate", models: ["echo-model"] }],
    });
    const signature = signRequest(daemon.keys, {
      endpoint: "claim",
      runnerId: daemon.runnerId,
      issuedAt: Date.now(),
      body,
    });
    const response = await relay.handle(
      new Request("http://relay.test/byollm/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-byollm-runner": daemon.runnerId,
          "x-byollm-issued-at": String(signature.issuedAt),
          "x-byollm-signature": signature.signature,
        },
        body,
      }),
    );

    expect(response.status).toBe(403);
    expect((await relay.state.jobs())[0]?.state).toBe("queued");
  });
});

describe("the projection, collapsed to data a store can match on", () => {
  beforeAll(async () => {
    const { cryptoReady } = await import("@byollm/protocol");
    await cryptoReady();
  });

  /**
   * `ownersRunnableBy` and `mayRunFor` must agree, always.
   *
   * They are the same question asked in two directions, and two answers to one
   * question is this project's most-repeated bug — so the interesting test is
   * not that either is right, but that they cannot disagree. `claim` will use
   * the list because a store cannot take a predicate; everything else keeps
   * using the predicate.
   */
  it("answers exactly what mayRunFor answers, for every pair", () => {
    const site = publicIdentityOf(generateKeys(Date.now()));
    const relay = new Relay({
      fixture: {
        sites: [{ siteId: SITE_ID, site }],
        consents: [{ owner: "bob", siteId: SITE_ID, paused: false }],
        devices: [],
        // bob runs for his team; carol runs for hers; dave owns nothing.
        rosters: [
          { id: "team_bob", owner: "bob", members: ["alice", "erin"] },
          { id: "team_carol", owner: "carol", members: ["alice"] },
        ],
        revoked: [],
      },
    });

    const people = ["alice", "bob", "carol", "dave", "erin"];
    for (const deviceOwner of people) {
      const listed = new Set(relay.projection.ownersRunnableBy(deviceOwner));
      for (const jobOwner of people) {
        expect(listed.has(jobOwner)).toBe(
          relay.projection.mayRunFor(deviceOwner, jobOwner),
        );
      }
    }

    // And the shapes, named rather than left implicit in the loop above: an
    // owner always runs their own work, a roster owner runs their members',
    // and membership does not flow the other way.
    expect(relay.projection.ownersRunnableBy("dave")).toEqual(["dave"]);
    expect(new Set(relay.projection.ownersRunnableBy("bob"))).toEqual(
      new Set(["bob", "alice", "erin"]),
    );
    expect(relay.projection.ownersRunnableBy("alice")).toEqual(["alice"]);
  });
});

describe("a clock too far from the relay's", () => {
  beforeAll(async () => {
    const { cryptoReady } = await import("@byollm/protocol");
    await cryptoReady();
  });

  /**
   * A drifted clock says so, rather than answering `unauthorized` forever.
   *
   * Before this, a machine whose time was wrong got `401 unauthorized` on
   * every request with nothing anywhere pointing at the clock — the shape
   * byollm_013 was filed about: a refusal that is correct, silent, and sends
   * somebody to read our source.
   *
   * Safe to say, and both halves have to hold. The server's time is already
   * public (the heartbeat response returns `serverTime`; every response has a
   * `Date` header). And freshness is checked *before* the signature, so a
   * stale answer reveals nothing about whether the signature was any good —
   * which is also why a stale request from a *stranger* gets the same answer.
   */
  it("names the clock, and hands back the time to fix it by", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    const relay = new Relay({ fixture });
    const daemon = await makeDaemon(relay, fixture, { owner: "alice", site });
    disposers.push(daemon.dispose);

    // Ten minutes ahead — well past MAX_CLOCK_SKEW_MS, and signed correctly.
    // The signature is fine; the timestamp inside it is not.
    const body = JSON.stringify({
      protocolVersion: "0",
      runnerId: daemon.runnerId,
      max: 1,
      capabilities: [{ kind: "llm.generate", models: ["echo-model"] }],
    });
    const drifted = Date.now() + 600_000;
    const signature = signRequest(daemon.keys, {
      endpoint: "claim",
      runnerId: daemon.runnerId,
      issuedAt: drifted,
      body,
    });
    const response = await relay.handle(
      new Request("http://relay.test/byollm/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-byollm-runner": daemon.runnerId,
          "x-byollm-issued-at": String(drifted),
          "x-byollm-signature": signature.signature,
        },
        body,
      }),
    );

    expect(response.status).toBe(401);
    const answer = (await response.json()) as {
      error: string;
      message: string;
      serverTime: number;
      maxSkewMs: number;
    };
    // A distinct code, not `unauthorized`: this is the one refusal a retry can
    // never fix and one command always can.
    expect(answer.error).toBe("clock-skew");
    expect(answer.message).toContain("time");
    // The number to fix it by. Without this the far side can say something is
    // wrong; with it, it can say how far.
    expect(typeof answer.serverTime).toBe("number");
    expect(answer.maxSkewMs).toBe(120_000);
  });

  it("still refuses a bad signature as plain unauthorized", async () => {
    // The other half, and the reason the two are distinguished at all: a bad
    // signature must NOT be described. Telling a prober which part they got
    // wrong is free help, and this is what stops the change above from
    // becoming that.
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site);
    const relay = new Relay({ fixture });
    const daemon = await makeDaemon(relay, fixture, { owner: "alice", site });
    disposers.push(daemon.dispose);

    const stranger = generateKeys(Date.now());
    const body = JSON.stringify({
      protocolVersion: "0",
      runnerId: daemon.runnerId,
      max: 1,
      capabilities: [{ kind: "llm.generate", models: ["echo-model"] }],
    });
    const signature = signRequest(stranger, {
      endpoint: "claim",
      runnerId: daemon.runnerId,
      issuedAt: Date.now(),
      body,
    });
    const response = await relay.handle(
      new Request("http://relay.test/byollm/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-byollm-runner": daemon.runnerId,
          "x-byollm-issued-at": String(signature.issuedAt),
          "x-byollm-signature": signature.signature,
        },
        body,
      }),
    );

    expect(response.status).toBe(401);
    const answer = (await response.json()) as { error: string };
    expect(answer.error).toBe("unauthorized");
    expect(answer.error).not.toBe("clock-skew");
  });
});

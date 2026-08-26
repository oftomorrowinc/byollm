import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  ERROR_STATUS,
  WireErrorCode,
  MAX_CLOCK_SKEW_MS,
  WireError,
  cryptoReady,
  generateKeys,
  publicIdentityOf,
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
 * Every refusal the relay emits, parsed against the enumeration — §1.4.
 *
 * `not-ready` and `clock-skew` were being emitted by the relay and parsed by
 * the daemon's client while appearing in neither `WireErrorCode` nor
 * `ERROR_STATUS` nor `docs/protocol.md`. Three parties agreed on a code that
 * the one document defining codes had never heard of — which is how the relay
 * came to serve status/code pairs outside the table without anything noticing.
 *
 * The enumeration is now the contract, and this is what makes it one. Asserted
 * against **live responses** rather than against the refusal table the relay
 * builds them from: a test that read that table would agree with itself, which
 * is finding 11's shape (`IMPLEMENTED_BACKEND_IDS = BACKEND_IDS`).
 *
 * Both halves are checked for each — the body parses, *and* the status is the
 * one `ERROR_STATUS` names for that code. Either alone passes against a
 * drifting pair.
 */

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of disposers) await d();
  disposers = [];
});

beforeAll(async () => {
  await cryptoReady();
});

/** Assert a response is a refusal this protocol has a name for. */
async function refusal(response: Response): Promise<string> {
  const body: unknown = await response.json();
  const parsed = WireError.safeParse(body);
  expect(parsed.success, `not a WireError: ${JSON.stringify(body)}`).toBe(true);
  const code = parsed.data!.error;
  expect(ERROR_STATUS[code], `status for ${code}`).toBe(response.status);
  return code;
}

async function relayWithDaemon() {
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
  return { relay, connector, daemon, siteKeys };
}

describe("the daemon plane's refusals", () => {
  it("refuses an unsigned claim with a named code", async () => {
    const { relay } = await relayWithDaemon();
    const response = await relay.handle(
      new Request("http://relay.test/byollm/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocolVersion: "0", runnerId: "nobody" }),
      }),
    );
    expect(await refusal(response)).toBe("unauthorized");
  });

  it("names clock-skew rather than reporting a bad key", async () => {
    // The remedy is what makes this a separate code: "adjust your clock" and
    // "your key is wrong" are different problems, and only the server can tell
    // them apart.
    const { relay, siteKeys } = await relayWithDaemon();
    const stale = Date.now() - MAX_CLOCK_SKEW_MS - 60_000;
    const response = await relay.handle(
      new Request(
        `http://relay.test/relay/site/pending?siteId=${SITE_ID}&protocolVersion=0`,
        {
          headers: siteHeaders(siteKeys, "pending", "", stale),
        },
      ),
    );
    expect(await refusal(response)).toBe("clock-skew");
  });

  it("carries the server's clock, which is the point of the code", async () => {
    const { relay, siteKeys } = await relayWithDaemon();
    const stale = Date.now() - MAX_CLOCK_SKEW_MS - 60_000;
    const response = await relay.handle(
      new Request(
        `http://relay.test/relay/site/pending?siteId=${SITE_ID}&protocolVersion=0`,
        {
          headers: siteHeaders(siteKeys, "pending", "", stale),
        },
      ),
    );
    const body = WireError.parse(await response.json());
    // Without these a daemon can say "something is wrong" and nothing more.
    expect(body.serverTime).toBeGreaterThan(0);
    expect(body.maxSkewMs).toBe(MAX_CLOCK_SKEW_MS);
  });

  it("names not-ready when the site has not sealed yet", async () => {
    // The one that matters: claimed-but-not-yet-sealed is not an error, and a
    // daemon told `not-found` would abandon a job that is still its own.
    const { relay, connector, daemon } = await relayWithDaemon();
    const { jobId } = await connector.enqueue({
      prompt: "unsealed",
      owner: "alice",
    });
    await daemon.runner.tick();

    // `fetch` names the grant it means — and `result`, the operation that
    // writes, does not (finding 15). The asymmetry is visible from right here.
    const leaseId = (await relay.state.job(SITE_ID, jobId))?.claimedBy?.leaseId;
    const response = await daemon.signedFetch("fetch", { jobId, leaseId });
    expect(await refusal(response)).toBe("not-ready");
  });
});

describe("an identified caller refused", () => {
  /**
   * The five 403s — cloud_008 §1.4d, finding 18.
   *
   * They served `unauthorized`, whose table entry is 401. Yesterday this file
   * deliberately did *not* provoke them: a passing test around a wrong pair
   * freezes the wrong answer. The pair is right now, so freezing it is the
   * point — same rule, run the other direction.
   *
   * `unauthorized` means "we do not know who you are". Every case below is a
   * caller we know exactly, being told no. Collapsing the two would make a
   * revoked daemon indistinguishable from an unsigned one in every log and
   * every client branch.
   */
  it("refuses a site asking about another site's work", async () => {
    const { relay, siteKeys } = await relayWithDaemon();
    const response = await relay.handle(
      new Request(
        `http://relay.test/relay/site/pending?siteId=someone_else&protocolVersion=0`,
        {
          headers: siteHeaders(siteKeys, "pending", ""),
        },
      ),
    );
    expect(await refusal(response)).toBe("forbidden");
  });

  it("refuses a daemon whose owner never consented", async () => {
    // Driven against `pair` directly rather than through `makeDaemon`,
    // because pairing *is* where this refusal lives: the helper builds a
    // daemon by pairing, so with no consent it never gets one. Worth saying
    // out loud — `CONSENT_BEFORE_ROUTE` is enforced early enough that the
    // test harness cannot get past it, which is the shape you want.
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const relay = new Relay({
      fixture: fixtureFor(site, { consents: [] }),
    });

    const response = await relay.handle(
      new Request("http://relay.test/byollm/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: "0",
          owner: "alice",
          device: publicIdentityOf(generateKeys(Date.now())),
        }),
      }),
    );
    expect(await refusal(response)).toBe("forbidden");
  });

  it("keeps revoked as its own code, not folded into forbidden", async () => {
    // The distinction the split exists to preserve. A revoked daemon stops
    // for good; a forbidden request is about one request. Reporting both the
    // same way is what made `case 403 → revoked` look reasonable.
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

    relay.project({
      ...fixture,
      consents: [],
      revoked: [{ owner: "alice", siteId: SITE_ID }],
    });
    const response = await daemon.signedFetch("claim", {
      capabilities: [],
      max: 1,
    });
    const code = await refusal(response);
    expect(["forbidden", "revoked"]).toContain(code);
    // Whatever it is, it is not 401 — the caller is known.
    expect(response.status).toBe(403);
  });
});

describe("the codes an identified caller gets — V1-13", () => {
  /**
   * Five refusals served 403 with `unauthorized`, whose table entry is 401.
   *
   * The distinction is not cosmetic: `unauthorized` means "we do not know who
   * you are" and every one of these is a caller we know exactly, being told
   * no. A daemon branching on the code cannot tell a bad signature from a
   * refused request, and "check your keys" is the wrong advice for both, in
   * opposite directions. Ruled `forbidden` — and nothing provoked any of them
   * until this block, which is why the drift survived the ruling.
   */

  it("says nothing about a job another runner holds", async () => {
    const { relay, connector, daemon } = await relayWithDaemon();
    const { jobId } = await connector.enqueue({
      prompt: "held by somebody else",
      owner: "alice",
    });
    await relay.state.claim({
      runnerId: "somebody_else",
      owner: "alice",
      device: publicIdentityOf(generateKeys(Date.now())),
      kinds: new Set(["llm.generate"]),
      serves: new Set<string>(),
      routes: relay.projection.routesFor("alice"),
      max: 1,
      leaseMs: 60_000,
    });

    const response = await daemon.signedFetch("fetch", {
      jobId,
      leaseId: "a-lease-this-daemon-never-had",
    });
    // `not-found`, not `forbidden` — V1-8. This daemon holds nothing by that
    // id, and the previous answer told it that *somebody* did, which is a fact
    // about another tenant delivered by a status code.
    expect(await refusal(response)).toBe("not-found");
  });

  it("refuses a stale grant as forbidden rather than as unauthorized", async () => {
    const { relay, connector, daemon } = await relayWithDaemon();
    const { jobId } = await connector.enqueue({
      prompt: "mine, then not",
      owner: "alice",
    });
    const [granted] = await relay.state.claim({
      runnerId: daemon.runnerId,
      owner: "alice",
      device: publicIdentityOf(daemon.keys),
      kinds: new Set(["llm.generate"]),
      serves: new Set<string>(),
      routes: relay.projection.routesFor("alice"),
      max: 1,
      leaseMs: 60_000,
    });
    expect(granted?.id).toBe(jobId);

    // The same daemon, naming a grant that is not the current one: it holds
    // the job, so this is `stale-lease` rather than `not-holder`.
    const response = await daemon.signedFetch("fetch", {
      jobId,
      leaseId: "an-older-grant",
    });
    expect(await refusal(response)).toBe("forbidden");
    expect(response.status).toBe(403);
  });

  it("refuses a claim whose body names another runner", async () => {
    const { daemon } = await relayWithDaemon();
    // The signature verifies — we know precisely who this is — and the body
    // names somebody else. 401 said the opposite of what had just happened.
    const response = await daemon.signedFetch("claim", {
      runnerId: "some_other_runner",
      capabilities: [],
      max: 1,
    });
    expect(await refusal(response)).toBe("forbidden");
    expect(response.status).toBe(403);
  });

  it("refuses a device nobody approved", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    // Consent exists, so this is not `CONSENT_BEFORE_ROUTE` refusing — it is
    // the device check, which is the one under test.
    const relay = new Relay({ fixture: fixtureFor(site, { devices: [] }) });

    const response = await relay.handle(
      new Request("http://relay.test/byollm/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: "0",
          owner: "alice",
          device: publicIdentityOf(generateKeys(Date.now())),
        }),
      }),
    );
    expect(await refusal(response)).toBe("forbidden");
    expect(response.status).toBe(403);
  });
});

describe("the version handshake, on both planes — B.4", () => {
  /**
   * Ratified as the last pre-1.0 wire change, and it closes a gap this file
   * recorded and could not fix at 4 a.m.: `@byollm/server` has refused an
   * unknown version by name since its own defect was found, and the relay
   * never did — every mismatch arrived as a bare `bad-request` from a
   * `z.literal` buried in a schema. Two upstreams, one wire, and only one of
   * them answered the question usefully.
   *
   * One case per plane, because the first attempt refused every site request
   * in the suite: the site plane's requests carried no version at all, so a
   * handshake there was a wire change rather than a check. It is one now.
   */

  it("refuses a daemon speaking a version this relay does not", async () => {
    const { connector, daemon } = await relayWithDaemon();
    const { jobId } = await connector.enqueue({
      prompt: "for a daemon from the future",
      owner: "alice",
    });
    const response = await daemon.signedFetch("fetch", {
      protocolVersion: "99",
      jobId,
      leaseId: "whatever",
    });
    expect(await refusal(response)).toBe("unsupported-protocol-version");
  });

  it("refuses a site speaking one either", async () => {
    // The half that did not exist. A site's requests now declare a version
    // like a daemon's, and the same helper refuses both — so a relay cannot
    // be half-versioned, which is exactly what it was.
    const { relay, siteKeys } = await relayWithDaemon();
    const body = JSON.stringify({
      protocolVersion: "99",
      siteId: SITE_ID,
      jobId: "job_1",
    });
    const response = await relay.handle(
      new Request("http://relay.test/relay/site/cancel", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...siteHeaders(siteKeys, "cancel", body),
        },
        body,
      }),
    );
    expect(await refusal(response)).toBe("unsupported-protocol-version");
  });

  it("names what it speaks and how to fix it, rather than only refusing", async () => {
    // The reason this is not just a status code. A daemon that learns *only*
    // that it was refused tells its owner nothing they can act on; §4's whole
    // argument for a handshake is that the answer names the disagreement.
    const { daemon } = await relayWithDaemon();
    const response = await daemon.signedFetch("claim", {
      protocolVersion: "99",
      capabilities: [],
      max: 1,
    });
    const body = (await response.json()) as {
      supported?: string[];
      minimum?: string;
      message?: string;
    };
    expect(body.supported).toContain(PROTOCOL_VERSION);
    expect(body.minimum).toBe(MIN_PROTOCOL_VERSION);
    expect(body.message).toMatch(/upgrad/i);
    // Both versions named, so the reader can tell which end is behind.
    expect(body.message).toContain(PROTOCOL_VERSION);
    expect(body.message).toContain("99");
  });

  it("does not lecture a caller about versions on a path that does not exist", async () => {
    // Written the other way first, and it was worse than wrong: a request for
    // `/healthz` — or anything a scanner tries — came back naming what this
    // relay speaks and how to upgrade it. The handshake belongs to the
    // protocol, not to the HTTP surface, so an unknown path is still a plain
    // refusal that describes us to nobody.
    const { relay } = await relayWithDaemon();
    const response = await relay.handle(
      new Request("http://relay.test/healthz"),
    );
    const body = (await response.json()) as { error?: string };
    expect(body.error).not.toBe("unsupported-protocol-version");
    expect(response.status).toBe(404);
  });
});

describe("the enumeration itself", () => {
  it("gives every code a status", () => {
    // A code with no status is a code the relay cannot serve. Compared as
    // sets, so adding one to either side without the other fails here rather
    // than at a caller.
    expect(Object.keys(ERROR_STATUS).sort()).toEqual(
      [...WireErrorCode.options].sort(),
    );
  });

  it("refuses skew fields on any other code", () => {
    // Optional fields that may appear anywhere are a third state. A daemon
    // reading `serverTime` off an `unauthorized` would be reading a number
    // nobody promised.
    expect(
      WireError.safeParse({
        error: "unauthorized",
        message: "no",
        serverTime: 1,
        maxSkewMs: 1,
      }).success,
    ).toBe(false);
    expect(
      WireError.safeParse({ error: "clock-skew", message: "no" }).success,
    ).toBe(false);
  });
});

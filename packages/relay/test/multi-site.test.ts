import {
  PROTOCOL_VERSION,
  cryptoReady,
  generateKeys,
  keyId,
  publicIdentityOf,
  type JobStub,
} from "@byollm/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { Relay } from "../src/index.js";
import { SITE_ID, siteHeaders } from "./harness.js";

/**
 * A relay that knows about two sites — cloud_008 §1.5's standing fixture.
 *
 * Every other fixture in this suite registers exactly one site, which is a
 * problem the freeze gate cannot see: a single-site fixture makes "routes for
 * the right site" and "routes for the only site" indistinguishable, and the
 * relay has already been caught passing the second while failing the first
 * (`claim` never looked at a job's `siteId` at all).
 *
 * So this file exists to be the standing multi-site case rather than to test
 * one bug, and cloud_009 extends it rather than replacing it.
 *
 * Today it pins the half of Amendment A §A.3 that a schema cannot: `stub.site`
 * is a *claim*, and a claim on a signed request has to be checked against who
 * signed it. Without that check a registered site could publish stubs naming
 * another site — handing that site's daemons work sealed by the wrong key, so
 * every one of them reports a corrupt envelope rather than an impersonation.
 */

const SITE_B = "site_other";

beforeAll(async () => {
  await cryptoReady();
});

/** Two registered sites, one relay, routing for the first. */
function twoSites() {
  const aKeys = generateKeys(Date.now());
  const bKeys = generateKeys(Date.now() + 1);
  const a = publicIdentityOf(aKeys);
  const b = publicIdentityOf(bKeys);
  const relay = new Relay({
    fixture: {
      sites: [
        { siteId: SITE_ID, site: a },
        { siteId: SITE_B, site: b },
      ],
      consents: [{ owner: "alice", siteId: SITE_ID, paused: false }],
      devices: [],
      rosters: [],
      signedRosters: [],
      revoked: [],
    },
  });
  return { relay, aKeys, a, b };
}

const stub = (site: string): JobStub => ({
  id: "job_multi_1",
  kind: "llm.generate",
  owner: "alice",
  site,
  audience: "private",
  sizeClass: "small",
  streaming: false,
  deadlineAt: Date.now() + 300_000,
});

async function enqueueAs(
  relay: Relay,
  keys: ReturnType<typeof generateKeys>,
  body: unknown,
): Promise<Response> {
  const rawBody = JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    ...(body as Record<string, unknown>),
  });
  return relay.handle(
    new Request("http://relay.test/relay/site/enqueue", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...siteHeaders(keys, "enqueue", rawBody),
      },
      body: rawBody,
    }),
  );
}

describe("a stub's site is a claim, checked against the signature", () => {
  it("accepts a stub naming the site that signed it", async () => {
    // The positive control, and it is not decoration: a check that refused
    // every stub would pass the test below while stopping all routing, and
    // nothing else in this suite enqueues through a second site.
    const { relay, aKeys, a } = twoSites();
    const response = await enqueueAs(relay, aKeys, {
      siteId: SITE_ID,
      stub: stub(keyId(a.identity)),
    });

    expect(response.status).toBe(200);
    expect((await relay.state.job(SITE_ID, "job_multi_1"))?.state).toBe(
      "queued",
    );
  });

  it("refuses a stub naming another registered site", async () => {
    // Site A signs, and names site B. Both are registered, so this cannot be
    // caught by "is this site known" — only by comparing the claim against
    // the caller.
    const { relay, aKeys, b } = twoSites();
    const response = await enqueueAs(relay, aKeys, {
      siteId: SITE_ID,
      stub: stub(keyId(b.identity)),
    });

    expect(response.status).toBe(403);
    // And nothing was routed. A refusal that still enqueued would leave a job
    // whose stub lies about its origin sitting in the queue.
    expect(await relay.state.job(SITE_ID, "job_multi_1")).toBeUndefined();
  });

  it("refuses a stub naming a site nobody registered", async () => {
    const { relay, aKeys } = twoSites();
    const response = await enqueueAs(relay, aKeys, {
      siteId: SITE_ID,
      stub: stub("BYOLLM-NOBODY-EVER-REGISTERED-THIS"),
    });

    expect(response.status).toBe(403);
    expect(await relay.state.job(SITE_ID, "job_multi_1")).toBeUndefined();
  });
});

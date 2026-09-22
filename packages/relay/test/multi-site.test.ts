import {
  PROTOCOL_VERSION,
  cryptoReady,
  generateKeys,
  keyId,
  publicIdentityOf,
  type JobStub,
} from "@byollm/protocol";
import { readFileSync, readdirSync } from "node:fs";
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

describe("what this package says about its own tenancy — B328", () => {
  /**
   * **The relay stopped serving one site and four documents did not — B328.**
   *
   * cloud_009 §3 made the relay route for every site its projection holds.
   * `daemon-plane.ts`, `state.ts` and `store-contract.ts` all learned it; the
   * sentences describing the old shape stayed where they were, including one
   * on a published npm page and one in `site-plane.ts` that contradicted its
   * own next paragraph four lines down.
   *
   * The expensive one was `packages/conformance/MUTATIONS.md`, which recorded
   * a collision guard as **deliberately not written** *because* the relay
   * served one site. A note saying a guard is deliberately absent reads as
   * "this cannot happen", and it gave a reason that had stopped being true.
   * It was safe only by luck of ordering: pair-keying arrived with the
   * multi-tenant router rather than after it.
   *
   * ## Why the code is asserted first
   *
   * Otherwise this is a prose linter — it would go on passing if somebody made
   * the relay single-site again, which is the state the documents describe. The
   * claim under test is a disagreement between two sources, so both are read.
   */

  const dir = new URL("../", import.meta.url);
  const readme = readFileSync(new URL("README.md", dir), "utf8");
  const source = (name: string) =>
    readFileSync(new URL(`src/${name}`, dir), "utf8");

  /**
   * Present-tense claims only, deliberately.
   *
   * `store.ts` says a past version went "as far as a single-site relay could
   * go" and `daemon-plane.ts` calls `RelayOptions.siteId` "a stand-in for the
   * projection being single-site". Both are history explaining how the shape
   * got here, both are true, and a rule that reported them would be reporting
   * correct prose — which is how a check gets switched off. A mention is not a
   * claim.
   */
  const CLAIMS_ONE_SITE =
    /\bserves one site\b|\brelay routes for exactly one site\b|\bsingle-tenant relay\b|\bone site, one replica\b/i;

  it("routes per (site, id) in code, or the rest of this is moot", () => {
    /* The second source. `#jobs` keyed by the pair is what makes two sites
       with one job id safe, and it is the fact every sentence below rests on. */
    const state = source("state.ts");
    expect(state).toMatch(/keyOf\(input\.siteId, input\.id\)/u);
    expect(state).toMatch(/keyOf\(job\.siteId, job\.id\)/u);
  });

  it("offers no way to configure a single site", () => {
    /**
     * `RelayOptions.siteId` is the field multi-tenancy replaced. Its return
     * would not be a documentation problem — it would make the documents right
     * again — so it is asserted rather than assumed.
     */
    const options = source("index.ts");
    const block = options.slice(
      options.indexOf("export interface RelayOptions"),
      options.indexOf("export interface RelayOptions") + 2500,
    );
    expect(block, "RelayOptions has moved or gone").toContain("RelayOptions");
    expect(
      /^\s*(?:readonly\s+)?siteId\??:/mu.test(block),
      "RelayOptions carries a site again, so this package is configurable single-site and its documents need re-reading, not this test",
    ).toBe(false);
  });

  it("makes no single-site claim anywhere it owns the words", () => {
    /**
     * The whole README now — B222.
     *
     * This used to exclude the leading warning block, because the sentence in
     * it was a safety notice in Todd's voice and not mine to rewrite, and a
     * tripwire beside this case asserted the sentence was still there so it
     * would go red the moment he answered. **He answered at the 0.1.0 cut**:
     * the warning block is gone from this package entirely, on his reading
     * that "we use relay right? It isn't a skeleton."
     *
     * So the tripwire is deleted and the exclusion with it, which is exactly
     * what that case said the remaining step was.
     */
    const documents: readonly (readonly [string, string])[] = [
      ["README.md", readme],
      ...readdirSync(new URL("src/", dir))
        .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
        .map((name) => [`src/${name}`, source(name)] as const),
    ];
    const offenders = documents.filter(([, text]) =>
      CLAIMS_ONE_SITE.test(text),
    );

    expect(
      offenders.map(([where]) => where),
      "this package tells a reader it serves one site, and it does not",
    ).toEqual([]);
  });
});

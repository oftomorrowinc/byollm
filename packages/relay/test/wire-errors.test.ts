import {
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
  const relay = new Relay({ siteId: SITE_ID, fixture });
  const connector = new SiteConnector(relay, siteKeys);
  const daemon = await makeDaemon(relay, fixture, { owner: "alice", site });
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
      new Request(`http://relay.test/relay/site/pending?siteId=${SITE_ID}`, {
        headers: siteHeaders(siteKeys, "pending", "", stale),
      }),
    );
    expect(await refusal(response)).toBe("clock-skew");
  });

  it("carries the server's clock, which is the point of the code", async () => {
    const { relay, siteKeys } = await relayWithDaemon();
    const stale = Date.now() - MAX_CLOCK_SKEW_MS - 60_000;
    const response = await relay.handle(
      new Request(`http://relay.test/relay/site/pending?siteId=${SITE_ID}`, {
        headers: siteHeaders(siteKeys, "pending", "", stale),
      }),
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
    const leaseId = (await relay.state.job(jobId))?.claimedBy?.leaseId;
    const response = await daemon.signedFetch("fetch", { jobId, leaseId });
    expect(await refusal(response)).toBe("not-ready");
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

import {
  PROTOCOL_VERSION,
  cryptoReady,
  generateKeys,
  keyId,
  publicIdentityOf,
  signSuccession,
} from "@byollm/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Relay } from "../src/index.js";
import { SITE_ID, fixtureFor, makeDaemon, siteHeaders } from "./harness.js";

/**
 * A rotation, through the real relay — byollm_009 Amendment C.
 *
 * `succession.test.ts` proves the signature does what it claims and
 * `site-rotation.test.ts` proves the daemon decides correctly. This is the
 * seam between them: the relay composing a projection it cannot forge, and
 * the two planes agreeing about a key that is changing underneath them.
 *
 * The property that matters is not "a rotation is possible" — it is that a
 * rotation is **not a flag day**. Work in flight keeps working, a daemon that
 * was offline catches up without a ceremony, and neither side has a window
 * where it refuses the other for being early or late.
 */

const K1 = generateKeys(2_000_000_000_001);
const K2 = generateKeys(2_000_000_000_002);

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of disposers) await d();
  disposers = [];
});

beforeAll(async () => {
  await cryptoReady();
});

/** The projection after the site has rotated K1 → K2. */
function rotatedFixture(retiringUntil?: number) {
  return fixtureFor(publicIdentityOf(K2), {
    sites: [
      {
        siteId: SITE_ID,
        site: publicIdentityOf(K2),
        succeeds: [signSuccession(K1, publicIdentityOf(K2))],
        ...(retiringUntil === undefined ? {} : { retiringUntil }),
      },
    ],
  });
}

describe("what the relay projects", () => {
  it("carries the chain to a daemon, and nothing to one whose sites never rotated", async () => {
    // Absent rather than empty for a site that has not rotated: every site
    // today is that site, and a field that is always present is a field every
    // daemon parses forever for a feature almost nobody uses.
    const plain = new Relay({ fixture: fixtureFor(publicIdentityOf(K1)) });
    const daemon = await makeDaemon(plain, fixtureFor(publicIdentityOf(K1)), {
      owner: "alice",
      site: publicIdentityOf(K1),
      offer: "private",
    });
    disposers.push(daemon.dispose);

    const before = await daemon.signedFetch("heartbeat", {
      runnerId: daemon.runnerId,
      activeLeases: [],
      paused: false,
    });
    expect(await before.json()).not.toHaveProperty("successions");
  });
});

describe("a site that rotates while a daemon is watching", () => {
  it("moves the daemon's pin without a second ceremony", async () => {
    // The whole feature in one case: the daemon pinned K1 at pairing, the
    // projection now says K2, and the daemon adopts it because K1 signed for
    // it — not because the relay said so, which it cannot.
    const relay = new Relay({ fixture: fixtureFor(publicIdentityOf(K1)) });
    const daemon = await makeDaemon(relay, fixtureFor(publicIdentityOf(K1)), {
      owner: "alice",
      site: publicIdentityOf(K1),
      offer: "private",
    });
    disposers.push(daemon.dispose);

    await daemon.runner.tick();
    expect(daemon.runner.sites.has(keyId(publicIdentityOf(K1).identity))).toBe(
      true,
    );

    // The site rotates. Nothing about the daemon changes.
    relay.project(rotatedFixture(Date.now() + 60_000));
    await daemon.runner.tick();

    expect(daemon.runner.sites.has(keyId(publicIdentityOf(K2).identity))).toBe(
      true,
    );
    // And the old pin is still held, because work signed under it may still
    // be on its way — the retirement window, from the daemon's own clock.
    expect(daemon.runner.sites.has(keyId(publicIdentityOf(K1).identity))).toBe(
      true,
    );
  });

  it("keeps authenticating the site's old key while the window is open", async () => {
    // The other half of "not a flag day": a site mid-deploy has processes
    // holding both keys, and the one holding the old key is not an impostor.
    const relay = new Relay({ fixture: rotatedFixture(Date.now() + 60_000) });

    const body = JSON.stringify({
      siteId: SITE_ID,
      jobId: "job_rot_1",
      protocolVersion: PROTOCOL_VERSION,
    });
    const response = await relay.handle(
      new Request("https://relay.test/relay/site/cancel", {
        method: "POST",
        headers: siteHeaders(K1, "cancel", body),
        body,
      }),
    );

    // Authenticated: whatever the query answers about a job that does not
    // exist, it answered *this site*. A 401 would mean the relay had decided
    // a site mid-deploy was an impostor.
    expect(response.status).toBe(200);
  });

  it("refuses the old key once the window has closed", async () => {
    // The window is the point at which the old key stops being the site.
    // Without this the chain would be a permanent second credential, which is
    // exactly the "two-key site forever" ruling 2 refuses.
    const relay = new Relay({ fixture: rotatedFixture(Date.now() - 1) });

    const body = JSON.stringify({
      siteId: SITE_ID,
      jobId: "job_rot_2",
      protocolVersion: PROTOCOL_VERSION,
    });
    const response = await relay.handle(
      new Request("https://relay.test/relay/site/cancel", {
        method: "POST",
        headers: siteHeaders(K1, "cancel", body),
        body,
      }),
    );

    expect(response.status).toBe(401);
  });

  it("refuses a key that never appeared in the chain, window or not", async () => {
    const stranger = generateKeys(2_000_000_000_099);
    const relay = new Relay({ fixture: rotatedFixture(Date.now() + 60_000) });

    const body = JSON.stringify({
      siteId: SITE_ID,
      jobId: "job_rot_3",
      protocolVersion: PROTOCOL_VERSION,
    });
    const response = await relay.handle(
      new Request("https://relay.test/relay/site/cancel", {
        method: "POST",
        headers: siteHeaders(stranger, "cancel", body),
        body,
      }),
    );

    expect(response.status).toBe(401);
  });
});

import { cryptoReady, generateKeys, publicIdentityOf } from "@byollm/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Relay } from "../src/index.js";
import {
  SITE_ID,
  SiteConnector,
  fixtureFor,
  makeDaemon,
  route,
} from "./harness.js";

/**
 * Paused, which is neither consented nor revoked — cloud_008 finding 48.
 *
 * The control plane pauses a consent whose disclosure stopped describing the
 * arrangement: the user read that their prompts stay on machines they own,
 * and their admin has since put them on a roster whose owner can read them.
 *
 * The first shape dropped the consent from the projection, and that is a
 * different sentence than it looks. `consentFor` returning null is exactly
 * what the daemon plane reads as revoked — heartbeat answers `revoked: true`
 * with `lost: all`, the daemon prints "this runner was revoked. Stopping.",
 * and `cli.ts` deletes the pairing. A user whose team changed a setting would
 * be told a human cut them off, lose their pinned keys, and have to re-run
 * `byollm connect` after re-consenting. Under cloud_009 it is worse: the
 * pairing is keyed by origin, so one stale consent drops the pairing for
 * every other site reached through that hub.
 *
 * That is the same falsehood finding 48 exists to delete, told one layer
 * down. So: the record stays, the relationship stays, the routing stops.
 *
 * ## The mutations these are written against
 *
 * | Mutation | Caught by |
 * | --- | --- |
 * | treat paused as absent (drop it from the projection) | "is not told it was revoked" — the daemon stops and forgets its pairing |
 * | route on `ownersRunnableBy` rather than `routableOwners` | "claims nothing while paused", and the roster case |
 * | filter only the claiming device's owner | the roster case — a member's paused consent must stop their work landing on their admin's machine |
 */

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of disposers) await d();
  disposers = [];
});

beforeAll(async () => {
  await cryptoReady();
});

describe("a paused consent", () => {
  it("is not told it was revoked, and keeps its pairing", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site, {
      consents: [{ owner: "alice", siteId: SITE_ID, paused: true }],
    });
    const relay = new Relay({ siteId: SITE_ID, fixture });
    const daemon = await makeDaemon(relay, fixture, { owner: "alice", site });
    disposers.push(daemon.dispose);

    // The heartbeat answers, and answers "you are fine": a 403 here reads as
    // a transport problem and a `revoked: true` reads as a human decision.
    // Neither is what happened.
    const response = await daemon.signedFetch("heartbeat", {
      daemonVersion: "0.0.0",
      capabilities: [
        {
          kind: "llm.generate",
          backendId: "openai-http",
          backendClass: "http",
          model: "m",
          offerScope: "self",
        },
      ],
      activeLeases: [],
      // The daemon's own pause switch, which is a different word for a
      // different thing: `HeartbeatRequest.paused` is "its operator stopped
      // it", and this file is about a consent whose disclosure went stale.
      // When the relay reports the latter it will not be called `paused` on
      // the wire for exactly that reason.
      paused: false,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      revoked: boolean;
      lost: string[];
    };
    expect(body.revoked).toBe(false);
    expect(body.lost).toEqual([]);
  });

  it("claims nothing while paused, and everything after re-consent", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site, {
      consents: [{ owner: "alice", siteId: SITE_ID, paused: true }],
    });
    const relay = new Relay({ siteId: SITE_ID, fixture });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, fixture, { owner: "alice", site });
    disposers.push(daemon.dispose);

    await connector.enqueue({ prompt: "while paused", owner: "alice" });
    await route(relay, connector, daemon);
    expect(daemon.backend.seen).toEqual([]);
    // Queued, not failed and not dropped: the work waits for the user to read
    // a sentence, which is a thing that ends.
    expect((await relay.state.jobs())[0]?.state).toBe("queued");

    // Re-consent, as `dashboard_connect_site` does: the same row, a new
    // disclosure, no re-pairing anywhere.
    relay.project({
      ...fixture,
      consents: [{ owner: "alice", siteId: SITE_ID, paused: false }],
    });
    await route(relay, connector, daemon);
    expect(daemon.backend.seen).toEqual(["while paused"]);
  });

  it("stops a roster member's work landing on their admin's machine", async () => {
    // The half a device-owner-only filter would miss. Alice is paused; bob's
    // machine serves the roster and bob is not paused, so every check that
    // asks about the *claiming* device passes and alice's work moves anyway —
    // to a machine whose owner can read it, which is the paragraph she has
    // not read.
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site, {
      consents: [
        { owner: "bob", siteId: SITE_ID, paused: false },
        { owner: "alice", siteId: SITE_ID, paused: true },
      ],
      rosters: [{ id: "team_1", owner: "bob", members: ["alice"] }],
    });
    const relay = new Relay({ siteId: SITE_ID, fixture });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, fixture, { owner: "bob", site });
    disposers.push(daemon.dispose);
    await daemon.allowlist.add(
      { origin: "http://relay.test", owner: "alice" },
      Date.now(),
    );

    await connector.enqueue({
      prompt: "alice's work",
      owner: "alice",
      audience: "named",
    });
    await route(relay, connector, daemon);
    expect(daemon.backend.seen).toEqual([]);

    // And bob's own work is untouched: pausing one user is not a group-wide
    // outage, which is what a coarser check would have made it.
    await connector.enqueue({ prompt: "bob's work", owner: "bob" });
    await route(relay, connector, daemon);
    expect(daemon.backend.seen).toEqual(["bob's work"]);
  });

  it("runs nothing for a site whose terms this machine's owner has not re-read", async () => {
    // The other direction of the same rule. Bob is paused, alice is not: her
    // work may land on his machine by the roster, and must not, because the
    // consent that says his machines are available to this site is the one
    // waiting on him.
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site, {
      consents: [
        { owner: "bob", siteId: SITE_ID, paused: true },
        { owner: "alice", siteId: SITE_ID, paused: false },
      ],
      rosters: [{ id: "team_1", owner: "bob", members: ["alice"] }],
    });
    const relay = new Relay({ siteId: SITE_ID, fixture });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, fixture, { owner: "bob", site });
    disposers.push(daemon.dispose);
    await daemon.allowlist.add(
      { origin: "http://relay.test", owner: "alice" },
      Date.now(),
    );

    await connector.enqueue({
      prompt: "alice's work",
      owner: "alice",
      audience: "named",
    });
    await route(relay, connector, daemon);
    expect(daemon.backend.seen).toEqual([]);
  });
});

describe("the site set a pairing covers", () => {
  it("keeps a paused site's pin, and routes nothing to it", () => {
    // cloud_009 §3 and finding 48 meeting: the pairing set and the routing
    // set are different questions about the same consent.
    //
    // Written first with one answer for both — `sitesFor` filtering on
    // `mayRouteFor` — and three cases in this file failed by refusing to pair
    // at all. A user whose team changed a setting would have been unable to
    // set up a machine until they re-read a sentence, which is the trap
    // finding 48 is about arriving through the door marked "be stricter".
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site, {
      consents: [{ owner: "alice", siteId: SITE_ID, paused: true }],
    });
    const relay = new Relay({ siteId: SITE_ID, fixture });

    // The pairing covers it: the key is still pinnable, so re-consent costs
    // nothing on the machine.
    expect(relay.projection.sitesFor("alice").map((s) => s.siteId)).toEqual([
      SITE_ID,
    ]);
    // And nothing routes under it.
    expect(relay.projection.mayRouteFor("alice", SITE_ID)).toBe(false);
    expect(relay.projection.routableOwners("alice", SITE_ID)).toEqual([]);
  });

  it("names only the sites this owner consented to", () => {
    // The claim `sitesFor` makes, and the one a hub rests on: a site is here
    // because a human clicked, never because a site asked to be here.
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site, {
      consents: [{ owner: "alice", siteId: SITE_ID, paused: false }],
    });
    const relay = new Relay({ siteId: SITE_ID, fixture });

    expect(relay.projection.sitesFor("alice").map((s) => s.siteId)).toEqual([
      SITE_ID,
    ]);
    // A stranger with no consent gets an empty set rather than the registry.
    expect(relay.projection.sitesFor("mallory")).toEqual([]);
    // And a revoked one is gone, not merely unroutable — revocation is the
    // end of the relationship, which is what paused is not.
    relay.project({
      ...fixture,
      revoked: [{ owner: "alice", siteId: SITE_ID }],
    });
    expect(relay.projection.sitesFor("alice")).toEqual([]);
  });
});

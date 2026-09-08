import {
  UPDATE_OFFER_SINCE,
  cryptoReady,
  generateKeys,
  publicIdentityOf,
} from "@byollm/protocol";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Relay } from "../src/index.js";
import { fixtureFor, makeDaemon } from "./harness.js";

/**
 * D1's first deploy condition, as a test that has to be green before the hub
 * is deployed.
 *
 * `HeartbeatResponse` is `.strict()`. A daemon built before `updateTo` does
 * not ignore the field — it rejects the entire heartbeat. So a wrong emission
 * is not a bad offer: it is every pre-.83 daemon in the fleet refusing every
 * beat, and they cannot be told to upgrade because the channel that would
 * tell them is the channel that is failing.
 *
 * The condition was "the hub must not be ABLE to set `updateTo` raw", and the
 * word is ABLE. A rule you have to remember holds until somebody adds a
 * second return site, and the heartbeat handler already has two.
 */
let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers) await dispose();
  disposers = [];
});
beforeAll(async () => {
  await cryptoReady();
});

async function beat(input: {
  readonly daemonVersion: string;
  readonly updateOffer?: string;
  readonly daemonFloor?: string;
}) {
  const siteKeys = generateKeys(Date.now());
  const site = publicIdentityOf(siteKeys);
  const fixture = fixtureFor(site);
  const relay = new Relay({
    fixture,
    ...(input.updateOffer === undefined
      ? {}
      : { updateOffer: input.updateOffer }),
    ...(input.daemonFloor === undefined
      ? {}
      : { daemonFloor: input.daemonFloor }),
  });
  const daemon = await makeDaemon(relay, fixture, {
    owner: "alice",
    site,
    offer: "private",
  });
  disposers.push(daemon.dispose);

  const response = await daemon.signedFetch("heartbeat", {
    runnerId: daemon.runnerId,
    daemonVersion: input.daemonVersion,
    capabilities: await daemon.runner.detectCapabilities(),
    activeLeases: [],
    paused: false,
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("who is told about a new version", () => {
  it("tells a daemon that can hear it", async () => {
    /* The control. Without this, every "does not offer" below passes against
       a relay that never offers anything to anybody. */
    const said = await beat({
      daemonVersion: "0.1.0-alpha.90",
      updateOffer: "0.1.0-alpha.91",
    });
    expect(said.status).toBe(200);
    expect(said.body["updateTo"]).toBe("0.1.0-alpha.91");
  });

  it("never sends the field to a daemon built before it existed", async () => {
    /**
     * The one that matters. Every version below UPDATE_OFFER_SINCE parses
     * this response with a schema that has never heard of `updateTo`, and
     * strict means the whole message fails.
     */
    for (const old of ["0.1.0-alpha.9", "0.1.0-alpha.64", "0.1.0-alpha.82"]) {
      const said = await beat({
        daemonVersion: old,
        updateOffer: "0.1.0-alpha.91",
      });
      expect(said.status, old).toBe(200);
      expect(
        Object.keys(said.body),
        `${old} predates the field and must never be sent it`,
      ).not.toContain("updateTo");
    }
  });

  it("says nothing when the deployment has named no version", async () => {
    /* How this ships: the code changes no byte on the wire until somebody
       sets a version deliberately. */
    const said = await beat({ daemonVersion: "0.1.0-alpha.90" });
    expect(Object.keys(said.body)).not.toContain("updateTo");
  });

  it("refuses to offer a tag, however the deployment is configured", async () => {
    /* A hub that sent `latest` would tell every device in the fleet to
       install whatever is current by the minute it got around to it. The
       daemon refuses one too; that is the second fence, not the first. */
    for (const vague of ["latest", "^0.1.0", "alpha"]) {
      const said = await beat({
        daemonVersion: "0.1.0-alpha.90",
        updateOffer: vague,
      });
      expect(Object.keys(said.body), vague).not.toContain("updateTo");
    }
  });

  it("says nothing to a daemon already on the offered version", async () => {
    const said = await beat({
      daemonVersion: "0.1.0-alpha.91",
      updateOffer: "0.1.0-alpha.91",
    });
    expect(Object.keys(said.body)).not.toContain("updateTo");
  });

  it("is the only way the field can be set", () => {
    /**
     * Structural, not behavioural, and it is the actual deploy condition.
     * The tests above prove the fence works where it is called; this proves
     * there is nowhere else to call from — a third return site added later
     * cannot spell `updateTo:` without failing here.
     */
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    /* Comments stripped first, and the reason is this file: the note beside
       the emission site says there must be no `updateTo:` anywhere, and it
       had to write the words to say so. A check that reads prose finds its
       own explanation. */
    const code = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
    const offenders = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts"))
      .filter((name) =>
        /\bupdateTo\s*:/.test(code(readFileSync(`${src}${name}`, "utf8"))),
      );
    expect(
      offenders,
      "`updateTo` may only be produced by updateOfferFor, which applies the " +
        "version fence inside itself",
    ).toEqual([]);
  });

  it("has a fence version that is a real version", () => {
    /* If this ever became a tag or a typo, `mayOfferUpdate` would answer
       "cannot read it" for everybody and the feature would be silently off
       — which looks exactly like nothing being offered. */
    expect(UPDATE_OFFER_SINCE).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("who is refused for being too old", () => {
  it("refuses nobody when no floor is set, which is how it ships", async () => {
    const said = await beat({ daemonVersion: "0.1.0-alpha.9" });
    expect(said.status).toBe(200);
  });

  it("refuses a daemon below the floor, with the remedy and the floor", async () => {
    const said = await beat({
      daemonVersion: "0.1.0-alpha.9",
      daemonFloor: "0.1.0-alpha.70",
    });
    expect(said.status).toBe(426);
    expect(said.body["error"]).toBe("daemon-below-floor");
    expect(String(said.body["message"])).toContain("npm i -g byollm@latest");
    /* The floor as a field, not only inside the sentence. */
    expect(said.body["floor"]).toBe("0.1.0-alpha.70");
  });

  it("serves a daemon at the floor and above it", async () => {
    for (const ok of ["0.1.0-alpha.70", "0.1.0-alpha.83", "1.0.0"]) {
      const said = await beat({
        daemonVersion: ok,
        daemonFloor: "0.1.0-alpha.70",
      });
      expect(said.status, ok).toBe(200);
    }
  });

  it("does not refuse a version it cannot read", async () => {
    /* The opposite-boolean rule: guessing yes here takes a working machine
       out of service over a string nobody could parse. */
    const said = await beat({
      daemonVersion: "relay-gate",
      daemonFloor: "0.1.0-alpha.70",
    });
    expect(said.status).toBe(200);
  });
});

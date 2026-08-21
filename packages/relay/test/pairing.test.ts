import {
  PROTOCOL_VERSION,
  cryptoReady,
  generateKeys,
  publicIdentityOf,
} from "@byollm/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { Relay } from "../src/index.js";
import { SITE_ID, fixtureFor } from "./harness.js";

/**
 * Cloud pairing, end to end — cloud_009.
 *
 * `byollm connect` has always spoken the device-code flow and the relay
 * accepted only the shape where a device is *already* approved, so a cloud
 * user's very first command failed schema validation. It survived 800 tests
 * because the conformance kit drives direct mode, which implements the flow,
 * and the hub's own proof seeds an approved row with a service key: **the
 * checks proved the parts and never the seam.**
 *
 * So this file is deliberately the seam. It drives the relay's own endpoint
 * with the bytes the shipped daemon sends, and it asserts the property that
 * makes the flow safe rather than merely working: **approval comes from the
 * control plane's projection, never from anything the relay or the daemon can
 * set.**
 */

const SITE = generateKeys(2_100_000_000_001);
const DEVICE = generateKeys(2_100_000_000_002);
const OWNER = "alice";

beforeAll(async () => {
  await cryptoReady();
});

const start = () => ({
  protocolVersion: PROTOCOL_VERSION,
  action: "start" as const,
  daemon: {
    version: "0.1.0-alpha.34",
    label: "studio-mac",
    platform: "darwin" as const,
  },
  device: publicIdentityOf(DEVICE),
  capabilities: [],
});

const pair = (relay: Relay, body: unknown) =>
  relay.handle(
    new Request("https://relay.test/byollm/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/** A projection with the site consented and no device approved yet. */
const unapproved = () =>
  fixtureFor(publicIdentityOf(SITE), {
    consents: [{ owner: OWNER, siteId: SITE_ID, paused: false }],
    devices: [],
  });

/** The same, after a human approved this machine in the dashboard. */
const approved = () =>
  fixtureFor(publicIdentityOf(SITE), {
    consents: [{ owner: OWNER, siteId: SITE_ID, paused: false }],
    devices: [
      {
        runnerId: "runner_studio",
        owner: OWNER,
        device: publicIdentityOf(DEVICE),
      },
    ],
  });

describe("the flow a real user walks", () => {
  it("mints a code a person can read, and sends them to the control plane", async () => {
    const relay = new Relay({
      fixture: unapproved(),
      verificationUrl: "https://dashboard.test/machines/approve",
    });

    const response = await pair(relay, start());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      userCode: string;
      deviceCode: string;
      verificationUrl: string;
    };

    // Readable aloud: Crockford's alphabet without the letters that become
    // other letters over a phone.
    expect(body.userCode).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    );
    // The secret half is not the readable half.
    expect(body.deviceCode).not.toBe(body.userCode);
    expect(body.deviceCode.length).toBeGreaterThanOrEqual(20);
    // And the human goes to the control plane, never to the relay.
    expect(body.verificationUrl).toBe(
      "https://dashboard.test/machines/approve",
    );
  });

  it("answers pending until the control plane says otherwise", async () => {
    const relay = new Relay({
      fixture: unapproved(),
      verificationUrl: "https://dashboard.test/machines/approve",
    });
    const { deviceCode } = (await (await pair(relay, start())).json()) as {
      deviceCode: string;
    };

    const pending = await (
      await pair(relay, {
        protocolVersion: PROTOCOL_VERSION,
        action: "poll",
        deviceCode,
      })
    ).json();
    expect(pending).toEqual({ status: "pending" });
  });

  it("approves when the projection carries the device, and returns the sites to pin", async () => {
    // The seam itself. Nothing in the poll approved anything: the dashboard
    // wrote the row to its own database and the projection caught up.
    const relay = new Relay({
      fixture: unapproved(),
      verificationUrl: "https://dashboard.test/machines/approve",
    });
    const { deviceCode } = (await (await pair(relay, start())).json()) as {
      deviceCode: string;
    };

    relay.project(approved());

    const body = (await (
      await pair(relay, {
        protocolVersion: PROTOCOL_VERSION,
        action: "poll",
        deviceCode,
      })
    ).json()) as {
      status: string;
      runnerId: string;
      owner: string;
      sites: Record<string, unknown>;
    };

    expect(body.status).toBe("approved");
    // The id comes from the control plane's row — one authority for identity,
    // and it is the one with a human in it.
    expect(body.runnerId).toBe("runner_studio");
    expect(body.owner).toBe(OWNER);
    expect(Object.values(body.sites)).toHaveLength(1);
  });

  it("spends the code on approval, so it answers once", async () => {
    const relay = new Relay({
      fixture: approved(),
      verificationUrl: "https://dashboard.test/machines/approve",
    });
    const { deviceCode } = (await (await pair(relay, start())).json()) as {
      deviceCode: string;
    };
    const poll = () =>
      pair(relay, {
        protocolVersion: PROTOCOL_VERSION,
        action: "poll",
        deviceCode,
      });

    expect(((await (await poll()).json()) as { status: string }).status).toBe(
      "approved",
    );
    // Second time: gone. A code that keeps answering is a second way to ask
    // a question that has already been answered.
    expect(((await (await poll()).json()) as { status: string }).status).toBe(
      "expired",
    );
  });
});

describe("what a code is worth on its own", () => {
  it("is nothing: an unknown code cannot be told from an expired one", async () => {
    // Distinguishing them would let somebody probe for live codes.
    const relay = new Relay({
      fixture: approved(),
      verificationUrl: "https://dashboard.test/machines/approve",
    });
    const body = await (
      await pair(relay, {
        protocolVersion: PROTOCOL_VERSION,
        action: "poll",
        deviceCode: "x".repeat(40),
      })
    ).json();
    expect(body).toEqual({ status: "expired" });
  });

  it("refuses a device whose keys do not verify", async () => {
    const relay = new Relay({
      fixture: unapproved(),
      verificationUrl: "https://dashboard.test/machines/approve",
    });
    const other = generateKeys(2_100_000_000_009);
    const response = await pair(relay, {
      ...start(),
      device: {
        ...publicIdentityOf(DEVICE),
        encryption: other.encryptionPublic,
      },
    });
    expect(response.status).toBe(400);
  });

  it("says so plainly when the relay does not offer the flow", async () => {
    // A relay with no verification URL cannot send anybody anywhere, and
    // answering "bad request" would blame the daemon for its own gap.
    const relay = new Relay({ fixture: unapproved() });
    const response = await pair(relay, start());
    expect(response.status).toBe(501);
  });
});

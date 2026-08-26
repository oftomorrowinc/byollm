import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROSTER_MAX_AGE_MS,
  generateKeys,
  publicIdentityOf,
  keyId,
  signRoster,
} from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { noSupervisor, removeTemp } from "./test-support.js";

/**
 * What a device says about the roster it holds — Amendment G, Phase B1.
 *
 * The B1 commit said "surface all of it, because a device that has narrowed
 * must be able to say why", and shipped a `rosterStatus()` that nothing
 * called. The mechanism was tested and the screen was not, which is the same
 * call-site gap that let three mutations survive the day before.
 *
 * So this drives `byollm status` and reads what a person would read. The
 * wording matters as much as the presence: B1 holds and verifies, and the
 * local allowlist still decides. A line saying two people may use this device
 * would be untrue until B2 flips admission.
 */
const NOW = 1_800_000_000_000;
const plane = generateKeys(NOW);
const site = publicIdentityOf(generateKeys(NOW));

let home: string;
let paths: DaemonPaths;
let out: string;

const io = (): Partial<CliIo> => ({
  out: (text) => {
    out += text;
  },
  // Discarded on purpose: `status` writes config problems here and this file
  // is about the roster lines on stdout.
  err: () => undefined,
});

async function pairedWith(extra: Record<string, unknown>) {
  await mkdir(home, { recursive: true });
  await writeFile(
    paths.pairings,
    JSON.stringify({
      version: 1,
      pairings: [
        {
          origin: "https://hub.test",
          runnerId: "r1",
          owner: "alice",
          sites: { [keyId(site.identity)]: site },
          known: { [keyId(site.identity)]: site },
          pairedAt: NOW,
          ...extra,
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    paths.config,
    JSON.stringify({
      services: {
        primary: {
          model: "m",
          kinds: ["llm.generate"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      },
    }),
    "utf8",
  );
}

const roster = (issuedAt: number, members: string[] = ["bob", "carol"]) =>
  signRoster(plane, { owner: "alice", members, issuedAt });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-rstatus-"));
  paths = daemonPaths(home);
  out = "";
});
afterEach(async () => {
  await removeTemp(home);
});

const status = () =>
  runCli(["status"], { paths, io: io(), service: noSupervisor() });

describe("what status says about a roster", () => {
  it("says nothing at all when this pairing pinned no key", async () => {
    // A pairing made before roster sync existed. Silence is right here: there
    // is no roster to describe and no question to answer, and a line about
    // rosters on every pre-existing device would be noise.
    await pairedWith({});
    await status();
    expect(out.toLowerCase()).not.toContain("roster");
  });

  it("says a key is pinned but nothing has arrived", async () => {
    await pairedWith({ controlPlanePublic: plane.identityPublic });
    await status();
    expect(out).toContain("no roster held yet");
  });

  it("names how many it holds, and that it does not decide yet", async () => {
    /**
     * The wording B1's state requires. The roster is held and verified; the
     * local allowlist still decides. Saying "2 people may use this device"
     * would be the flattering-copy bug in the sentence about who may use
     * somebody's computer.
     */
    await pairedWith({
      controlPlanePublic: plane.identityPublic,
      roster: roster(Date.now() - 120_000),
    });
    await status();
    expect(out).toContain("a signed roster of 2 is held");
    expect(out).toContain("does not decide yet");
    expect(out).toContain("2 minutes");
  });

  it("says it has gone stale, and what that means", async () => {
    // The state the whole bound exists for. A device that has narrowed must
    // be able to say why, or this is one more silent state.
    await pairedWith({
      controlPlanePublic: plane.identityPublic,
      roster: roster(Date.now() - ROSTER_MAX_AGE_MS - 60_000),
    });
    await status();
    expect(out).toContain("roster stale");
    expect(out).toContain("serving you only");
  });

  it("still says who may use the device, above all of it", async () => {
    // The positive control: the roster lines are an addition, not a
    // replacement. `who can use this device` is the answer people come for.
    await pairedWith({
      controlPlanePublic: plane.identityPublic,
      roster: roster(Date.now()),
    });
    await status();
    expect(out).toContain("who can use this device");
    expect(out).toContain("you, always");
    expect(out).toContain("nobody else");
  });
});

describe("what pairing writes down", () => {
  it("records the control-plane key the hub offered", async () => {
    /**
     * The call site a mutation caught me not testing, in the same session I
     * criticised myself for exactly this.
     *
     * Pairing is the only moment the key is offered. A daemon that does not
     * record it here can never verify a roster and will refuse every one it
     * is later sent — and the failure appears an hour after a deploy, at the
     * device, naming nothing that points at this line.
     */
    const { connect } = await import("./connect.js");
    const { ProtocolClient } = await import("./client.js");

    const device = publicIdentityOf(generateKeys(NOW));
    const sites = { [keyId(site.identity)]: site };
    const answers = [
      {
        deviceCode: "device-code-long-enough-for-schema",
        userCode: "ABCD-EFGH",
        verificationUrl: "https://hub.test/devices",
        expiresAt: NOW + 600_000,
        pollIntervalMs: 500,
      },
      {
        status: "approved",
        runnerId: "r1",
        owner: "alice",
        sites,
        controlPlanePublic: plane.identityPublic,
      },
    ];

    const result = await connect({
      client: new ProtocolClient({
        origin: "https://hub.test",
        fetch: (() =>
          Promise.resolve(
            new Response(JSON.stringify(answers.shift()), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          )) as unknown as typeof fetch,
      }),
      daemonVersion: "0.0.0",
      label: "test",
      capabilities: [],
      device,
      onCode: () => undefined,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pairing.controlPlanePublic).toBe(plane.identityPublic);
    }
  });

  it("records nothing when the hub offers none", async () => {
    // A direct-mode server has no control plane. The pairing must not invent
    // a key, and a daemon holding none refuses every roster — which is right.
    const { connect } = await import("./connect.js");
    const { ProtocolClient } = await import("./client.js");

    const device = publicIdentityOf(generateKeys(NOW));
    const answers = [
      {
        deviceCode: "device-code-long-enough-for-schema",
        userCode: "ABCD-EFGH",
        verificationUrl: "https://hub.test/devices",
        expiresAt: NOW + 600_000,
        pollIntervalMs: 500,
      },
      {
        status: "approved",
        runnerId: "r1",
        owner: "alice",
        sites: { [keyId(site.identity)]: site },
      },
    ];

    const result = await connect({
      client: new ProtocolClient({
        origin: "https://hub.test",
        fetch: (() =>
          Promise.resolve(
            new Response(JSON.stringify(answers.shift()), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          )) as unknown as typeof fetch,
      }),
      daemonVersion: "0.0.0",
      label: "test",
      capabilities: [],
      device,
      onCode: () => undefined,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });

    expect(result.ok && result.pairing.controlPlanePublic).toBeUndefined();
  });
});

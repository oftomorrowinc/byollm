import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeys, publicIdentityOf } from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { writeHealth } from "./health.js";
import { Pairings } from "./pairings.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { clearRevokedMark } from "./revoked.js";
import { removeTemp } from "./test-support.js";

/**
 * The parked daemon has to notice the remedy — ruled 2026-09-03.
 *
 * Todd revoked a machine, re-paired it, and it stayed dark. Everything had
 * worked: `connect` said "paired", the mark was cleared, the pairing was on
 * disk. But the daemon under launchd was parked on its abort signal, and
 * `connect` runs in a different process — it could hand the news to the file
 * and to nobody else. Only a restart by hand brought the machine back, and
 * nothing on any screen had asked for one.
 *
 * What is under test is the crossing between two processes, so the test uses
 * two writers: the daemon runs, and the files change underneath it the way
 * `connect` would change them.
 */
const ORIGIN = "http://127.0.0.1:1";
const SITE = publicIdentityOf(generateKeys(1_800_000_000_000));

let home: string;
let paths: DaemonPaths;
let err: string;
let out: string;

const io = (): Partial<CliIo> => ({
  out: (text) => {
    out += text;
  },
  err: (text) => {
    err += text;
  },
  confirm: () => Promise.resolve(false),
});

/** Wait for `err` to say something, rather than for a duration. */
async function until(
  predicate: () => boolean,
  what: string,
  budgetMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-parked-"));
  paths = daemonPaths(home);
  err = "";
  out = "";
  await writeFile(
    paths.config,
    JSON.stringify({
      services: {
        local: {
          model: "m",
          kinds: ["llm.generate"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:1/v1",
        },
      },
    }),
  );
  // Revoked, and holding no pairing — the state a machine parks in.
  await writeHealth(paths.health, {
    at: 1_800_000_000_000,
    consecutiveFailures: 0,
    origin: ORIGIN,
    revoked: { at: 1_800_000_000_000, origin: ORIGIN },
  });
});

afterEach(async () => {
  await removeTemp(home);
});

/** What `byollm connect` leaves behind, written by the other process. */
async function repair(): Promise<void> {
  const pairings = new Pairings(paths.pairings);
  await pairings.load();
  await pairings.put({
    origin: ORIGIN,
    runnerId: "runner-1",
    owner: "owner-1",
    pairedAt: 1_800_000_000_000,
    sites: { "site-1": SITE },
  });
  await clearRevokedMark(paths.health);
}

describe("what a revoked daemon promises", () => {
  it("only offers a self-return where something can deliver one", async () => {
    /* The remedy prints on both branches, and only one of them has a
       supervisor in it. Somebody running the daemon in their own terminal
       gets the re-pair step and no promise about a service coming back,
       because on their machine nothing would. */
    await runCli(["run"], { paths, io: io(), supervised: false });
    expect(err).toContain("byollm connect");
    expect(err).not.toContain("returns by itself");
  }, 30_000);
});

describe("a parked daemon, after the remedy is applied", () => {
  it("returns to service without anybody restarting it", async () => {
    const stop = new AbortController();
    const run = runCli(["run"], {
      paths,
      io: io(),
      signal: stop.signal,
      parkPollMs: 25,
      supervised: true,
    });

    // Parked first, or the rest of this proves nothing about waking up.
    await until(() => err.includes("revoked"), "the daemon to park");
    // And parked, not exited: an exit here would be launchd's restart loop,
    // which is the thing this whole branch refuses to hand the supervisor.
    expect(out).not.toContain("stopped");
    expect(err).not.toContain("returning to service");

    await repair();

    await until(
      () => err.includes("returning to service"),
      "the daemon to promote itself",
    );

    stop.abort();
    await run;
  }, 30_000);

  it("stays parked while the mark stands, however many times it looks", async () => {
    /* The control. A poll that promoted on a timer rather than on the facts
       would pass the test above and would un-revoke every revoked machine on
       earth after fifteen seconds. */
    const stop = new AbortController();
    const run = runCli(["run"], {
      paths,
      io: io(),
      signal: stop.signal,
      parkPollMs: 25,
      supervised: true,
    });

    await until(() => err.includes("revoked"), "the daemon to park");
    // Long enough for many polls at this interval.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(err).not.toContain("returning to service");

    stop.abort();
    await run;
  }, 30_000);

  it("stays parked when the mark clears but nothing is paired", async () => {
    /* Two facts have to agree. `revokedMark` reads `undefined` both for a
       cleared mark and for a health file it could not read, so a promotion
       resting on that alone would treat an unreadable file as good news. */
    const stop = new AbortController();
    const run = runCli(["run"], {
      paths,
      io: io(),
      signal: stop.signal,
      parkPollMs: 25,
      supervised: true,
    });

    await until(() => err.includes("revoked"), "the daemon to park");
    await clearRevokedMark(paths.health);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(err).not.toContain("returning to service");

    stop.abort();
    await run;
  }, 30_000);
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fingerprint,
  generateKeys,
  keyId,
  publicIdentityOf,
} from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { Pairings } from "./pairings.js";
import { removeTemp } from "./test-support.js";

/**
 * The screen that reports what this device serves — byollm_016 Amendment K.
 *
 * `byollm sites` used to be half of a ceremony: it showed a fingerprint to
 * compare, and `byollm approve` pinned the key that had been on screen. The
 * ceremony is gone — site policy is the control plane's now — so this command
 * reports rather than asks, and `approve` leaves a tombstone.
 *
 * The pinned-but-not-offered rows matter more than they did, not less: with
 * the decision moved to an account, this is the only place on the machine
 * where the keys it is still holding are visible.
 */

const SITE = publicIdentityOf(generateKeys(1_800_000_000_000));
const SITE_ID = keyId(SITE.identity);
const OTHER = publicIdentityOf(generateKeys(1_800_000_000_777));
const OTHER_ID = keyId(OTHER.identity);

let home: string;
let paths: DaemonPaths;
let out: string;
let err: string;

const io = (): Partial<CliIo> => ({
  out: (text) => {
    out += text;
  },
  err: (text) => {
    err += text;
  },
  confirm: () => Promise.resolve(false),
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-sites-"));
  paths = daemonPaths(home);
  out = "";
  err = "";
});

afterEach(async () => {
  await removeTemp(home);
});

async function pairWith(options: {
  sites?: Record<string, typeof SITE>;
  known?: Record<string, typeof SITE>;
}): Promise<Pairings> {
  const pairings = new Pairings(paths.pairings);
  await pairings.load();
  await pairings.put({
    origin: "https://hub.test",
    runnerId: "runner_1",
    owner: "me",
    sites: options.sites ?? {},
    ...(options.known ? { known: options.known } : {}),
    pairedAt: Date.now(),
  });
  return pairings;
}

describe("byollm sites", () => {
  it("says so when nothing is paired", async () => {
    expect(await runCli(["sites"], { paths, io: io() })).toBe(0);
    expect(out).toContain("byollm connect");
  });

  it("shows what is served, with the fingerprint", async () => {
    await pairWith({ sites: { [SITE_ID]: SITE } });
    expect(await runCli(["sites"], { paths, io: io() })).toBe(0);
    expect(out).toContain("https://hub.test");
    expect(out).toContain("serving");
    expect(out).toContain(fingerprint(SITE.identity));
  });

  it("says the fingerprint once, not twice", async () => {
    // The id *is* the fingerprint's source, so printing both is one fact
    // wearing two hats — and the longer one is the one nobody can compare.
    await pairWith({ sites: { [SITE_ID]: SITE } });
    await runCli(["sites"], { paths, io: io() });
    const print = fingerprint(SITE.identity);
    expect(out.split(print).length - 1).toBe(1);
  });

  it("shows a site it still holds a key for but nobody is offering", async () => {
    // A pin outlives consent, so that remove-then-re-add is refused rather
    // than read as a new site. This row is how somebody can see what they are
    // still holding — and with site policy in an account, it is the only
    // place on the machine that shows it.
    await pairWith({ sites: {}, known: { [OTHER_ID]: OTHER } });
    expect(await runCli(["sites"], { paths, io: io() })).toBe(0);
    expect(out).toContain("pinned");
    expect(out).toContain("not offered right now");
  });

  it("does not ask for anything, because there is nothing to answer", async () => {
    // The ceremony is gone. A screen that still said "WAITING" would be
    // asking a question no command can answer any more.
    await pairWith({ sites: { [SITE_ID]: SITE } });
    await runCli(["sites"], { paths, io: io() });
    expect(out).not.toContain("WAITING");
    expect(out).not.toContain("approve");
  });
});

describe("byollm approve — the tombstone", () => {
  it("refuses with exit 2 and says where sites are decided now", async () => {
    expect(await runCli(["approve", SITE_ID], { paths, io: io() })).toBe(2);
    expect(err).toContain("is gone");
    expect(err).toContain("dashboard");
  });

  it("names the levers the device still has", async () => {
    // A refusal with nothing to do about it is noise. The device gave up the
    // per-site yes; it kept `pause` and `forget`, and the message says so.
    await runCli(["approve", "--all"], { paths, io: io() });
    expect(err).toContain("byollm pause");
  });
});

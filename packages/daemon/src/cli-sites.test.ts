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
 * The screen where somebody answers, and the command that answers — V1-1.
 *
 * A site the upstream adds is a question now, not an instruction, and a
 * question with no screen is a question nobody answers. These two commands
 * are that screen: `byollm sites` shows the fingerprint to compare against
 * what the site displays, and `byollm approve` pins the key that was on
 * screen — not one re-fetched from the party being checked.
 */

const SITE = publicIdentityOf(generateKeys(1_800_000_000_000));
const SITE_ID = keyId(SITE.identity);
const WAITING = publicIdentityOf(generateKeys(1_800_000_000_777));
const WAITING_ID = keyId(WAITING.identity);

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
  pending?: Record<string, typeof SITE>;
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
    ...(options.pending ? { pending: options.pending } : {}),
    pairedAt: Date.now(),
  });
  return pairings;
}

describe("byollm sites", () => {
  it("says so when nothing is paired", async () => {
    expect(await runCli(["sites"], { paths, io: io() })).toBe(0);
    expect(out).toContain("byollm connect");
  });

  it("shows what is served, what is waiting, and the fingerprint to compare", async () => {
    await pairWith({
      sites: { [SITE_ID]: SITE },
      pending: { [WAITING_ID]: WAITING },
    });

    expect(await runCli(["sites"], { paths, io: io() })).toBe(0);
    expect(out).toContain(`serving  ${fingerprint(SITE.identity)}`);
    expect(out).toContain(fingerprint(SITE.identity));
    expect(out).toContain(`WAITING  ${fingerprint(WAITING.identity)}`);
    // The fingerprint of the *waiting* site is the one thing this screen
    // exists for: approving an id without it is agreeing to a name.
    expect(out).toContain(fingerprint(WAITING.identity));
    expect(out).toContain(`byollm approve ${WAITING_ID}`);
    expect(out).toContain("1 site waiting");
  });

  it("says the fingerprint once, not twice", async () => {
    /**
     * A site's id in this file *is* its fingerprint — `keyId` and
     * `fingerprint` are the same function, and `runner.ts` refuses any entry
     * where they disagree. So printing both put the same string on two lines
     * under two labels, which reads as two facts to check against each other
     * and is one.
     *
     * Asserted as "no value repeats" rather than as an exact layout: the
     * defect is a duplicated value, and a test pinned to the current spacing
     * would fail on a redesign that is fine and pass on a repeat that is not.
     */
    await pairWith({
      sites: { [SITE_ID]: SITE },
      pending: { [WAITING_ID]: WAITING },
    });
    await runCli(["sites"], { paths, io: io() });

    // The approve line legitimately names the waiting id a second time — it
    // is a command to run, not a value to compare — so it is excluded by
    // being a line that contains a backtick.
    const values = out
      .split("\n")
      .filter((line) => !line.includes("`"))
      .flatMap((line) => line.match(/BYOLLM-[A-Z0-9-]+/g) ?? []);

    expect(values.length, out).toBe(new Set(values).size);
    // And the positive control: both fingerprints are still on screen, which
    // is what this command is for.
    expect(values).toContain(fingerprint(SITE.identity));
    expect(values).toContain(fingerprint(WAITING.identity));
  });

  it("shows a site it still holds a key for but nobody is offering", async () => {
    // Approved once, consent since ended. Worth showing: a key kept for a
    // relationship that is not currently live is exactly the thing somebody
    // should be able to see they are still holding.
    await pairWith({ sites: {}, known: { [SITE_ID]: SITE } });
    await runCli(["sites"], { paths, io: io() });
    expect(out).toContain(`approved ${SITE_ID} (not offered right now)`);
  });
});

describe("byollm approve", () => {
  it("pins the waiting site and stops it waiting", async () => {
    await pairWith({ pending: { [WAITING_ID]: WAITING } });

    expect(await runCli(["approve", WAITING_ID], { paths, io: io() })).toBe(0);
    expect(out).toContain(`approved ${WAITING_ID}`);

    const pairings = new Pairings(paths.pairings);
    await pairings.load();
    const pairing = pairings.get("https://hub.test");
    // Into `known`, which is what the running loop reads back and what a
    // re-offered id is compared against for the life of the pairing.
    expect(pairing?.known?.[WAITING_ID]).toEqual(WAITING);
    // And out of `pending` entirely — a file that says "waiting on nothing"
    // and a file that says nothing should not be two different files.
    expect(pairing?.pending).toBeUndefined();
  });

  it("takes the fingerprint as the name, because that is what was compared", async () => {
    await pairWith({ pending: { [WAITING_ID]: WAITING } });
    expect(
      await runCli(["approve", fingerprint(WAITING.identity)], {
        paths,
        io: io(),
      }),
    ).toBe(0);
    const pairings = new Pairings(paths.pairings);
    await pairings.load();
    expect(pairings.get("https://hub.test")?.known?.[WAITING_ID]).toEqual(
      WAITING,
    );
  });

  it("approves only what is waiting now, even with --all", async () => {
    // `--all` is a convenience for somebody who just connected three sites on
    // a dashboard. It must never mean "and anything that turns up later" —
    // that would be the standing permission this whole fence exists to
    // withhold.
    await pairWith({ pending: { [WAITING_ID]: WAITING } });
    expect(await runCli(["approve", "--all"], { paths, io: io() })).toBe(0);

    const pairings = new Pairings(paths.pairings);
    await pairings.load();
    expect(Object.keys(pairings.get("https://hub.test")?.known ?? {})).toEqual([
      WAITING_ID,
    ]);

    out = "";
    err = "";
    expect(await runCli(["approve", "--all"], { paths, io: io() })).toBe(1);
    expect(err).toContain("nothing is waiting");
  });

  it("refuses a name nothing is waiting under, and says where to look", async () => {
    await pairWith({ pending: { [WAITING_ID]: WAITING } });
    expect(await runCli(["approve", SITE_ID], { paths, io: io() })).toBe(1);
    expect(err).toContain("byollm sites");
  });

  it("refuses to approve nothing in particular", async () => {
    expect(await runCli(["approve"], { paths, io: io() })).toBe(2);
    expect(err).toContain("usage:");
  });

  it("approves one of several and leaves the rest waiting", async () => {
    const third = publicIdentityOf(generateKeys(1_800_000_000_555));
    const thirdId = keyId(third.identity);
    await pairWith({
      sites: {},
      pending: { [WAITING_ID]: WAITING, [thirdId]: third },
    });

    expect(await runCli(["approve", WAITING_ID], { paths, io: io() })).toBe(0);

    const pairings = new Pairings(paths.pairings);
    await pairings.load();
    const pairing = pairings.get("https://hub.test");
    expect(Object.keys(pairing?.known ?? {})).toEqual([WAITING_ID]);
    // The other question is still open. An approval that cleared the queue
    // would be `--all` with extra steps.
    expect(Object.keys(pairing?.pending ?? {})).toEqual([thirdId]);
  });

  it("counts the waiting sites in words a person can act on", async () => {
    const third = publicIdentityOf(generateKeys(1_800_000_000_555));
    await pairWith({
      sites: {},
      pending: { [WAITING_ID]: WAITING, [keyId(third.identity)]: third },
    });
    await runCli(["sites"], { paths, io: io() });
    expect(out).toContain("2 sites waiting");
    // And a pairing serving nobody says so rather than showing an empty gap.
    expect(out).toContain("(serving nothing right now)");
  });
});

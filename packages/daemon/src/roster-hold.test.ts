import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeys, signRoster, ROSTER_MAX_AGE_MS } from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Allowlist } from "./allowlist.js";
import { Budgets } from "./budgets.js";
import { IngressLog } from "./ingress.js";
import { SpendLedger } from "./spend.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { ProtocolClient } from "./client.js";
import { Runner, type RunnerEvent } from "./runner.js";

/**
 * What a device does with a roster somebody handed it — Amendment G, Phase B.
 *
 * The amendment's claim is that a compromised relay cannot change who a device
 * serves. `roster.test.ts` proves the document refuses tampering; this proves
 * the *daemon* refuses it — that the verification is wired, that a refused
 * roster does not replace a good one, and that a held roster stops counting
 * when it ages out.
 */
const NOW = 1_800_000_000_000;
const plane = generateKeys(NOW);
const other = generateKeys(NOW);

let dir: string;
let now = NOW;
const events: RunnerEvent[] = [];

async function makeRunner(controlPlanePublic?: string) {
  const loaded = resolveConfig(
    DaemonConfig.parse({
      services: {
        primary: {
          model: "m",
          kinds: ["llm.generate"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      },
    }),
  );
  const allowlist = new Allowlist(join(dir, "allow.json"));
  await allowlist.load();
  const budgets = new Budgets(join(dir, "b.json"), loaded.config.community);
  await budgets.load(now);
  const spend = new SpendLedger(join(dir, "s.json"));
  await spend.load(now);
  const ingress = new IngressLog({
    path: join(dir, "i.log"),
    communityPromptDays: 7,
    keepSelfPrompts: true,
  });
  return new Runner({
    client: new ProtocolClient({ origin: "https://hub.test" }),
    runnerId: "r1",
    owner: "alice",
    daemonVersion: "0.0.0",
    loaded,
    allowlist,
    budgets,
    spend,
    ingress,
    now: () => now,
    onEvent: (e) => events.push(e),
    ...(controlPlanePublic === undefined ? {} : { controlPlanePublic }),
  });
}

const roster = (over: { members?: string[]; issuedAt?: number } = {}) =>
  signRoster(plane, {
    owner: "alice",
    members: over.members ?? ["bob", "carol"],
    issuedAt: over.issuedAt ?? NOW,
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-roster-"));
  now = NOW;
  events.length = 0;
});
afterEach(() => {
  events.length = 0;
});

describe("holding a roster", () => {
  it("holds one that verifies against the pinned key", async () => {
    const runner = await makeRunner(plane.identityPublic);
    runner.applyRosterForTest(roster());
    expect(runner.rosterMembers()).toEqual(["bob", "carol"]);
    expect(runner.rosterStatus()).toMatchObject({ held: true, members: 2 });
  });

  it("names an unpinned pairing as such, not as a bad signature", async () => {
    /**
     * The distinction the whole notice rests on. Nothing was checked here —
     * there was no key to check with — so calling it `bad-signature` would
     * describe a verification that never happened and send somebody looking
     * for a forgery.
     *
     * It is also the only refusal with a remedy: re-pair. Collapsing it into
     * the generic one loses the sentence a person can act on, which a
     * mutation proved was worth its own test.
     */
    const runner = await makeRunner();
    runner.applyRosterForTest(roster());
    expect(runner.rosterRefusal()).toBe("no-pinned-key");
    expect(runner.rosterStatus()).toMatchObject({ refusal: "no-pinned-key" });
  });

  it("holds nothing when no key was pinned", async () => {
    // A pairing with no control-plane key has nothing to check a signature
    // against. Accepting the roster anyway would be trusting whoever handed
    // it over, which is the substitution pinning exists to refuse.
    const runner = await makeRunner();
    runner.applyRosterForTest(roster());
    expect(runner.rosterMembers()).toBeUndefined();
    expect(events.map((e) => e.type)).toContain("roster-refused");
  });

  it("refuses one signed by anybody else", async () => {
    const runner = await makeRunner(plane.identityPublic);
    runner.applyRosterForTest(
      signRoster(other, {
        owner: "alice",
        members: ["mallory"],
        issuedAt: NOW,
      }),
    );
    expect(runner.rosterMembers()).toBeUndefined();
  });

  it("keeps the roster it has when a bad one arrives", async () => {
    /**
     * A relay that could replace a good roster with a broken one would narrow
     * this device on demand — the denial this design accepts, sharpened into
     * something it does not.
     */
    const runner = await makeRunner(plane.identityPublic);
    runner.applyRosterForTest(roster());
    runner.applyRosterForTest({ ...roster(), members: ["mallory"] });
    expect(runner.rosterMembers()).toEqual(["bob", "carol"]);
  });

  it("refuses an older document than the one it holds", async () => {
    // Replay inside the age window: yesterday's membership over today's, with
    // a signature that verifies perfectly.
    const runner = await makeRunner(plane.identityPublic);
    runner.applyRosterForTest(roster({ issuedAt: NOW, members: ["bob"] }));
    runner.applyRosterForTest(
      roster({ issuedAt: NOW - 1000, members: ["bob", "mallory"] }),
    );
    expect(runner.rosterMembers()).toEqual(["bob"]);
  });

  it("stops counting a roster once it ages out", async () => {
    // Staleness is revocation latency. A membership this device can no longer
    // confirm is not one it may act on.
    const runner = await makeRunner(plane.identityPublic);
    runner.applyRosterForTest(roster());
    now = NOW + ROSTER_MAX_AGE_MS + 1;
    expect(runner.rosterMembers()).toBeUndefined();
    expect(runner.rosterStatus()).toMatchObject({ held: true, stale: true });
  });

  it("says nothing arrived, distinctly from admitting nobody", async () => {
    const runner = await makeRunner(plane.identityPublic);
    expect(runner.rosterMembers()).toBeUndefined();
    expect(runner.rosterStatus()).toMatchObject({ held: false, members: 0 });
  });
});

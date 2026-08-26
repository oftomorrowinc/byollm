import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeys, signRoster, ROSTER_MAX_AGE_MS } from "@byollm/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { Allowlist } from "./allowlist.js";
import { Budgets } from "./budgets.js";
import { IngressLog } from "./ingress.js";
import { SpendLedger } from "./spend.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { ProtocolClient } from "./client.js";
import { Runner } from "./runner.js";

/**
 * Who this device serves, and on whose authority — Amendment G, Phase B2.
 *
 * The flip. Two regimes, decided by whether this pairing pinned a
 * control-plane key, and never both at once — an allowlist consulted
 * alongside a roster would be two authorities on one question, which is what
 * byollm_016 removed from `team` in the first place.
 */
const NOW = 1_800_000_000_000;
const plane = generateKeys(NOW);
const ORIGIN = "https://hub.test";

let dir: string;
let now = NOW;

async function makeRunner(opts: { key?: string } = {}) {
  const loaded = resolveConfig(
    DaemonConfig.parse({
      services: {
        primary: {
          model: "m",
          kinds: ["llm.generate"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          offer: "team",
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
  const runner = new Runner({
    client: new ProtocolClient({ origin: ORIGIN }),
    runnerId: "r1",
    owner: "alice",
    daemonVersion: "0.0.0",
    loaded,
    allowlist,
    budgets,
    spend,
    ingress,
    now: () => now,
    ...(opts.key === undefined ? {} : { controlPlanePublic: opts.key }),
  });
  return { runner, allowlist };
}

const roster = (members: string[], issuedAt = NOW) =>
  signRoster(plane, { owner: "alice", members, issuedAt });

/** Whether a claimed job from `owner` would be admitted. */
const admits = (runner: Runner, owner: string): boolean =>
  runner.admit({
    id: "j1",
    kind: "llm.generate",
    audience: "team",
    owner,
    site: "BYOLLM-TEST-SITE",
    sizeClass: "small",
    streaming: false,
    deadlineAt: now + 60_000,
    lease: { id: "l1", runnerId: "r1", expiresAt: now + 60_000 },
  } as never).ok;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-admit-"));
  now = NOW;
});

describe("with a roster", () => {
  it("admits the people the control plane signed for", async () => {
    const { runner } = await makeRunner({ key: plane.identityPublic });
    runner.applyRosterForTest(roster(["bob", "carol"]));
    expect(admits(runner, "bob")).toBe(true);
    expect(admits(runner, "carol")).toBe(true);
  });

  it("refuses somebody the roster does not name", async () => {
    const { runner } = await makeRunner({ key: plane.identityPublic });
    runner.applyRosterForTest(roster(["bob"]));
    expect(admits(runner, "mallory")).toBe(false);
  });

  it("cannot be widened by the local list — nothing local adds", async () => {
    /**
     * Property 3, and the half that is easy to get wrong. An allowlist entry
     * on a device whose upstream signs rosters must change nothing: an owner
     * who wants somebody served edits the roster, which is the one place
     * membership lives.
     */
    const { runner, allowlist } = await makeRunner({
      key: plane.identityPublic,
    });
    await allowlist.add({ origin: ORIGIN, owner: "mallory" }, now);
    runner.applyRosterForTest(roster(["bob"]));
    expect(admits(runner, "mallory")).toBe(false);
  });

  it("is narrowed by the local veto — the veto subtracts", async () => {
    // The other half. An owner who wants somebody stopped needs it to work on
    // this machine, now, without waiting on a sync that may never arrive.
    const { runner, allowlist } = await makeRunner({
      key: plane.identityPublic,
    });
    await allowlist.veto({ origin: ORIGIN, owner: "carol" }, now);
    runner.applyRosterForTest(roster(["bob", "carol"]));
    expect(admits(runner, "bob")).toBe(true);
    expect(admits(runner, "carol")).toBe(false);
  });

  it("admits nobody once the roster ages out", async () => {
    // Property 4. Staleness is revocation latency: a membership this device
    // can no longer confirm is not one it may act on, and failing wide would
    // make a partitioned device the most permissive on the network.
    const { runner } = await makeRunner({ key: plane.identityPublic });
    runner.applyRosterForTest(roster(["bob"]));
    expect(admits(runner, "bob")).toBe(true);
    now = NOW + ROSTER_MAX_AGE_MS + 1;
    expect(admits(runner, "bob")).toBe(false);
  });

  it("admits nobody when no roster has arrived", async () => {
    // Absent is not "admit everyone" and not the allowlist either: a device
    // that pinned a key has an authority to consult and has not heard from it.
    const { runner, allowlist } = await makeRunner({
      key: plane.identityPublic,
    });
    await allowlist.add({ origin: ORIGIN, owner: "bob" }, now);
    expect(admits(runner, "bob")).toBe(false);
  });
});

describe("without a roster — direct mode, and every pairing that predates one", () => {
  it("still decides by the local allowlist, exactly as before", async () => {
    // Not a fallback and not a transition: direct mode has no control plane
    // to author a roster, so this is the other half of the design.
    const { runner, allowlist } = await makeRunner();
    await allowlist.add({ origin: ORIGIN, owner: "bob" }, now);
    expect(admits(runner, "bob")).toBe(true);
    expect(admits(runner, "mallory")).toBe(false);
  });
});

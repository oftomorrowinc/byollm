import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fingerprint,
  generateKeys,
  keyId,
  publicIdentityOf,
  signRequest,
  RETIREMENT_WINDOW_MS,
  signSuccession,
  type PublicIdentity,
  type Succession,
} from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Allowlist } from "./allowlist.js";
import { Budgets } from "./budgets.js";
import { ProtocolClient } from "./client.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { IngressLog } from "./ingress.js";
import { Runner, type RunnerEvent } from "./runner.js";
import { SpendLedger } from "./spend.js";
import { removeTemp } from "./test-support.js";

/**
 * A site that rotates its key — byollm_009 Amendment C.
 *
 * This file sits beside `site-approval.test.ts` on purpose, because it is the
 * same rule from the other side. That file proves a key cannot move under an
 * id somebody approved. This one proves the single transition where a *new*
 * id is adopted without a new ceremony — and the reason the two do not
 * contradict is mechanical rather than a matter of interpretation:
 *
 *   a substitution presents different bytes **for the same key id**;
 *   a succession presents a **new key id** plus a signature by the old one
 *   over a statement naming both.
 *
 * The dangerous version of this feature is also the attack V1-1 exists to
 * refuse, so every accept case here is paired with the forgery it is nearest
 * to.
 */

const K1 = generateKeys(1_900_000_000_001);
const K2 = generateKeys(1_900_000_000_002);
const K3 = generateKeys(1_900_000_000_003);
const IMPOSTOR = generateKeys(1_900_000_000_666);
const DEVICE = generateKeys(1_900_000_000_010);

const id = (keys: typeof K1) => keyId(publicIdentityOf(keys).identity);

let dir: string;
let events: RunnerEvent[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-rotation-"));
  events = [];
});

afterEach(async () => {
  await removeTemp(dir);
});

interface Announcement {
  readonly sites: Record<string, PublicIdentity>;
  readonly successions?: Record<
    string,
    { succeeds: Succession[]; retiringUntil?: number }
  >;
}

/** A heartbeat announcing a set and, optionally, how it got there. */
function upstream(announce: () => Announcement): typeof fetch {
  return (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const endpoint = url.split("/").pop() ?? "";
    const { sites, successions } = announce();
    const body =
      endpoint === "heartbeat"
        ? {
            sites,
            ...(successions ? { successions } : {}),
            awaitingConsent: [],
            cancel: [],
            lost: [],
            serverTime: Date.now(),
          }
        : endpoint === "claim"
          ? { jobs: [], leaseMs: 60_000 }
          : { released: [] };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

async function runnerWith(
  fetchImpl: typeof fetch,
  identity: {
    sites: Map<string, PublicIdentity>;
    known?: Map<string, PublicIdentity>;
  },
): Promise<Runner> {
  const loaded = resolveConfig(
    DaemonConfig.parse({
      backends: {
        primary: {
          backend: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          offer: "self",
        },
      },
      routes: { "llm.generate": { backend: "primary", model: "m" } },
    }),
  );
  const allowlist = new Allowlist(join(dir, "allow.json"));
  await allowlist.load();
  const budgets = new Budgets(join(dir, "b.json"), loaded.config.community);
  await budgets.load(Date.now());
  const spend = new SpendLedger(join(dir, "spend.json"));
  await spend.load(Date.now());

  return new Runner({
    client: new ProtocolClient({
      origin: "https://hub.test",
      identity: {
        runnerId: "runner_1",
        sign: (input: {
          endpoint: string;
          runnerId: string;
          issuedAt: number;
          body: string;
        }) => signRequest(DEVICE, input).signature,
      },
      fetch: fetchImpl,
    }),
    runnerId: "runner_1",
    owner: "me",
    identity: {
      keys: () => Promise.resolve(DEVICE),
      sites: identity.sites,
      known: identity.known ?? new Map(),
    },
    daemonVersion: "0.0.0",
    loaded,
    allowlist,
    budgets,
    spend,
    ingress: new IngressLog({
      path: join(dir, "ingress.log"),
      communityPromptDays: 7,
      keepSelfPrompts: true,
    }),
    heartbeatMs: 5,
    onEvent: (event) => events.push(event),
  });
}

/** This machine has approved K1 and is serving it. */
const approvedK1 = () => ({
  sites: new Map([[id(K1), publicIdentityOf(K1)]]),
  known: new Map([[id(K1), publicIdentityOf(K1)]]),
});

describe("a site proving it is still itself", () => {
  it("moves the approval to the new key, without asking again [SITES_LOCALLY_APPROVED]", async () => {
    const runner = await runnerWith(
      upstream(() => ({
        sites: { [id(K2)]: publicIdentityOf(K2) },
        successions: {
          [id(K2)]: { succeeds: [signSuccession(K1, publicIdentityOf(K2))] },
        },
      })),
      approvedK1(),
    );
    await runner.tick();

    // Served, and pinned to the new key.
    expect(runner.sites.get(id(K2))).toEqual(publicIdentityOf(K2));
    // Not queued for a human. Requiring a second ceremony here is what trains
    // people to approve keys they cannot check — C.3.
    expect(runner.pending.has(id(K2))).toBe(false);
    expect(events.some((e) => e.type === "site-awaiting-approval")).toBe(false);
  });

  it("says so, with both fingerprints", async () => {
    // Ruling 3's second condition: automatic, therefore never silent. A
    // rotation that produced no line anywhere would make "your machine only
    // serves keys you approved" quietly untrue.
    const runner = await runnerWith(
      upstream(() => ({
        sites: { [id(K2)]: publicIdentityOf(K2) },
        successions: {
          [id(K2)]: { succeeds: [signSuccession(K1, publicIdentityOf(K2))] },
        },
      })),
      approvedK1(),
    );
    await runner.tick();

    const rotated = events.find((e) => e.type === "site-rotated");
    expect(rotated).toMatchObject({
      site: id(K2),
      from: id(K1),
      fromFingerprint: fingerprint(publicIdentityOf(K1).identity),
      fingerprint: fingerprint(publicIdentityOf(K2).identity),
    });
  });

  it("walks two rotations for a daemon that was switched off", async () => {
    // The case that makes the chain a list rather than one predecessor. This
    // machine holds K1 and meets K3; with a single predecessor it could not
    // check K3 without K2's record and would have to re-pair — a ceremony
    // caused by our housekeeping rather than by anything the user did.
    const runner = await runnerWith(
      upstream(() => ({
        sites: { [id(K3)]: publicIdentityOf(K3) },
        successions: {
          [id(K3)]: {
            succeeds: [
              signSuccession(K1, publicIdentityOf(K2)),
              signSuccession(K2, publicIdentityOf(K3)),
            ],
          },
        },
      })),
      approvedK1(),
    );
    await runner.tick();

    expect(runner.sites.has(id(K3))).toBe(true);
    const rotated = events.find((e) => e.type === "site-rotated");
    expect(rotated?.type === "site-rotated" && rotated.path).toEqual([
      id(K1),
      id(K2),
      id(K3),
    ]);
  });

  it("announces a rotation once, not on every heartbeat", async () => {
    const runner = await runnerWith(
      upstream(() => ({
        sites: { [id(K2)]: publicIdentityOf(K2) },
        successions: {
          [id(K2)]: { succeeds: [signSuccession(K1, publicIdentityOf(K2))] },
        },
      })),
      approvedK1(),
    );
    await runner.tick();
    await runner.tick();
    await runner.tick();

    expect(events.filter((e) => e.type === "site-rotated")).toHaveLength(1);
  });
});

describe("a rotation that is somebody else's", () => {
  it("refuses a chain whose link does not verify, and keeps the pin", async () => {
    // Either a broken site or the attack, and this daemon cannot tell which.
    // What it can do is keep what it already has and say so.
    const forged: Succession = {
      ...signSuccession(K1, publicIdentityOf(K2)),
      signature: signSuccession(IMPOSTOR, publicIdentityOf(K2)).signature,
    };
    const runner = await runnerWith(
      upstream(() => ({
        sites: { [id(K2)]: publicIdentityOf(K2) },
        successions: { [id(K2)]: { succeeds: [forged] } },
      })),
      approvedK1(),
    );
    await runner.tick();

    expect(runner.sites.has(id(K2))).toBe(false);
    expect(runner.pending.has(id(K2))).toBe(false);
    expect(runner.sites.has(id(K1))).toBe(false); // K1 left the announced set
    expect(runner.known.has(id(K1))).toBe(true); // but is still approved here
    expect(events.some((e) => e.type === "site-refused")).toBe(true);
  });

  it("refuses a succession lifted from another site's record [SITES_LOCALLY_APPROVED]", async () => {
    // C.8's adversarial case, and the reason C.1 names *both* ids. The
    // impostor holds a genuine succession — K1 signed for K2 — and presents it
    // as authority for its own key, hoping the verifier only checks that the
    // signature is real.
    const genuine = signSuccession(K1, publicIdentityOf(K2));
    const runner = await runnerWith(
      upstream(() => ({
        sites: { [id(IMPOSTOR)]: publicIdentityOf(IMPOSTOR) },
        successions: { [id(IMPOSTOR)]: { succeeds: [genuine] } },
      })),
      approvedK1(),
    );
    await runner.tick();

    expect(runner.sites.has(id(IMPOSTOR))).toBe(false);
    expect(runner.known.has(id(IMPOSTOR))).toBe(false);
    expect(events.some((e) => e.type === "site-refused")).toBe(true);
  });

  it("still refuses a key that moved under an id already approved", async () => {
    // The rule rotation had to be reconciled with, unchanged. A succession
    // offered for the *same* id is not a succession — it is the substitution
    // `SITES_LOCALLY_APPROVED` exists to refuse, and dressing it in a chain
    // must not get it past.
    const substituted = {
      ...publicIdentityOf(K2),
      identity: publicIdentityOf(K2).identity,
    };
    const runner = await runnerWith(
      upstream(() => ({
        sites: { [id(K1)]: substituted },
        successions: {
          [id(K1)]: { succeeds: [signSuccession(K1, publicIdentityOf(K2))] },
        },
      })),
      approvedK1(),
    );
    await runner.tick();

    // Refused before any chain is considered: the id it is filed under is not
    // its key id, which is the check that runs first. The pin this machine
    // already holds is untouched, which is the property that matters — a
    // refusal that unpinned what it was defending would be the same outage
    // the attack was trying to cause.
    expect(runner.sites.get(id(K1))).toEqual(publicIdentityOf(K1));
    expect(events.some((e) => e.type === "site-rotated")).toBe(false);
    expect(events.some((e) => e.type === "site-refused")).toBe(true);
  });

  it("treats a chain that reaches nobody as a stranger, not an attack", async () => {
    // A site with a history this machine has no part in is exactly as
    // trustworthy as a site with no history: it goes to the human, and telling
    // this apart from a broken chain is what keeps the loud refusal meaningful.
    const runner = await runnerWith(
      upstream(() => ({
        sites: { [id(K3)]: publicIdentityOf(K3) },
        successions: {
          [id(K3)]: {
            succeeds: [signSuccession(IMPOSTOR, publicIdentityOf(K3))],
          },
        },
      })),
      approvedK1(),
    );
    await runner.tick();

    expect(runner.pending.has(id(K3))).toBe(true);
    expect(runner.sites.has(id(K3))).toBe(false);
    expect(events.some((e) => e.type === "site-awaiting-approval")).toBe(true);
    expect(events.some((e) => e.type === "site-refused")).toBe(false);
  });

  it("will not even parse a chain longer than the guard allows", async () => {
    // The denial-of-service bound, asserted where it actually bites. The wire
    // schema carries the same constant the walk does, so an over-long chain
    // never reaches the walk at all — the heartbeat fails to validate and the
    // daemon keeps the set it had.
    //
    // The walk keeps its own check regardless. One bound in two places is
    // usually the drift this project deletes; here they are the same exported
    // constant, and the walk is called from tests and could be called from
    // somewhere else later. A guard that is only reachable through one caller
    // is a guard that stops existing the moment a second caller appears.
    const link = signSuccession(K1, publicIdentityOf(K2));
    const runner = await runnerWith(
      upstream(() => ({
        sites: { [id(K2)]: publicIdentityOf(K2) },
        successions: {
          [id(K2)]: { succeeds: Array.from({ length: 65 }, () => link) },
        },
      })),
      approvedK1(),
    );

    await expect(runner.tick()).rejects.toThrow(/does not match protocol/);
    expect(runner.sites.has(id(K2))).toBe(false);
  });
});

describe("the window the old key keeps", () => {
  it("keeps serving the superseded id while work signed under it may arrive", async () => {
    // A rotation is not instant on the wire. Work enqueued a minute before it
    // was signed by the old key and names the old id, so a daemon that
    // dropped that pin the moment the projection moved would refuse jobs that
    // are perfectly good — a flag day for whoever's heartbeat landed on the
    // wrong side of the change.
    const runner = await runnerWith(
      upstream(() => ({
        sites: { [id(K2)]: publicIdentityOf(K2) },
        successions: {
          [id(K2)]: {
            succeeds: [signSuccession(K1, publicIdentityOf(K2))],
            retiringUntil: Date.now() + 60_000,
          },
        },
      })),
      approvedK1(),
    );
    await runner.tick();

    expect(runner.sites.get(id(K1))).toEqual(publicIdentityOf(K1));
    expect(runner.sites.get(id(K2))).toEqual(publicIdentityOf(K2));
  });

  it("drops it once its own clock says the window is over", async () => {
    // This machine's clock, not the projection's word. The deadline offered
    // here is already in the past, so the pin goes on the same beat.
    const runner = await runnerWith(
      upstream(() => ({
        sites: { [id(K2)]: publicIdentityOf(K2) },
        successions: {
          [id(K2)]: {
            succeeds: [signSuccession(K1, publicIdentityOf(K2))],
            retiringUntil: Date.now() - 1,
          },
        },
      })),
      approvedK1(),
    );
    await runner.tick();

    expect(runner.sites.has(id(K1))).toBe(false);
    expect(runner.sites.has(id(K2))).toBe(true);
  });

  it("will not let a projection hold the old key open forever", async () => {
    // Ruling 2: the overlap is a protocol constant and not the site's to
    // choose, because a site that could choose it could choose "never" — a
    // two-key site permanently, and a second key nobody notices retiring.
    const runner = await runnerWith(
      upstream(() => ({
        sites: { [id(K2)]: publicIdentityOf(K2) },
        successions: {
          [id(K2)]: {
            succeeds: [signSuccession(K1, publicIdentityOf(K2))],
            retiringUntil: Date.now() + 10 * RETIREMENT_WINDOW_MS,
          },
        },
      })),
      approvedK1(),
    );
    await runner.tick();

    expect(runner.retiring.get(id(K1)) ?? 0).toBeLessThanOrEqual(
      Date.now() + RETIREMENT_WINDOW_MS,
    );
  });
});

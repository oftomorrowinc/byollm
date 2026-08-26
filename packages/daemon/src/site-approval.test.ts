import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENCRYPTION_KEY_CONTEXT,
  fingerprint,
  generateKeys,
  keyId,
  publicIdentityOf,
  signRequest,
  signWith,
  type ClaimedStub,
  type PublicIdentity,
  type StoredKeys,
} from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Budgets } from "./budgets.js";
import { ProtocolClient } from "./client.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { IngressLog } from "./ingress.js";
import { Runner, type RunnerEvent } from "./runner.js";
import { SpendLedger } from "./spend.js";
import { removeTemp } from "./test-support.js";

/**
 * Who gets to add a site to this device — V1-1.
 *
 * The daemon pins a site's keys so that the party routing the work cannot
 * choose which key signs it. The pre-v1 review found the door left open one
 * level up: the *site set itself* arrived on the heartbeat and was pinned
 * without a question. A relay could generate a keypair, announce it as a
 * site, sign stubs with it, and every pin check would pass — because the
 * site was in the map, put there by the party the map exists to defend
 * against.
 *
 * So the rules under test are the trust model, not a feature:
 *
 *   1. Nothing is served for a site nobody at this keyboard approved.
 *   2. An id that was approved once is compared against the key it was
 *      approved under, **for the life of the pairing** — so drop-and-re-add
 *      is not a way to change a key quietly.
 *   3. An offer whose own paperwork does not add up is refused, and refusing
 *      it never unpins what was already approved.
 *
 * Every case here is a thing an upstream can actually send.
 */

const SITE_A = generateKeys(1_800_000_000_000);
const A = keyId(publicIdentityOf(SITE_A).identity);
const RELAY_MINTED = generateKeys(1_800_000_000_777);
const M = keyId(publicIdentityOf(RELAY_MINTED).identity);
const DEVICE = generateKeys(1_800_000_000_001);

let dir: string;
let events: RunnerEvent[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-approval-"));
  events = [];
});

afterEach(async () => {
  await removeTemp(dir);
});

/** A heartbeat that announces exactly this set, and offers no work. */
function upstream(sites: () => Record<string, PublicIdentity>): typeof fetch {
  return (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const endpoint = url.split("/").pop() ?? "";
    const body =
      endpoint === "heartbeat"
        ? {
            sites: sites(),
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
      services: {
        primary: {
          model: "m",
          kinds: ["llm.generate"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          offer: "private",
        },
      },
    }),
  );
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

/** A stub naming a site — enough for `admit`, which never sees a payload. */
function stub(site: string): ClaimedStub {
  return {
    id: "job_1",
    kind: "llm.generate",
    audience: "private",
    owner: "me",
    site,
    sizeClass: "small",
    streaming: false,
    deadlineAt: Date.now() + 60_000,
    lease: {
      id: "lease_1",
      runnerId: "runner_1",
      expiresAt: Date.now() + 60_000,
    },
  };
}

/** A record for `identity`'s id carrying somebody else's encryption key. */
function rotated(keys: StoredKeys, encryption: string): PublicIdentity {
  return {
    identity: publicIdentityOf(keys).identity,
    encryption,
    encryptionSig: signWith(
      keys,
      Buffer.from(`${ENCRYPTION_KEY_CONTEXT}:${encryption}`),
    ),
  };
}

describe("a site the upstream adds", () => {
  /**
   * The fence moved; it did not fall — byollm_016 Amendment K.
   *
   * The attack this block was written for is the relay minting a keypair and
   * announcing it as a site. Approval used to be what stopped it: the id sat
   * unpinned and unserved until a human compared a fingerprint.
   *
   * A device no longer asks. What stops the same attack now is one layer
   * down and stronger against this particular attacker: work for that site
   * needs a **grant signed by the control-plane key pinned at pairing**, and
   * a relay holds no such key. So the relay can get an id pinned here and
   * still cannot get a single job run under it.
   *
   * What the trade actually costs is worth naming precisely, because it is
   * not nothing: a compromised *control plane* — which can sign — can now
   * point this device at a site its owner never chose. That is the accepted
   * posture, bounded by spend caps and `pause`, and made loud by the
   * first-serve notice below.
   */
  it("is pinned and served, and its first job announces itself", async () => {
    const runner = await runnerWith(
      upstream(() => ({ [M]: publicIdentityOf(RELAY_MINTED) })),
      { sites: new Map() },
    );
    await runner.tick();

    expect(runner.sites.has(M)).toBe(true);
    // Nothing announced yet: a site the upstream merely mentioned has not
    // asked this device for anything, and a notice on a mention would fire
    // for sites that never send a job.
    expect(events.some((e) => e.type === "now-serving")).toBe(false);

    expect(runner.admit(stub(M)).ok).toBe(true);
    const said = events.find((e) => e.type === "now-serving");
    expect(said?.site).toBe(M);
    expect(said?.fingerprint).toBe(
      fingerprint(publicIdentityOf(RELAY_MINTED).identity),
    );
  });

  it("announces once, not on every job it ever sends", async () => {
    // A daemon that repeats itself is a daemon nobody reads — the same rule
    // `awaiting-consent` follows, and the reason a person would ever notice
    // the one line that matters.
    const runner = await runnerWith(
      upstream(() => ({ [M]: publicIdentityOf(RELAY_MINTED) })),
      { sites: new Map() },
    );
    await runner.tick();
    runner.admit(stub(M));
    runner.admit({ ...stub(M), id: "job_2" });
    runner.admit({ ...stub(M), id: "job_3" });

    expect(events.filter((e) => e.type === "now-serving")).toHaveLength(1);
  });

  it("keeps the key it pinned when the upstream offers a different one", async () => {
    let announced: Record<string, PublicIdentity> = {
      [M]: publicIdentityOf(RELAY_MINTED),
    };
    const runner = await runnerWith(
      upstream(() => announced),
      { sites: new Map() },
    );
    await runner.tick();

    expect(runner.sites.has(M)).toBe(true);
    expect(runner.admit(stub(M)).ok).toBe(true);

    // The upstream now offers a different key for the same id. The pinned
    // one stays — this is `site-key-changed`, and it is the *whole* reason
    // the approved map is kept rather than the offered one.
    const moved = rotated(RELAY_MINTED, publicIdentityOf(SITE_A).encryption);
    announced = { [M]: moved };
    await runner.tick();
    expect(events.some((e) => e.type === "site-key-changed")).toBe(true);
    expect(runner.sites.get(M)?.encryption).toBe(
      publicIdentityOf(RELAY_MINTED).encryption,
    );
  });
});

describe("an id this device has pinned once", () => {
  it("cannot come back under a different key by leaving the set first [SITES_LOCALLY_APPROVED]", async () => {
    // The bypass the review found: heartbeat N drops the id, which used to
    // delete the pin, and heartbeat N+1 re-adds it with a key of the
    // upstream's choosing. With the pin gone the comparison had nothing to
    // compare against, so the substitution arrived as an ordinary new site.
    let announced: Record<string, PublicIdentity> = {
      [A]: publicIdentityOf(SITE_A),
    };
    const runner = await runnerWith(
      upstream(() => announced),
      { sites: new Map([[A, publicIdentityOf(SITE_A)]]) },
    );
    await runner.tick();
    expect(runner.sites.has(A)).toBe(true);

    announced = {};
    await runner.tick();
    expect(runner.sites.has(A)).toBe(false); // consent ended: not served

    announced = {
      [A]: rotated(SITE_A, publicIdentityOf(RELAY_MINTED).encryption),
    };
    await runner.tick();

    expect(events.some((e) => e.type === "site-key-changed")).toBe(true);
    expect(runner.sites.has(A)).toBe(false);
    // And it is *not* treated as a new site. This is the branch `#known`
    // exists for: it outlives consent precisely so that remove-then-re-add
    // is not a way around the comparison.
    expect(runner.sites.has(A)).toBe(false);
  });

  it("resumes without asking again when it comes back unchanged", async () => {
    // Consent is a thing people turn off and on. Re-approving the same key
    // would train somebody to click through the one screen that matters.
    let announced: Record<string, PublicIdentity> = {
      [A]: publicIdentityOf(SITE_A),
    };
    const runner = await runnerWith(
      upstream(() => announced),
      { sites: new Map([[A, publicIdentityOf(SITE_A)]]) },
    );
    await runner.tick();
    announced = {};
    await runner.tick();
    announced = { [A]: publicIdentityOf(SITE_A) };
    await runner.tick();

    expect(runner.sites.has(A)).toBe(true);
    expect(events.some((e) => e.type === "site-key-changed")).toBe(false);
  });
});

describe("an offer whose paperwork does not add up", () => {
  it("is refused when the encryption key is not signed by the identity", async () => {
    const spliced: PublicIdentity = {
      ...publicIdentityOf(SITE_A),
      encryption: publicIdentityOf(RELAY_MINTED).encryption,
    };
    const runner = await runnerWith(
      upstream(() => ({ [A]: spliced })),
      { sites: new Map() },
    );
    await runner.tick();

    expect(runner.sites.has(A)).toBe(false);
    expect(events.find((e) => e.type === "site-refused")?.reason).toContain(
      "not signed by the identity",
    );
  });

  it("is refused when the id it is filed under is not its key id", async () => {
    // `stub.site` is looked up in this map, so an id that does not belong to
    // the identity filed under it means a stub can name one site and get
    // another site's key — a substitution with no forged signature in it.
    const runner = await runnerWith(
      upstream(() => ({ [M]: publicIdentityOf(SITE_A) })),
      { sites: new Map() },
    );
    await runner.tick();

    expect(runner.sites.has(M)).toBe(false);
    expect(events.find((e) => e.type === "site-refused")?.reason).toContain(
      "not its key id",
    );
  });

  it("does not unpin a site that was already approved", async () => {
    // Refusal must not be a lever. If garbage in an offer dropped the pin,
    // any upstream could unpin a site by sending nonsense about it — and the
    // next well-formed offer would arrive as a brand-new site with whatever
    // key it liked.
    let announced: Record<string, PublicIdentity> = {
      [A]: publicIdentityOf(SITE_A),
    };
    const runner = await runnerWith(
      upstream(() => announced),
      { sites: new Map([[A, publicIdentityOf(SITE_A)]]) },
    );
    await runner.tick();

    announced = {
      [A]: {
        ...publicIdentityOf(SITE_A),
        encryption: publicIdentityOf(RELAY_MINTED).encryption,
      },
    };
    await runner.tick();

    expect(events.some((e) => e.type === "site-refused")).toBe(true);
    expect(runner.sites.get(A)?.encryption).toBe(
      publicIdentityOf(SITE_A).encryption,
    );
    expect(runner.admit(stub(A)).ok).toBe(true);
  });
});

describe("pins read back from disk", () => {
  it("are checked, not trusted, because a file is not a smaller thing", async () => {
    /**
     * This check used to live in `applyApprovals`, which Amendment K deleted
     * along with `byollm approve`. The entries still come from the pairings
     * file, and that file sits on a machine other software runs on — so the
     * check moved to the constructor rather than leaving with its caller.
     *
     * A pin whose key does not belong to its id is worse than a missing one:
     * every later substitution comparison would compare against the wrong
     * thing, so the row is dropped rather than repaired.
     */
    const runner = await runnerWith(
      upstream(() => ({})),
      {
        sites: new Map(),
        // Filed under the wrong id.
        known: new Map([[M, publicIdentityOf(SITE_A)]]),
      },
    );
    expect(runner.known.has(M)).toBe(false);
  });

  it("drops a pin whose encryption key is not signed by its identity", async () => {
    const spliced = {
      ...publicIdentityOf(RELAY_MINTED),
      encryption: publicIdentityOf(SITE_A).encryption,
    };
    const runner = await runnerWith(
      upstream(() => ({})),
      {
        sites: new Map(),
        known: new Map([[M, spliced]]),
      },
    );
    expect(runner.known.has(M)).toBe(false);
  });

  it("keeps a pin that checks out", async () => {
    // The control: verification must not be a quiet way to lose every pin.
    const runner = await runnerWith(
      upstream(() => ({})),
      {
        sites: new Map(),
        known: new Map([[A, publicIdentityOf(SITE_A)]]),
      },
    );
    expect(runner.known.has(A)).toBe(true);
  });
});

describe("what the CLI is handed to persist", () => {
  it("records the site set and the pins, and writes only on a change", async () => {
    // `recordSites` is what the run loop calls on every heartbeat, and its
    // four outcomes are the reason it is a function rather than a branch
    // inside the loop. The `pending` map it used to carry went with
    // `byollm approve` (Amendment K); `known` stays, because it is the pin
    // record the substitution check compares against.
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Pairings, recordSites } = await import("./pairings.js");

    const home = await mkdtemp(join(tmpdir(), "byollm-record-"));
    const pairings = new Pairings(join(home, "pairings.json"));
    await pairings.load();
    // Nothing paired here yet: the loop calls this before `connect` has
    // written a row on the very first heartbeat of a failed pairing.
    expect(await recordSites(pairings, "https://hub.test", new Map())).toBe(
      "unpaired",
    );

    await pairings.put({
      origin: "https://hub.test",
      runnerId: "runner_1",
      owner: "me",
      sites: {},
      pairedAt: Date.now(),
    });

    const served = new Map([[M, publicIdentityOf(RELAY_MINTED)]]);
    expect(
      await recordSites(pairings, "https://hub.test", served, {
        known: served,
      }),
    ).toBe("written");
    expect(pairings.get("https://hub.test")?.known?.[M]).toEqual(
      publicIdentityOf(RELAY_MINTED),
    );

    // Nothing moved, so nothing is written — a file rewritten every five
    // seconds is a file somebody's backup notices.
    expect(
      await recordSites(pairings, "https://hub.test", served, {
        known: served,
      }),
    ).toBe("unchanged");

    // Consent ends: the site leaves the served set and the pin stays, which
    // is what makes remove-then-re-add a refusal rather than a new site.
    expect(
      await recordSites(pairings, "https://hub.test", new Map(), {
        known: served,
      }),
    ).toBe("written");
    expect(pairings.get("https://hub.test")?.sites).toEqual({});
    expect(pairings.get("https://hub.test")?.known?.[M]).toBeDefined();

    await removeTemp(home);
  });
});

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
import { Allowlist } from "./allowlist.js";
import { Budgets } from "./budgets.js";
import { ProtocolClient } from "./client.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { IngressLog } from "./ingress.js";
import { Runner, type RunnerEvent } from "./runner.js";
import { SpendLedger } from "./spend.js";
import { removeTemp } from "./test-support.js";

/**
 * Who gets to add a site to this machine — V1-1.
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

/** A stub naming a site — enough for `admit`, which never sees a payload. */
function stub(site: string): ClaimedStub {
  return {
    id: "job_1",
    kind: "llm.generate",
    audience: "self",
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
  it("is offered, never pinned, and runs nothing until somebody says yes", async () => {
    // The attack, exactly as the review wrote it: the relay generates a
    // keypair and announces it as a site. Everything downstream would then
    // check out — the stub names a site in the map, the payload is sealed by
    // the key in the map — because the map is what was compromised.
    const runner = await runnerWith(
      upstream(() => ({ [M]: publicIdentityOf(RELAY_MINTED) })),
      { sites: new Map() },
    );
    await runner.tick();

    expect(runner.sites.has(M)).toBe(false);
    expect(runner.pending.has(M)).toBe(true);
    const asked = events.find((e) => e.type === "site-awaiting-approval");
    expect(asked?.site).toBe(M);
    expect(asked?.fingerprint).toBe(
      fingerprint(publicIdentityOf(RELAY_MINTED).identity),
    );

    // And the work it would send is refused at admission — before a payload
    // is fetched, before a backend is paid.
    const admitted = runner.admit(stub(M));
    expect(admitted.ok).toBe(false);
    if (admitted.ok) throw new Error("unreachable: the admission was refused");
    expect(admitted.reason).toContain("has not approved");
  });

  it("asks once, not every five seconds", async () => {
    const runner = await runnerWith(
      upstream(() => ({ [M]: publicIdentityOf(RELAY_MINTED) })),
      { sites: new Map() },
    );
    await runner.tick();
    await runner.tick();
    await runner.tick();

    // A daemon that repeats itself on every heartbeat is a daemon nobody
    // reads — the same rule `awaiting-consent` follows, and the reason a
    // person would ever notice the one line that matters.
    expect(
      events.filter((e) => e.type === "site-awaiting-approval"),
    ).toHaveLength(1);
  });

  it("is served once approved, and the key served is the one approved", async () => {
    let announced: Record<string, PublicIdentity> = {
      [M]: publicIdentityOf(RELAY_MINTED),
    };
    const runner = await runnerWith(
      upstream(() => announced),
      { sites: new Map() },
    );
    await runner.tick();
    runner.applyApprovals(new Map([[M, publicIdentityOf(RELAY_MINTED)]]));

    expect(runner.sites.has(M)).toBe(true);
    expect(runner.pending.has(M)).toBe(false);
    expect(runner.admit(stub(M)).ok).toBe(true);

    // The upstream now offers a different key for the same id. The approved
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

describe("an id that was approved once", () => {
  it("cannot come back under a different key by leaving the set first", async () => {
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
    // And it is *not* a new site: asking for approval here would turn the
    // refusal into a prompt, and a prompt is something a person can say yes
    // to by reflex.
    expect(events.some((e) => e.type === "site-awaiting-approval")).toBe(false);
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
    expect(events.some((e) => e.type === "site-awaiting-approval")).toBe(false);
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

    expect(runner.pending.has(A)).toBe(false);
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

    expect(runner.pending.has(M)).toBe(false);
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

describe("approvals read back from disk", () => {
  it("are checked, not trusted, because a file is not a smaller thing", async () => {
    // `byollm approve` writes the pairings file and the running loop reads it
    // back. That file sits on a machine other software runs on, so an
    // approval arriving through it gets the same two checks a heartbeat gets.
    const runner = await runnerWith(
      upstream(() => ({ [M]: publicIdentityOf(RELAY_MINTED) })),
      { sites: new Map() },
    );
    await runner.tick();

    runner.applyApprovals(
      new Map([
        // Filed under the wrong id.
        [M, publicIdentityOf(SITE_A)],
      ]),
    );
    expect(runner.sites.has(M)).toBe(false);
    expect(runner.known.has(M)).toBe(false);

    runner.applyApprovals(
      new Map([
        [
          M,
          {
            ...publicIdentityOf(RELAY_MINTED),
            encryption: publicIdentityOf(SITE_A).encryption,
          },
        ],
      ]),
    );
    expect(runner.sites.has(M)).toBe(false);
    expect(runner.known.has(M)).toBe(false);
  });

  it("do not serve a key the upstream is no longer offering", async () => {
    // Approved at 10:00 from what was on screen; by 10:01 the upstream is
    // offering something else. Serving the approved key would be right, and
    // serving *anything* here would be premature — the next heartbeat is the
    // one that says which of the two the upstream stands behind.
    const runner = await runnerWith(
      upstream(() => ({
        [M]: rotated(RELAY_MINTED, publicIdentityOf(SITE_A).encryption),
      })),
      { sites: new Map() },
    );
    await runner.tick();

    runner.applyApprovals(new Map([[M, publicIdentityOf(RELAY_MINTED)]]));
    expect(runner.known.has(M)).toBe(true);
    expect(runner.sites.has(M)).toBe(false);

    await runner.tick();
    expect(events.some((e) => e.type === "site-key-changed")).toBe(true);
    expect(runner.sites.has(M)).toBe(false);
  });
});

describe("what the CLI is handed to persist", () => {
  it("records the site set, the approvals and the open questions", async () => {
    // `recordSites` is what the run loop calls on every heartbeat, and its
    // four outcomes are the reason it is a function rather than a branch
    // inside the loop. Two of them are new: `known` grows and `pending`
    // appears, and a `pending` that outlived its offer would leave somebody
    // being asked a question the upstream stopped asking.
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

    expect(
      await recordSites(pairings, "https://hub.test", new Map(), {
        known: new Map(),
        pending: new Map([[M, publicIdentityOf(RELAY_MINTED)]]),
      }),
    ).toBe("written");
    expect(pairings.get("https://hub.test")?.pending?.[M]).toEqual(
      publicIdentityOf(RELAY_MINTED),
    );

    // Nothing moved, so nothing is written — a file rewritten every five
    // seconds is a file somebody's backup notices.
    expect(
      await recordSites(pairings, "https://hub.test", new Map(), {
        known: new Map(),
        pending: new Map([[M, publicIdentityOf(RELAY_MINTED)]]),
      }),
    ).toBe("unchanged");

    // The question was answered: the offer leaves and the approval stays.
    expect(
      await recordSites(
        pairings,
        "https://hub.test",
        new Map([[M, publicIdentityOf(RELAY_MINTED)]]),
        {
          known: new Map([[M, publicIdentityOf(RELAY_MINTED)]]),
          pending: new Map(),
        },
      ),
    ).toBe("written");
    expect(pairings.get("https://hub.test")?.pending).toBeUndefined();
    expect(pairings.get("https://hub.test")?.known?.[M]).toBeDefined();

    await removeTemp(home);
  });
});

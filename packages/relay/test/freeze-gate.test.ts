import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENVELOPE_MAX_AGE_MS,
  JobOutcome,
  cryptoReady,
  generateKeys,
  keyId,
  open,
  publicIdentityOf,
  seal,
  sizeClassOf,
  type JobStub,
  type PublicIdentity,
  type SealedEnvelope,
  type StoredKeys,
} from "@byollm/protocol";
import {
  Allowlist,
  Budgets,
  DaemonConfig,
  DeviceIdentity,
  IngressLog,
  ProtocolClient,
  Runner,
  SpendLedger,
  resolveConfig,
  type Backend,
  type BackendRequest,
  type BackendResult,
} from "byollm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Relay, type RelayFixture } from "../src/index.js";

/**
 * The freeze gate — cloud_004 §14.
 *
 * byollm_009 stamps frozen when these pass against the skeleton relay. Each is
 * a demonstration rather than a unit test: a real {@link Runner} — the shipped
 * daemon, with its real allowlist, budgets, ingress log and device keys — and
 * a real sealing site, routed through a relay holding no keys.
 *
 * The site here is a small connector rather than `ByollmApp`, and the reason
 * is the thing being proven: a direct site seals at enqueue because it is the
 * upstream. A relayed site cannot — it does not know which device will claim —
 * so it seals on demand, after the claim. That connector is what becomes the
 * `cloud` lane in `@byollm/server` (cloud_004 §9.4). Everything about it that
 * matters for the gate is real: real site keys, real sealing, real
 * verification against a pinned identity.
 */

const SITE_ID = "site_demo";

class EchoBackend implements Backend {
  readonly id = "openai-http" as const;
  readonly class = "http" as const;
  readonly seen: string[] = [];
  hangMs = 0;

  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({ healthy: true, models: ["echo-model"] });
  }

  async execute(request: BackendRequest): Promise<BackendResult> {
    this.seen.push(request.prompt);
    if (this.hangMs > 0) {
      await new Promise((r) => setTimeout(r, this.hangMs));
    }
    return { ok: true, text: `echo: ${request.prompt}`, durationMs: 1 };
  }
}

/** Remove a temp home, tolerating a write that lands mid-removal. */
async function removeHome(home: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(home, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * The site half: holds the keys, seals on demand, verifies what comes back.
 *
 * Everything it does is something a relayed `@byollm/server` will do, and
 * nothing it does requires the relay's cooperation beyond being told an
 * address to seal to.
 */
class SiteConnector {
  readonly keys: StoredKeys;
  readonly #relay: Relay;
  #next = 0;

  constructor(relay: Relay, keys: StoredKeys) {
    this.#relay = relay;
    this.keys = keys;
  }

  get identity(): PublicIdentity {
    return publicIdentityOf(this.keys);
  }

  async enqueue(input: {
    prompt: string;
    owner: string;
    audience?: "self" | "named" | "public";
    audienceAllow?: string[];
  }): Promise<{ jobId: string; payload: string }> {
    this.#next += 1;
    const jobId = `job_relay_${String(this.#next)}`;
    const payload = JSON.stringify({ prompt: input.prompt });
    const stub: JobStub = {
      id: jobId,
      kind: "llm.generate",
      owner: input.owner,
      audience: input.audience ?? "self",
      ...(input.audienceAllow ? { audienceAllow: input.audienceAllow } : {}),
      sizeClass: sizeClassOf(payload.length),
      streaming: false,
      deadlineAt: Date.now() + 300_000,
    };
    await this.#post("/relay/site/enqueue", { siteId: SITE_ID, stub });
    this.#pending.set(jobId, payload);
    return { jobId, payload };
  }

  readonly #pending = new Map<string, string>();

  /**
   * Seal for every job the relay says has been claimed.
   *
   * This is the beat that only exists off the direct plane, and the one the
   * `awaiting-payload` timeout exists to bound: if this never runs, a device
   * is holding work whose payload is not coming.
   */
  async sealPending(): Promise<number> {
    const res = await this.#get(`/relay/site/pending?siteId=${SITE_ID}`);
    const { jobs } = res as {
      jobs: { jobId: string; device: PublicIdentity }[];
    };
    let sealed = 0;
    for (const job of jobs) {
      const plaintext = this.#pending.get(job.jobId);
      if (plaintext === undefined) continue;
      const envelope = await seal({
        plaintext,
        senderKeys: this.keys,
        recipientEncryptionPublic: job.device.encryption,
        context: {
          jobId: job.jobId,
          senderKeyId: keyId(this.identity.identity),
          recipientKeyId: keyId(job.device.identity),
          deadlineAt: Date.now() + ENVELOPE_MAX_AGE_MS,
          direction: "payload",
        },
      });
      await this.#post("/relay/site/payload", {
        siteId: SITE_ID,
        jobId: job.jobId,
        envelope,
      });
      sealed += 1;
    }
    return sealed;
  }

  /** Collect results and verify each against the device that claimed it. */
  async collect(): Promise<
    { jobId: string; outcome: JobOutcome | null; disposition: string }[]
  > {
    const res = await this.#get(`/relay/site/results?siteId=${SITE_ID}`);
    const { jobs } = res as {
      jobs: {
        jobId: string;
        envelope: SealedEnvelope;
        disposition: string;
        device: PublicIdentity;
      }[];
    };
    const out = [];
    for (const job of jobs) {
      const opened = await open({
        envelope: job.envelope,
        recipientKeys: this.keys,
        senderIdentityPublic: job.device.identity,
        expected: {
          jobId: job.jobId,
          senderKeyId: keyId(job.device.identity),
          recipientKeyId: keyId(this.identity.identity),
          direction: "result",
        },
      });
      out.push({
        jobId: job.jobId,
        outcome: opened.ok
          ? JobOutcome.parse(JSON.parse(opened.plaintext))
          : null,
        disposition: job.disposition,
      });
    }
    return out;
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    const res = await this.#relay.handle(
      new Request(`http://relay.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return res.json();
  }

  async #get(path: string): Promise<unknown> {
    const res = await this.#relay.handle(
      new Request(`http://relay.test${path}`),
    );
    return res.json();
  }
}

/** Pair and build a real daemon against the relay. */
async function makeDaemon(
  relay: Relay,
  input: { owner: string; runnerId: string; site: PublicIdentity },
): Promise<{
  runner: Runner;
  backend: EchoBackend;
  home: string;
  keys: StoredKeys;
  allowlist: Allowlist;
  dispose: () => Promise<void>;
}> {
  const home = await mkdtemp(join(tmpdir(), "byollm-relay-"));
  const identity = new DeviceIdentity(join(home, "keys.json"));
  const loaded = resolveConfig(
    DaemonConfig.parse({
      backends: {
        primary: {
          backend: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          offer: "public",
        },
      },
      routes: { "llm.generate": { backend: "primary", model: "echo-model" } },
      concurrency: 2,
    }),
  );

  const fetchImpl: typeof fetch = (i, init) =>
    relay.handle(new Request(i, init));

  // Consent came from the fixture, so pairing is the key exchange alone. The
  // daemon-visible outcome is what a device-code flow produces: a runner id
  // and the site identity to pin.
  const paired = await fetchImpl("http://relay.test/byollm/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: "0",
      runnerId: input.runnerId,
      owner: input.owner,
      device: await identity.publicIdentity(Date.now()),
    }),
  });
  const approval = (await paired.json()) as { site: PublicIdentity };
  expect(approval.site.identity).toBe(input.site.identity);

  const allowlist = new Allowlist(join(home, "allow.json"));
  await allowlist.load();
  const budgets = new Budgets(
    join(home, "budgets.json"),
    loaded.config.community,
  );
  await budgets.load(Date.now());
  const spend = new SpendLedger(join(home, "spend.json"));
  await spend.load(Date.now());
  const ingress = new IngressLog({
    path: join(home, "ingress.log"),
    communityPromptDays: 7,
    keepSelfPrompts: true,
  });
  const backend = new EchoBackend();

  const runner = new Runner({
    client: new ProtocolClient({
      origin: "http://relay.test",
      identity: {
        runnerId: input.runnerId,
        sign: (i) => identity.signRequest(i),
      },
      fetch: fetchImpl,
    }),
    runnerId: input.runnerId,
    owner: input.owner,
    identity: {
      keys: () => identity.load(Date.now()),
      // Pinned from the relay's pair response — the site's key, not the
      // relay's. This is what makes the relay unable to inject work.
      sitePinned: approval.site,
    },
    daemonVersion: "relay-gate",
    loaded,
    allowlist,
    budgets,
    spend,
    ingress,
    backendFactory: () => backend,
  });

  return {
    runner,
    backend,
    allowlist,
    home,
    keys: await identity.load(Date.now()),
    dispose: async () => {
      await runner.shutdown("shutdown").catch(() => undefined);
      await removeHome(home);
    },
  };
}

/** Drive a full route: claim, seal, fetch, run, report, collect. */
async function route(
  relay: Relay,
  site: SiteConnector,
  daemon: { runner: Runner },
): Promise<void> {
  await daemon.runner.tick();
  // The claim has landed and the daemon is waiting on `fetch`. This is the
  // awaiting-payload window, and the site closing it is the third beat.
  for (let i = 0; i < 40; i += 1) {
    if ((await site.sealPending()) > 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  await daemon.runner.tick();
  for (let i = 0; i < 60; i += 1) {
    const done = relay.state.jobs().some((j) => j.state === "done");
    if (done) break;
    await new Promise((r) => setTimeout(r, 10));
    await daemon.runner.tick();
  }
}

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of disposers) await d();
  disposers = [];
});

beforeAll(async () => {
  await cryptoReady();
});

function fixtureFor(site: PublicIdentity, extra: Partial<RelayFixture> = {}) {
  return {
    consents: [{ owner: "alice", siteId: SITE_ID, site }],
    rosters: [],
    revoked: [],
    ...extra,
  } satisfies RelayFixture;
}

describe("the freeze gate — cloud_004 §14", () => {
  it("1. round-trips a sealed, signed job end to end", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const relay = new Relay({ siteId: SITE_ID, fixture: fixtureFor(site) });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, {
      owner: "alice",
      runnerId: "runner_alice",
      site,
    });
    disposers.push(daemon.dispose);

    const { jobId } = await connector.enqueue({
      prompt: "summarise this",
      owner: "alice",
    });
    await route(relay, connector, daemon);

    const results = await connector.collect();
    expect(results).toHaveLength(1);
    expect(results[0]?.jobId).toBe(jobId);
    expect(results[0]?.outcome).toEqual({
      outcome: "ok",
      text: "echo: summarise this",
    });
    // The prompt reached the model verbatim, having travelled as ciphertext.
    expect(daemon.backend.seen).toEqual(["summarise this"]);
  });

  it("2. the relay never holds a plaintext, and its state cannot express one", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const relay = new Relay({ siteId: SITE_ID, fixture: fixtureFor(site) });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, {
      owner: "alice",
      runnerId: "runner_alice",
      site,
    });
    disposers.push(daemon.dispose);

    await connector.enqueue({ prompt: "a very secret prompt", owner: "alice" });
    await route(relay, connector, daemon);

    // Everything the relay knows, serialised. RELAY_BLIND as an assertion
    // over the whole state rather than over the fields we remembered to check.
    const everything = JSON.stringify(relay.state.jobs());
    expect(everything).not.toContain("a very secret prompt");
    expect(everything).not.toContain("echo: a very secret prompt");
    // And the stub it does hold carries only what byollm_009 §6 enumerates.
    const stub = relay.state.jobs()[0]?.stub;
    expect(Object.keys(stub ?? {}).sort()).toEqual([
      "audience",
      "deadlineAt",
      "id",
      "kind",
      "owner",
      "sizeClass",
      "streaming",
    ]);
  });

  it("3. refuses work sealed by a key the daemon never pinned", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const relay = new Relay({ siteId: SITE_ID, fixture: fixtureFor(site) });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, {
      owner: "alice",
      runnerId: "runner_alice",
      site,
    });
    disposers.push(daemon.dispose);

    const { jobId } = await connector.enqueue({
      prompt: "run this instead",
      owner: "alice",
    });
    await daemon.runner.tick();
    await new Promise((r) => setTimeout(r, 30));

    // A relay substituting work: it holds the device's public key, and
    // `crypto_box_seal` is anonymous-sender, so producing an openable envelope
    // needs nothing secret. What it cannot produce is the site's signature.
    const impostor = generateKeys(Date.now());
    const claimed = relay.state.job(jobId)?.claimedBy;
    expect(claimed).toBeDefined();
    const forged = await seal({
      plaintext: JSON.stringify({ prompt: "exfiltrate everything" }),
      senderKeys: impostor,
      recipientEncryptionPublic: claimed!.device.encryption,
      context: {
        jobId,
        senderKeyId: keyId(site.identity),
        recipientKeyId: keyId(claimed!.device.identity),
        deadlineAt: Date.now() + ENVELOPE_MAX_AGE_MS,
        direction: "payload",
      },
    });
    const job = relay.state.job(jobId);
    job!.payload = forged;
    job!.state = "ready";

    await daemon.runner.tick();
    await new Promise((r) => setTimeout(r, 50));

    // The daemon refused rather than ran: the model never saw it.
    expect(daemon.backend.seen).toEqual([]);
  });

  it("4. requeues when the site vanishes between claim and seal", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    // An offset from the real clock, not a fixed epoch: the daemon signs with
    // `Date.now()`, and a relay parked in 2027 fails every freshness check.
    let skew = 0;
    const relay = new Relay({
      siteId: SITE_ID,
      fixture: fixtureFor(site),
      now: () => Date.now() + skew,
    });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, {
      owner: "alice",
      runnerId: "runner_alice",
      site,
    });
    disposers.push(daemon.dispose);

    const { jobId } = await connector.enqueue({
      prompt: "work",
      owner: "alice",
    });
    await daemon.runner.tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(relay.state.job(jobId)?.state).toBe("awaiting-payload");

    // The site goes away. Not the lease expiring — the lease has most of a
    // minute left — but the distinct clock that bounds waiting for a party
    // that is not coming back.
    skew += 11_000;
    expect(relay.sweep().requeued).toContain(jobId);
    expect(relay.state.job(jobId)?.state).toBe("queued");
    // Nothing was lost: the stub is intact and claimable again.
    expect(relay.state.job(jobId)?.stub.id).toBe(jobId);

    // And a late seal is refused rather than landing on a claim that moved.
    const late = await relay.handle(
      new Request("http://relay.test/relay/site/payload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          siteId: SITE_ID,
          jobId,
          envelope: {
            ciphertext: "AAAA",
            recipientKeyId: "x",
            senderKeyId: "y",
            direction: "payload",
            deadlineAt: Date.now() + skew + 1000,
          },
        }),
      }),
    );
    expect(late.status).toBe(409);
  });

  it("5. revocation kills routing within one heartbeat", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const relay = new Relay({ siteId: SITE_ID, fixture: fixtureFor(site) });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, {
      owner: "alice",
      runnerId: "runner_alice",
      site,
    });
    disposers.push(daemon.dispose);

    // A fixture edit — the control plane withdrawing consent.
    relay.project(fixtureFor(site, { revoked: [`alice:${SITE_ID}`] }));

    await connector.enqueue({ prompt: "after revocation", owner: "alice" });
    await daemon.runner.tick();
    await new Promise((r) => setTimeout(r, 30));

    expect(relay.state.jobs()[0]?.state).toBe("queued");
    expect(daemon.backend.seen).toEqual([]);
  });

  it("6. routes a named job to a roster device, showing the relay only a stub", async () => {
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const relay = new Relay({
      siteId: SITE_ID,
      fixture: {
        consents: [{ owner: "bob", siteId: SITE_ID, site }],
        // Bob's machine runs work for his team, of which alice is a member.
        rosters: [{ id: "team_1", owner: "bob", members: ["alice"] }],
        revoked: [],
      },
    });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, {
      owner: "bob",
      runnerId: "runner_bob",
      site,
    });
    disposers.push(daemon.dispose);
    // AUDIENCE_BOTH_SIDES: the relay's roster is not enough — bob's daemon
    // keeps its own list and would refuse without this.
    await daemon.allowlist.add(
      { origin: "http://relay.test", owner: "alice" },
      Date.now(),
    );

    const { jobId } = await connector.enqueue({
      prompt: "alice's work on bob's machine",
      owner: "alice",
      audience: "named",
      audienceAllow: ["bob"],
    });
    await route(relay, connector, daemon);

    const results = await connector.collect();
    expect(results[0]?.outcome).toMatchObject({
      text: "echo: alice's work on bob's machine",
    });

    // The relay routed a foreign-device job knowing only the stub — and in
    // particular never learning who else is on bob's roster.
    const everything = JSON.stringify(relay.state.job(jobId));
    expect(everything).not.toContain("alice's work on bob's machine");
  });

  it("7. carries the streaming flag through untouched, costing nothing", async () => {
    // byollm_009 §8.1 reserved `streaming` before streaming existed. The
    // reservation is only free if it survives a full route unexamined, so
    // this asserts the relay neither reads it nor drops it.
    const siteKeys = generateKeys(Date.now());
    const site = publicIdentityOf(siteKeys);
    const relay = new Relay({ siteId: SITE_ID, fixture: fixtureFor(site) });
    const connector = new SiteConnector(relay, siteKeys);
    const daemon = await makeDaemon(relay, {
      owner: "alice",
      runnerId: "runner_alice",
      site,
    });
    disposers.push(daemon.dispose);

    await connector.enqueue({ prompt: "not a stream", owner: "alice" });
    await route(relay, connector, daemon);

    expect(relay.state.jobs()[0]?.stub.streaming).toBe(false);
    expect(relay.state.jobs()[0]?.state).toBe("done");
  });
});

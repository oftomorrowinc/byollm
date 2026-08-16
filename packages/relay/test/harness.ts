import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENVELOPE_MAX_AGE_MS,
  JobOutcome,
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
import { expect } from "vitest";
import { type Relay, type RelayFixture } from "../src/index.js";

export const SITE_ID = "site_demo";

export class EchoBackend implements Backend {
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
export class SiteConnector {
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
export async function makeDaemon(
  relay: Relay,
  fixture: RelayFixture,
  input: { owner: string; site: PublicIdentity },
): Promise<{
  runner: Runner;
  backend: EchoBackend;
  home: string;
  keys: StoredKeys;
  runnerId: string;
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

  // The dashboard step, simulated: a human approved these keys, so the
  // control plane knows them and the relay will accept them. Without this the
  // pair call is refused — which is the property, not an inconvenience.
  const approved = {
    owner: input.owner,
    runnerId: randomUUID(),
    device: await identity.publicIdentity(Date.now()),
  };
  fixture.devices.push(approved);
  relay.project(fixture);

  // Consent came from the fixture, so pairing is the key exchange alone. The
  // daemon-visible outcome is what a device-code flow produces: a runner id
  // and the site identity to pin.
  const paired = await fetchImpl("http://relay.test/byollm/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: "0",
      owner: input.owner,
      device: await identity.publicIdentity(Date.now()),
    }),
  });
  const approval = (await paired.json()) as {
    site: PublicIdentity;
    runnerId: string;
  };
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
        runnerId: approval.runnerId,
        sign: (i) => identity.signRequest(i),
      },
      fetch: fetchImpl,
    }),
    runnerId: approval.runnerId,
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
    runnerId: approval.runnerId,
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
export async function route(
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

export function fixtureFor(
  site: PublicIdentity,
  extra: Partial<RelayFixture> = {},
): RelayFixture {
  return {
    consents: [{ owner: "alice", siteId: SITE_ID, site }],
    devices: [],
    rosters: [],
    revoked: [],
    ...extra,
  } satisfies RelayFixture;
}

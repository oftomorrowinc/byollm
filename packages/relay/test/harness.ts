import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  ENVELOPE_MAX_AGE_MS,
  type JobOutcome,
  SealedOutcome,
  keyId,
  open,
  publicIdentityOf,
  seal,
  signSiteRequest,
  sizeClassOf,
  type JobStub,
  type PublicIdentity,
  type SealedEnvelope,
  type StoredKeys,
  generateKeys,
  RESERVED_PURPOSE,
} from "@byollm/protocol";
import {
  ControlPlane,
  MemoryPolicyStore,
  keypairSigner,
} from "@byollm/control-plane";
import {
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
import {
  type Relay,
  type RelayFixture,
  type RelayOptions,
} from "../src/index.js";

export const SITE_ID = "site_demo";

/**
 * Sign as the site, exactly as `@byollm/server`'s cloud lane does.
 *
 * Exported rather than kept private to {@link SiteConnector} because tests
 * that hand-build a site-plane request need it too — and a test that reached
 * for an unsigned shortcut would be testing a plane the relay no longer has.
 */
export function siteHeaders(
  keys: StoredKeys,
  endpoint: string,
  rawBody: string,
  issuedAt: number = Date.now(),
): Record<string, string> {
  const signature = signSiteRequest(keys, {
    endpoint,
    siteId: SITE_ID,
    issuedAt,
    body: rawBody,
  });
  return {
    "x-byollm-site": SITE_ID,
    "x-byollm-issued-at": String(signature.issuedAt),
    "x-byollm-signature": signature.signature,
  };
}

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
    audience?: "private" | "team";
  }): Promise<{ jobId: string; payload: string }> {
    this.#next += 1;
    const jobId = `job_relay_${String(this.#next)}`;
    const payload = JSON.stringify({ prompt: input.prompt });
    const stub: JobStub = {
      id: jobId,
      kind: "llm.generate",
      owner: input.owner,
      // The real key id, because the relay now checks it against the site the
      // signature named — a fixed string here would test nothing and fail.
      site: keyId(this.identity.identity),
      audience: input.audience ?? "private",
      sizeClass: sizeClassOf(payload.length),
      streaming: false,
      deadlineAt: Date.now() + 300_000,
    };
    await this.#post("enqueue", { siteId: SITE_ID, stub });
    this.#pending.set(jobId, payload);
    this.#stubs.set(jobId, stub);
    return { jobId, payload };
  }

  readonly #stubs = new Map<string, JobStub>();

  readonly #pending = new Map<string, string>();

  /**
   * Publish a stub the relay already has — a restart, a retry, or a replay.
   *
   * Named for what a site is doing rather than for the bug it found: a site
   * that comes back up and republishes its queue is the ordinary case, and it
   * must not disturb work already in flight.
   */
  async republish(jobId: string): Promise<unknown> {
    const stub = this.#stubs.get(jobId);
    if (!stub) throw new Error(`nothing enqueued for ${jobId}`);
    return this.#post("enqueue", { siteId: SITE_ID, stub });
  }

  /**
   * Seal for every job the relay says has been claimed.
   *
   * This is the beat that only exists off the direct plane, and the one the
   * `awaiting-payload` timeout exists to bound: if this never runs, a device
   * is holding work whose payload is not coming.
   */
  async sealPending(): Promise<number> {
    const res = await this.#get("pending");
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
      await this.#post("payload", {
        siteId: SITE_ID,
        jobId: job.jobId,
        envelope,
      });
      sealed += 1;
    }
    return sealed;
  }

  /** Withdraw a job, as `@byollm/server`'s cloud lane does. */
  async cancel(jobId: string): Promise<unknown> {
    return this.#post("cancel", { siteId: SITE_ID, jobId });
  }

  /** Collect results and verify each against the device that claimed it. */
  async collect(): Promise<
    {
      jobId: string;
      outcome: JobOutcome | null;
      disposition: string;
      /**
       * The device that sealed the result.
       *
       * Returned so a test can assert *which* machine ran the work.
       * `PROVENANCE_NAMES_DEVICE` is a claim about this value, and until now
       * it was only ever checked implicitly — `open` below verifies against
       * it, so a wrong device produced a decrypt failure rather than a
       * legible assertion about attribution.
       */
      device: PublicIdentity;
    }[]
  > {
    const res = await this.#get("results");
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
          ? SealedOutcome.parse(JSON.parse(opened.plaintext)).outcome
          : null,
        disposition: job.disposition,
        device: job.device,
      });
    }
    return out;
  }

  #headers(endpoint: string, rawBody: string): Record<string, string> {
    return siteHeaders(this.keys, endpoint, rawBody);
  }

  async #post(endpoint: string, body: unknown): Promise<unknown> {
    // The version, as a real site sends it (§B.4). In `#post` rather than at
    // each call above for the same reason `cloud.ts` puts it there: a site
    // request that can be written without one is how a plane ends up outside
    // the handshake.
    const rawBody = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      ...(body as Record<string, unknown>),
    });
    const res = await this.#relay.handle(
      new Request(`http://relay.test/relay/site/${endpoint}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.#headers(endpoint, rawBody),
        },
        body: rawBody,
      }),
    );
    return res.json();
  }

  async #get(endpoint: string): Promise<unknown> {
    const res = await this.#relay.handle(
      new Request(
        `http://relay.test/relay/site/${endpoint}?siteId=${SITE_ID}` +
          `&protocolVersion=${PROTOCOL_VERSION}`,
        { headers: this.#headers(endpoint, "") },
      ),
    );
    return res.json();
  }
}

/**
 * A control plane for a test relay — the real one.
 *
 * This was a fixture: forty lines that signed a grant if a `Set` contained
 * the job's owner. It is now `@byollm/control-plane` against a
 * `MemoryPolicyStore`, which means every end-to-end test in this suite —
 * a real Runner, a real relay, a real job — is certifying the engine that
 * byollm.cloud will run, rather than a stand-in that happens to agree with it.
 *
 * `admit` is the store's own write surface, so a test still says who may do
 * what in one line. What changed is that the answer now comes from the
 * resolution law rather than from this file's opinion of it.
 *
 * **Seeded from the relay's own fixture**, and that is not a convenience.
 * There are two consent records in this system by design — the projection the
 * relay routes by, and the policy the engine authorises by — and in
 * production they are one database read two ways. In a test they are two
 * literals, and two literals drift. Deriving one from the other makes the
 * harness reproduce the property the deployment has for free, instead of
 * quietly testing a world where a relay routes work its control plane would
 * refuse.
 */
export function controlPlane(fixture: RelayFixture): {
  /**
   * What `new Relay()` needs, and only that.
   *
   * Grouped so a test can spread it — `new Relay({ fixture, ...plane.relay })`
   * — without the store and its helpers leaking into a strict options object.
   */
  readonly relay: {
    readonly controlPlanePublic: string;
    readonly authorGrant: NonNullable<RelayOptions["authorGrant"]>;
  };
  /** Admit somebody to the device owner's team, and map them to `primary`. */
  readonly admit: (user: string, owner?: string) => void;
  /** The store, for a test that wants an unmapped or revoked state. */
  readonly store: MemoryPolicyStore;
} {
  const keys = generateKeys(Date.now());
  const store = new MemoryPolicyStore();
  const engine = new ControlPlane({ store, signer: keypairSigner(keys) });

  const map = (user: string) => {
    store.consent({
      siteId: SITE_ID,
      user,
      mappings: KINDS.map((kind) => ({
        purpose: RESERVED_PURPOSE,
        kind,
        service: "primary",
      })),
    });
  };
  for (const consent of fixture.consents) {
    map(consent.owner);
    // A paused consent routes nothing and authorises nothing. The relay
    // enforces the first; the store has to agree about the second, or a
    // stale projection would be the only thing standing in the way.
    if (consent.paused) store.pause({ siteId: SITE_ID, user: consent.owner });
  }

  return {
    relay: {
      controlPlanePublic: keys.identityPublic,
      authorGrant: (input) => engine.authorGrant(input),
    },
    store,
    admit: (user, owner = "bob") => {
      store.addMember({ owner, user });
      map(user);
    },
  };
}

/**
 * The kinds this harness's daemon serves, mapped for every consenting user.
 *
 * Listed rather than derived because a mapping is per (purpose, kind): a
 * consent that mapped only `llm.generate` would leave a chat job unmapped,
 * which is a real state and a confusing one to hit by accident in a test
 * about something else.
 */
const KINDS = ["llm.generate", "llm.chat"] as const;

/** Pair and build a real daemon against the relay. */
export async function makeDaemon(
  relay: Relay,
  fixture: RelayFixture,
  input: {
    owner: string;
    site: PublicIdentity;
    /**
     * Who this device's service is offered to. **Required — no default.**
     *
     * Ruled 2026-08-26: *a harness default is part of every test's claim*, so
     * a security-relevant fixture value is stated per test or the harness
     * refuses to supply one.
     *
     * This field is why the rule exists. It defaulted to `public`, and
     * `matchAudience` returned ALLOWED for a publicly offered service
     * *without consulting the device at all* — so every cross-user test in
     * this suite ran past an admission check that was never executing.
     * Freeze gate §6 even carried a comment calling its `allowlist.add`
     * load-bearing; deleting the call left all nine tests green. The default
     * was doing the work, silently, and nobody writing a test could see it in
     * the call they wrote.
     */
    offer: "private" | "team";
  },
): Promise<{
  runner: Runner;
  backend: EchoBackend;
  home: string;
  keys: StoredKeys;
  runnerId: string;
  signedFetch: (
    endpoint: string,
    body: Record<string, unknown>,
  ) => Promise<Response>;
  dispose: () => Promise<void>;
}> {
  const home = await mkdtemp(join(tmpdir(), "byollm-relay-"));
  const identity = new DeviceIdentity(join(home, "keys.json"));
  const loaded = resolveConfig(
    DaemonConfig.parse({
      services: {
        primary: {
          model: "echo-model",
          kinds: ["llm.generate"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          offer: input.offer,
        },
      },
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
    sites: Record<string, PublicIdentity>;
    runnerId: string;
    controlPlanePublic?: string;
  };
  // The set this pairing covers — cloud_009 §5. One entry here, because this
  // harness pairs against one site; the assertion is that it is *that* site's
  // key rather than the relay's, which is what makes the relay unable to
  // inject work.
  expect(Object.values(approval.sites).map((site) => site.identity)).toEqual([
    input.site.identity,
  ]);

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

  /**
   * One signed daemon-plane request, for tests about the *response*.
   *
   * `Runner` is the right way to drive the relay and the wrong way to inspect
   * a refusal: it catches, retries and translates, so the wire body never
   * reaches the assertion. Anything checking what the relay actually served —
   * a status, an error code, the fields on it — has to make the call itself,
   * signed exactly as the daemon does.
   */
  const signedFetch = async (
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<Response> => {
    const rawBody = JSON.stringify({
      protocolVersion: "0",
      runnerId: approval.runnerId,
      ...body,
    });
    const issuedAt = Date.now();
    return relay.handle(
      new Request(`http://relay.test/byollm/${endpoint}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-byollm-runner": approval.runnerId,
          "x-byollm-issued-at": String(issuedAt),
          "x-byollm-signature": await identity.signRequest({
            endpoint,
            runnerId: approval.runnerId,
            issuedAt,
            body: rawBody,
          }),
        },
        body: rawBody,
      }),
    );
  };

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
      sites: new Map(Object.entries(approval.sites)),
    },
    daemonVersion: "relay-gate",
    // Pinned from the pair response, which is the only moment it is offered.
    // A relay with no control plane sends none, and the device is then in
    // direct mode — owner-only, which is what most of this suite exercises.
    ...(approval.controlPlanePublic === undefined
      ? {}
      : { controlPlanePublic: approval.controlPlanePublic }),
    loaded,
    budgets,
    spend,
    ingress,
    backendFactory: () => backend,
  });

  return {
    runner,
    backend,
    runnerId: approval.runnerId,
    signedFetch,
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
    const done = (await relay.state.jobs()).some((j) => j.state === "done");
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
    sites: [{ siteId: SITE_ID, site }],
    consents: [{ owner: "alice", siteId: SITE_ID, paused: false }],
    devices: [],
    rosters: [],
    revoked: [],
    ...extra,
  } satisfies RelayFixture;
}

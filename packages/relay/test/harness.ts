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
  type CapabilityMatrix,
  type GrantClaims,
  type SignedGrant,
  generateKeys,
  signGrant,
} from "@byollm/protocol";
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
 * A control plane for a test relay — Amendment J.
 *
 * Holds the signing key, decides who is a member, and authors one grant per
 * claimed job. Everything a real control plane does, minus the database.
 *
 * `members` is a mutable set rather than a constructor argument on purpose:
 * removal has to be observable *between* two claims of the same test, because
 * that is the property Amendment J is for. Add somebody and their next job
 * runs; remove them and their next claim fails, including work already
 * queued. A fixture that fixed membership at construction could not express
 * either half.
 */
export function controlPlane(): {
  readonly controlPlanePublic: string;
  readonly authorGrant: NonNullable<RelayOptions["authorGrant"]>;
  /** Who this control plane will author grants for. */
  readonly members: Set<string>;
  /** Sign a grant this test wrote by hand, to forge with. */
  readonly sign: (claims: GrantClaims) => SignedGrant;
  /** Tamper with what it authors, for tests about the device's checks. */
  bend: ((grant: SignedGrant) => SignedGrant) | undefined;
} {
  const keys = generateKeys(Date.now());
  const members = new Set<string>();
  const plane = {
    controlPlanePublic: keys.identityPublic,
    members,
    sign: (claims: GrantClaims) => signGrant(keys, claims),
    bend: undefined as ((grant: SignedGrant) => SignedGrant) | undefined,
    authorGrant: ({
      job,
      owner,
      capabilities,
    }: {
      job: JobStub & { lease: { id: string } };
      owner: string;
      runnerId: string;
      capabilities: CapabilityMatrix;
    }): SignedGrant | undefined => {
      // The owner's own work needs no membership; anybody else's does.
      if (job.owner !== owner && !members.has(job.owner)) return undefined;
      // Resolution, as it is until Amendment L: what the job named, or this
      // device's default for the kind. The control plane chooses from what
      // the device advertised and never invents a name.
      const service =
        job.service ??
        capabilities.find((c) => c.kind === job.kind && c.isDefault)?.service;
      if (service === undefined) return undefined;
      const grant = signGrant(keys, {
        grantId: `grant_${job.id}_${String(grantSerial++)}`,
        jobId: job.id,
        siteId: SITE_ID,
        user: job.owner,
        owner,
        purpose: "testing",
        kind: job.kind,
        service,
        issuedAt: Date.now(),
      });
      return plane.bend ? plane.bend(grant) : grant;
    },
  };
  return plane;
}

/** Distinct grant ids without a clock that tests move. */
let grantSerial = 0;

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

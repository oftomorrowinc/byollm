import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENCRYPTION_KEY_CONTEXT,
  fingerprint,
  generateKeys,
  keyId,
  open,
  publicIdentityOf,
  seal,
  signRequest,
  signWith,
  type PublicIdentity,
  type SealedEnvelope,
} from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Allowlist } from "./allowlist.js";
import type {
  Backend,
  BackendRequest,
  BackendResult,
} from "./backends/index.js";
import { Budgets } from "./budgets.js";
import { ProtocolClient } from "./client.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { IngressLog } from "./ingress.js";
import { Runner, type RunnerEvent } from "./runner.js";
import { SpendLedger } from "./spend.js";
import { removeTemp } from "./test-support.js";

/**
 * One daemon, two sites — cloud_009 §4.2.
 *
 * The first commit of multi-tenancy, and it is a test because the failure
 * this change can cause is silent. A payload from site B verified against
 * site A's key does not announce itself as a routing bug; it reports as a
 * corrupt envelope, and the answer to a job that ran is sealed to a site that
 * cannot open it.
 *
 * ## Why three cases and not one
 *
 * MUTATIONS.md: *when a test cites a MUST, ask what other rule would also
 * make it pass.* For "a daemon paired with two sites fails against the wrong
 * key" the answer is **the crypto**. Delete every site check in the runner
 * and `open` still refuses a payload signed by somebody else, so a one-case
 * test would be green against a daemon with no site logic at all.
 *
 * So each case is written against a mutation that survives the others:
 *
 * | Mutation | Survives | Caught by |
 * | --- | --- | --- |
 * | the lookup ignores `stub.site` and returns the first pin | site A's work | **site B's happy path** — its payload opens against B's key or not at all |
 * | the stub/envelope declaration check is deleted | both happy paths | **the hostile-relay case** — the refusal must name the site mismatch, not the signature |
 * | the seal uses the first pin rather than the job's site | everything the daemon can see | **the result leg** — site B opens the answer to its own job |
 *
 * The third row is the one an end-to-end test would miss entirely: the daemon
 * reports success either way, and only the site notices — which is why the
 * assertion is `open`ing the result as site B rather than checking that a
 * result was sent.
 */

const SITE_A = generateKeys(1_800_000_000_000);
const SITE_B = generateKeys(1_800_000_000_000);
const DEVICE = generateKeys(1_800_000_000_000);

const A = keyId(publicIdentityOf(SITE_A).identity);
const B = keyId(publicIdentityOf(SITE_B).identity);

/** Paired with both, as cloud_009 §5's hub pairing leaves a machine. */
const IDENTITY = {
  keys: () => Promise.resolve(DEVICE),
  sites: new Map<string, PublicIdentity>([
    [A, publicIdentityOf(SITE_A)],
    [B, publicIdentityOf(SITE_B)],
  ]),
};

const SIGNER = {
  runnerId: "runner_1",
  sign: (input: {
    endpoint: string;
    runnerId: string;
    issuedAt: number;
    body: string;
  }) => signRequest(DEVICE, input).signature,
};

/** A payload sealed by a site, exactly as that site would seal it. */
async function sealedBy(
  senderKeys: typeof SITE_A,
  jobId: string,
): Promise<SealedEnvelope> {
  return seal({
    plaintext: JSON.stringify({ prompt: "hi" }),
    senderKeys,
    recipientEncryptionPublic: DEVICE.encryptionPublic,
    context: {
      jobId,
      senderKeyId: keyId(publicIdentityOf(senderKeys).identity),
      recipientKeyId: keyId(publicIdentityOf(DEVICE).identity),
      deadlineAt: Date.now() + 3_600_000,
      direction: "payload",
    },
  });
}

function stub(jobId: string, site: string) {
  return {
    id: jobId,
    site,
    owner: "me",
    kind: "llm.generate",
    sizeClass: "small",
    audience: "self",
    deadlineAt: Date.now() + 600_000,
    streaming: false,
    lease: {
      id: `lease_${jobId}`,
      runnerId: "runner_1",
      expiresAt: Date.now() + 60_000,
    },
  };
}

/** Set by the collision cases: hold every call open until it is aborted. */
let hanging = false;

class StubBackend implements Backend {
  readonly id = "openai-http" as const;
  readonly class = "http" as const;
  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({ healthy: true, models: ["m"] });
  }
  execute(request: BackendRequest): Promise<BackendResult> {
    if (!hanging) {
      return Promise.resolve({
        ok: true,
        text: `ran ${request.prompt}`,
        durationMs: 1,
      });
    }
    started.push(request.prompt);
    return new Promise((resolve) => {
      request.signal.addEventListener(
        "abort",
        () => {
          resolve({
            ok: false,
            code: "canceled",
            message: "aborted",
            retryable: false,
            durationMs: 1,
          });
        },
        { once: true },
      );
    });
  }
}

/** Prompts a hanging backend is currently holding. */
let started: string[] = [];

let dir: string;
let events: RunnerEvent[];
let results: { jobId: string; envelope: SealedEnvelope }[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-two-sites-"));
  events = [];
  results = [];
  started = [];
  hanging = false;
});

afterEach(async () => {
  await removeTemp(dir);
});

/** Serves one claim, then the payload for it, and records the result leg. */
function relay(job: ReturnType<typeof stub>, envelope: SealedEnvelope) {
  let claimed = false;
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const endpoint = url.split("/").pop() ?? "";
    let body: unknown;
    if (endpoint === "claim") {
      body = claimed
        ? { jobs: [], leaseMs: 60_000 }
        : { jobs: [job], leaseMs: 60_000 };
      claimed = true;
    } else if (endpoint === "fetch") {
      body = { envelope };
    } else if (endpoint === "heartbeat") {
      body = {
        // The set this pairing covers — cloud_009 §5. The runner takes it
        // from every heartbeat, so a fixture that sent one site would
        // un-pin the other between ticks.
        sites: {
          [A]: publicIdentityOf(SITE_A),
          [B]: publicIdentityOf(SITE_B),
        },
        awaitingConsent: [],
        cancel: [],
        lost: [],
        serverTime: Date.now(),
      };
    } else if (endpoint === "result") {
      // The client sends a JSON string body; anything else is a fixture bug
      // rather than a case to handle.
      const raw = typeof init?.body === "string" ? init.body : "{}";
      const sent = JSON.parse(raw) as {
        jobId: string;
        envelope: SealedEnvelope;
      };
      results.push({ jobId: sent.jobId, envelope: sent.envelope });
      body = { accepted: true, state: "ok" };
    } else {
      body = { released: [] };
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return fetchImpl;
}

async function runnerOver(fetchImpl: typeof fetch): Promise<Runner> {
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
      concurrency: 2,
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
      identity: SIGNER,
      fetch: fetchImpl,
    }),
    runnerId: "runner_1",
    identity: IDENTITY,
    owner: "me",
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
    backendFactory: () => new StubBackend(),
    heartbeatMs: 5,
    onEvent: (event) => events.push(event),
  });
}

async function settles(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("a daemon paired with two sites", () => {
  it("opens site A's work with site A's key", async () => {
    const job = stub("job_a", A);
    const runner = await runnerOver(
      relay(job, await sealedBy(SITE_A, "job_a")),
    );
    await runner.tick();
    await settles(() => results.length === 1, "site A's result");

    expect(events.filter((e) => e.type === "error")).toEqual([]);
  });

  it("opens site B's work with site B's key", async () => {
    // The case that fails when the lookup ignores `stub.site`: B's payload is
    // signed by B, so a daemon that reached for A's pin refuses it as a bad
    // envelope and reports an error rather than a result.
    const job = stub("job_b", B);
    const runner = await runnerOver(
      relay(job, await sealedBy(SITE_B, "job_b")),
    );
    await runner.tick();
    await settles(() => results.length === 1, "site B's result");

    expect(events.filter((e) => e.type === "error")).toEqual([]);
  });

  it("seals B's answer to B, not to the site it happens to know first", async () => {
    // Invisible from inside the daemon: it reports success whichever key it
    // sealed to. Only the site notices, so the assertion is the site opening
    // it — a result sealed to A is unreadable by B and by everybody else.
    const job = stub("job_b2", B);
    const runner = await runnerOver(
      relay(job, await sealedBy(SITE_B, "job_b2")),
    );
    await runner.tick();
    await settles(() => results.length === 1, "site B's result");

    const sent = results[0];
    expect(sent?.envelope.recipientKeyId).toBe(B);
    const opened = await open({
      envelope: sent!.envelope,
      recipientKeys: SITE_B,
      senderIdentityPublic: publicIdentityOf(DEVICE).identity,
      expected: {
        jobId: "job_b2",
        senderKeyId: keyId(publicIdentityOf(DEVICE).identity),
        recipientKeyId: B,
        direction: "result",
      },
    });
    expect(opened.ok).toBe(true);
  });

  it("refuses a stub naming A wrapped around a payload sealed by B [SITE_KEY_BY_STUB]", async () => {
    // The hostile relay. It holds both halves and is the only party that
    // gains from them disagreeing, so this is the case the site check exists
    // for — and the one the crypto would also refuse, which is why the
    // assertion is on *what it says*. "The payload did not verify" sends
    // whoever reads it to the crypto; the fault is in the routing.
    const job = stub("job_x", A);
    const runner = await runnerOver(
      relay(job, await sealedBy(SITE_B, "job_x")),
    );
    await runner.tick();
    await settles(() => events.some((e) => e.type === "error"), "the refusal");

    const error = events.find((e) => e.type === "error");
    expect(error?.message).toContain(`the stub names site ${A}`);
    expect(error?.message).toContain(`sealed by ${B}`);
    expect(results).toEqual([]);
  });

  it("refuses a site it is not paired with rather than trying a key it has [SITE_KEY_BY_STUB]", async () => {
    // Not "unknown site" as a fallback to the only pin — the relay chooses
    // `stub.site`, so falling back hands it the choice of which key verifies
    // this machine's work.
    const stranger = keyId(
      publicIdentityOf(generateKeys(1_800_000_000_000)).identity,
    );
    const job = stub("job_c", stranger);
    const runner = await runnerOver(
      relay(job, await sealedBy(SITE_A, "job_c")),
    );
    await runner.tick();
    await settles(
      () => events.some((e) => e.type === "refused"),
      "the refusal",
    );

    // The refusal moved earlier with V1-1: admission asks whether this
    // machine serves the site *before* the payload is fetched, so a stub
    // naming a stranger costs a release rather than a fetch, a backend call
    // and a seal that then throws. `#pinFor` still refuses at seal — a
    // backstop is worth keeping — but nothing should ever reach it.
    expect(events.find((e) => e.type === "refused")?.reason).toContain(
      "does not serve site",
    );
    expect(results).toEqual([]);
  });

  it("takes a site the heartbeat adds, and drops one it removes", async () => {
    // cloud_009 §5: the set follows consent, so it changes under a running
    // daemon. A site connected on a dashboard arrives on the next heartbeat;
    // one disconnected leaves, and the rest keep running — which is finding
    // 59, seen from the machine.
    const SITE_C = generateKeys(1_800_000_000_000);
    const C = keyId(publicIdentityOf(SITE_C).identity);
    let announced: Record<string, unknown> = {
      [A]: publicIdentityOf(SITE_A),
      [B]: publicIdentityOf(SITE_B),
    };
    const job = stub("job_c", C);
    let claimed = false;
    const fetchImpl: typeof fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const endpoint = url.split("/").pop() ?? "";
      let body: unknown;
      if (endpoint === "claim") {
        body = claimed
          ? { jobs: [], leaseMs: 60_000 }
          : { jobs: [job], leaseMs: 60_000 };
        claimed = true;
      } else if (endpoint === "fetch") {
        body = { envelope: pending };
      } else if (endpoint === "heartbeat") {
        body = {
          sites: announced,
          awaitingConsent: [],
          cancel: [],
          lost: [],
          serverTime: Date.now(),
        };
      } else if (endpoint === "result") {
        const sent = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as { jobId: string; envelope: SealedEnvelope };
        results.push({ jobId: sent.jobId, envelope: sent.envelope });
        body = { accepted: true, state: "ok" };
      } else {
        body = { released: [] };
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const pending = await sealedBy(SITE_C, "job_c");

    const runner = await runnerOver(fetchImpl);
    // Before: C is not in the set, so its work is refused by name.
    await runner.tick();
    await settles(
      () => events.some((e) => e.type === "refused"),
      "the refusal",
    );
    expect(events.find((e) => e.type === "refused")?.reason).toContain(
      "does not serve site",
    );

    // The upstream adds C — and that is a *request*, not an instruction
    // (V1-1). The site is offered, its fingerprint is shown, and nothing runs
    // for it: an upstream that could add a site by saying so could mint one,
    // sign its own stubs, and have this machine run work nobody consented to.
    announced = { ...announced, [C]: publicIdentityOf(SITE_C) };
    claimed = false;
    await runner.tick();
    await settles(
      () => events.some((e) => e.type === "site-awaiting-approval"),
      "the approval request",
    );
    const asked = events.find((e) => e.type === "site-awaiting-approval");
    expect(asked?.site).toBe(C);
    // The fingerprint is the whole ceremony: it is what the person compares
    // against the site's own screen, so an event without one asks somebody to
    // approve a string of hex they cannot check.
    expect(asked?.fingerprint).toBe(
      fingerprint(publicIdentityOf(SITE_C).identity),
    );
    expect(runner.sites.has(C)).toBe(false);
    expect(results).toEqual([]);

    // Somebody says yes — `byollm approve`, which reaches a running loop
    // through the pairings file.
    runner.applyApprovals(new Map([[C, publicIdentityOf(SITE_C)]]));
    claimed = false;
    await runner.tick();
    await settles(() => results.length === 1, "site C's result");
    expect(runner.sites.has(C)).toBe(true);

    // And removing A takes its pin with it.
    announced = {
      [B]: publicIdentityOf(SITE_B),
      [C]: publicIdentityOf(SITE_C),
    };
    await runner.tick();
    expect(runner.sites.has(A)).toBe(false);
    expect(runner.sites.has(B)).toBe(true);
  });

  it("refuses a key that moved under a site it already pinned", async () => {
    // The map is keyed by identity key id, so a *new identity* is a new
    // entry. This is the encryption key changing under an identity whose
    // fingerprint somebody already compared — the substitution pinning exists
    // to refuse, and a relay is exactly the party that would benefit from it
    // being accepted quietly.
    const impostor = publicIdentityOf(generateKeys(1_800_000_000_009));
    // Signed by A's *own* identity key, which is what a real rotation looks
    // like: the record verifies, `keyId` still resolves to A, and the only
    // thing that moved is the key work gets sealed to. An unsigned splice
    // would be refused one branch earlier for a different reason — and this
    // case is about the branch that has to hold when the paperwork is in
    // order.
    const rotated: PublicIdentity = {
      identity: publicIdentityOf(SITE_A).identity,
      encryption: impostor.encryption,
      encryptionSig: signWith(
        SITE_A,
        Buffer.from(`${ENCRYPTION_KEY_CONTEXT}:${impostor.encryption}`),
      ),
    };
    const announced = { [A]: rotated };
    const fetchImpl: typeof fetch = (input) => {
      const url = String(input instanceof Request ? input.url : input);
      const endpoint = url.split("/").pop() ?? "";
      const body =
        endpoint === "heartbeat"
          ? {
              sites: announced,
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

    const runner = await runnerOver(fetchImpl);
    await runner.tick();

    expect(events.some((e) => e.type === "site-key-changed")).toBe(true);
    // Kept, not replaced: the pin is what the owner compared.
    expect(runner.sites.get(A)?.encryption).toBe(
      publicIdentityOf(SITE_A).encryption,
    );
  });
});

/**
 * Two sites, one job id — V1-3.
 *
 * Job ids are chosen per site, so `job_1` is not one thing. The store learned
 * that (per-(site,id) keys closed the oracle); the daemon had not. It filed
 * work in flight by bare id, which meant the second `job_1` **overwrote the
 * first**: the first lost the handle that could abort it and the lease that
 * could release it, so its lease lapsed mid-run, the upstream offered the work
 * to somebody else, and the same prompt ran twice on somebody's machine.
 *
 * The same ambiguity ran the other way. `cancel` and `lost` were bare ids, so
 * one site withdrawing its `job_1` aborted whichever `job_1` this daemon
 * happened to have filed — a site cancelling another site's work, through no
 * fault of either.
 */
describe("one job id, two sites", () => {
  /** Two jobs called `job_1`, from A and B, claimed in one response. */
  function collidingRelay(): typeof fetch {
    const jobA = {
      ...stub("job_1", A),
      lease: {
        id: "lease_a",
        runnerId: "runner_1",
        expiresAt: Date.now() + 60_000,
      },
    };
    const jobB = {
      ...stub("job_1", B),
      lease: {
        id: "lease_b",
        runnerId: "runner_1",
        expiresAt: Date.now() + 60_000,
      },
    };
    let claimed = false;
    return (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const endpoint = url.split("/").pop() ?? "";
      let body: unknown;
      if (endpoint === "claim") {
        body = claimed
          ? { jobs: [], leaseMs: 60_000 }
          : { jobs: [jobA, jobB], leaseMs: 60_000 };
        claimed = true;
      } else if (endpoint === "fetch") {
        // Which site's payload depends on which grant asked — the fetch names
        // the lease, so this fixture answers the way a relay would.
        const asked = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as { leaseId?: string };
        body = { envelope: asked.leaseId === "lease_b" ? sealedB : sealedA };
      } else if (endpoint === "heartbeat") {
        const asked = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as { activeLeases?: { jobId: string; leaseId: string }[] };
        beats.push(asked.activeLeases ?? []);
        body = {
          sites: {
            [A]: publicIdentityOf(SITE_A),
            [B]: publicIdentityOf(SITE_B),
          },
          awaitingConsent: [],
          cancel: cancelNext,
          lost: [],
          serverTime: Date.now(),
        };
        cancelNext = [];
      } else if (endpoint === "result") {
        const sent = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as { jobId: string; envelope: SealedEnvelope; disposition: string };
        results.push({ jobId: sent.jobId, envelope: sent.envelope });
        dispositions.push(sent.disposition);
        body = { accepted: true, state: "ok" };
      } else {
        body = { released: [] };
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        }),
      );
    };
  }

  let sealedA: SealedEnvelope;
  let sealedB: SealedEnvelope;
  let beats: { jobId: string; leaseId: string }[][];
  let cancelNext: { jobId: string; leaseId: string }[];
  let dispositions: string[];

  beforeEach(async () => {
    hanging = true;
    beats = [];
    cancelNext = [];
    dispositions = [];
    sealedA = await sealedBy(SITE_A, "job_1");
    sealedB = await sealedBy(SITE_B, "job_1");
  });

  it("holds both, and names both grants on the heartbeat", async () => {
    const runner = await runnerOver(collidingRelay());
    await runner.tick();
    await settles(() => started.length === 2, "both jobs to reach a backend");

    // Two pieces of work, not one. Keyed by id, the second arrival replaced
    // the first here and the count read 1 — with the first still running,
    // untracked and unstoppable.
    expect(runner.status().activeJobs).toBe(2);

    await runner.tick();
    const named = beats.at(-1) ?? [];
    expect(named.map((lease) => lease.leaseId).sort()).toEqual([
      "lease_a",
      "lease_b",
    ]);
    // Which is the property that matters: a grant this daemon holds but does
    // not name is a lease the upstream lets lapse, and lapsed work is offered
    // to somebody else while it is still running here.
    //
    // Stopped *and waited for*: aborting a hanging backend resolves the job,
    // which then seals and posts a result. Leaving that in flight let it land
    // in the next test's `results` — which is how this file first failed on
    // CI and passed here, the timing difference being the only thing between
    // them.
    runner.cancelAll();
    await settles(() => results.length === 2, "both jobs to finish cancelling");
  });

  it("cancels the grant that was cancelled, and only that one", async () => {
    const runner = await runnerOver(collidingRelay());
    await runner.tick();
    await settles(() => started.length === 2, "both jobs to reach a backend");

    // Site B withdraws its `job_1`. Site A's is a different job that happens
    // to share a name.
    cancelNext = [{ jobId: "job_1", leaseId: "lease_b" }];
    await runner.tick();

    await settles(() => dispositions.length === 1, "B's cancellation");
    expect(dispositions).toEqual(["canceled"]);
    expect(runner.status().activeJobs).toBe(1);

    // **Which** one survived, not merely how many. A count is satisfied by
    // aborting the wrong job — which is exactly the failure this case is
    // about, and a mutation that cancelled the first matching id passed the
    // count assertion alone.
    await runner.tick();
    expect((beats.at(-1) ?? []).map((lease) => lease.leaseId)).toEqual([
      "lease_a",
    ]);
    runner.cancelAll();
    await settles(() => results.length === 2, "A's job to finish cancelling");
  });
});

/**
 * Consent ending while the work is running — V1-7.
 *
 * The set shrinking used to be the *whole* of what happened: the pin was
 * dropped and the job kept going. It ran to completion on somebody's machine —
 * their electricity, or their API credit — and then threw at the seal, because
 * sealing needs the pin that had just been dropped. Full cost, no result, and
 * the person who paid for it was the one who had withdrawn.
 */
describe("a site that withdraws mid-job", () => {
  it("stops the work, sends no result, and hands the lease back", async () => {
    hanging = true;
    let announced: Record<string, PublicIdentity> = {
      [A]: publicIdentityOf(SITE_A),
      [B]: publicIdentityOf(SITE_B),
    };
    const released: { reason: string; leases: unknown[] }[] = [];
    const job = stub("job_a", A);
    const sealed = await sealedBy(SITE_A, "job_a");
    let claimed = false;

    const fetchImpl: typeof fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const endpoint = url.split("/").pop() ?? "";
      let body: unknown;
      if (endpoint === "claim") {
        body = claimed
          ? { jobs: [], leaseMs: 60_000 }
          : { jobs: [job], leaseMs: 60_000 };
        claimed = true;
      } else if (endpoint === "fetch") {
        body = { envelope: sealed };
      } else if (endpoint === "heartbeat") {
        body = {
          sites: announced,
          awaitingConsent: [],
          cancel: [],
          lost: [],
          serverTime: Date.now(),
        };
      } else if (endpoint === "result") {
        const sent = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as { jobId: string; envelope: SealedEnvelope };
        results.push({ jobId: sent.jobId, envelope: sent.envelope });
        body = { accepted: true, state: "ok" };
      } else {
        released.push(
          JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
            reason: string;
            leases: unknown[];
          },
        );
        body = { released: [] };
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        }),
      );
    };

    const runner = await runnerOver(fetchImpl);
    await runner.tick();
    await settles(() => started.length === 1, "the job to reach a backend");

    // A withdraws. B is untouched, which is what makes this per-site.
    announced = { [B]: publicIdentityOf(SITE_B) };
    await runner.tick();

    await settles(() => released.length === 1, "the lease to go back");
    expect(released[0]?.reason).toBe("revoked");
    // No result: there is nothing to seal to, and an answer sealed to a
    // withdrawn site is an answer nobody may read.
    expect(results).toEqual([]);
    expect(runner.status().activeJobs).toBe(0);
    // And the daemon said so rather than logging a seal that threw.
    expect(events.find((e) => e.type === "refused")?.reason ?? "").toContain(
      "withdrew consent",
    );
  });
});

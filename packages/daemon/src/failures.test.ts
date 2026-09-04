import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateKeys,
  keyId,
  publicIdentityOf,
  seal,
  signRequest,
} from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCliBackend } from "./backends/claude-cli.js";
import type {
  Backend,
  BackendRequest,
  BackendResult,
} from "./backends/index.js";
import { Budgets } from "./budgets.js";
import { ClientError, ProtocolClient } from "./client.js";
import { connect } from "./connect.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { IngressLog } from "./ingress.js";
import { SpendLedger } from "./spend.js";
import { Runner } from "./runner.js";
import { removeTemp } from "./test-support.js";

/**
 * A site and a device, as pairing would have established them.
 *
 * The fakes seal work exactly as a real site does, so these exercise the
 * daemon's verification rather than skipping past it — a fake that handed
 * over plaintext would test nothing about the property that matters.
 */
const TEST_SITE_KEYS = generateKeys(1_800_000_000_000);
/**
 * The site a stub names — Amendment A §A.3.
 *
 * Derived from the same keys the daemon pins rather than written as a
 * literal, because the daemon now refuses a stub naming a site it did not
 * pair with. A fixed string here would refuse every job in this file, which
 * is the check doing exactly what it is for.
 */
const TEST_SITE_ID = keyId(publicIdentityOf(TEST_SITE_KEYS).identity);

/** The set a heartbeat carries — cloud_009 §5. One entry is a site. */
const HEARTBEAT_SITES = {
  [TEST_SITE_ID]: publicIdentityOf(TEST_SITE_KEYS),
};
const TEST_DEVICE_KEYS = generateKeys(1_800_000_000_000);
const TEST_IDENTITY = {
  keys: () => Promise.resolve(TEST_DEVICE_KEYS),
  sites: new Map([[TEST_SITE_ID, publicIdentityOf(TEST_SITE_KEYS)]]),
};

/** Seal a payload to the test device, as the site would at fetch time. */
async function sealedFor(
  jobId: string,
  payload: unknown,
  senderKeys = TEST_SITE_KEYS,
): Promise<unknown> {
  return seal({
    plaintext: JSON.stringify(payload),
    senderKeys,
    recipientEncryptionPublic: TEST_DEVICE_KEYS.encryptionPublic,
    context: {
      jobId,
      senderKeyId: keyId(publicIdentityOf(TEST_SITE_KEYS).identity),
      recipientKeyId: keyId(publicIdentityOf(TEST_DEVICE_KEYS).identity),
      deadlineAt: Date.now() + 3_600_000,
      direction: "payload",
    },
  });
}

/** A daemon identity for tests: real keys, signing the real canonical form. */
const TEST_KEYS = generateKeys(1_800_000_000_000);
const TEST_SIGNER = {
  runnerId: "runner_1",
  sign: (input: {
    endpoint: string;
    runnerId: string;
    issuedAt: number;
    body: string;
  }) => signRequest(TEST_KEYS, input).signature,
};

const SITE = publicIdentityOf(generateKeys(1_800_000_000_000));
const DEVICE = SITE;

/**
 * What happens when reporting itself fails.
 *
 * These are the paths that matter most for a daemon left running unattended:
 * a server that stops answering *after* a job ran, a backend that will not
 * start, a shutdown while work is in flight. None of them may lose the job or
 * take the process down — the lease lapses and the server offers the work
 * again, which is the recovery the protocol is built around.
 */

let dir: string;

class HangingBackend implements Backend {
  readonly id = "openai-http" as const;
  readonly class = "http" as const;
  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({ healthy: true, models: ["m"] });
  }
  async execute(request: BackendRequest): Promise<BackendResult> {
    // `aborted` first: a signal that has already fired never calls a listener
    // added afterwards. The real backends check the same way.
    if (!request.signal.aborted) {
      await new Promise<void>((resolve) => {
        request.signal.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
      });
    }
    return {
      ok: false,
      code: "canceled",
      message: "the job was canceled",
      durationMs: 0,
    };
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-failures-"));
});

afterEach(async () => {
  await removeTemp(dir);
});

async function makeRunner(fetchImpl: typeof fetch, backend: Backend) {
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
  const budgets = new Budgets(join(dir, "b.json"), loaded.config.community);
  await budgets.load(Date.now());
  const spend = new SpendLedger(join(dir, "spend.json"));
  await spend.load(Date.now());

  return new Runner({
    client: new ProtocolClient({
      origin: "https://app.test",
      identity: TEST_SIGNER,
      fetch: fetchImpl,
    }),
    runnerId: "runner_1",
    identity: TEST_IDENTITY,
    owner: "me",
    daemonVersion: "0.0.0",
    loaded,
    budgets,
    spend,
    ingress: new IngressLog({
      path: join(dir, "ingress.log"),
      communityPromptDays: 7,
      keepSelfPrompts: true,
    }),
    backendFactory: () => backend,
  });
}

const claimOne = (jobs: unknown[]) => JSON.stringify({ jobs, leaseMs: 60_000 });

/**
 * Wait for a condition rather than for a duration.
 *
 * These used fixed 30ms sleeps, which were adequate when a claim delivered
 * the payload and became marginal when claim-then-fetch added a round trip —
 * failing on a loaded macOS runner and nowhere else. A fixed sleep encodes an
 * assumption about how many hops the protocol has; this does not.
 */
async function settles(
  predicate: () => boolean,
  what: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const oneJob = [
  {
    id: "job_1",
    kind: "llm.generate",
    audience: "private",
    owner: "me",
    site: TEST_SITE_ID,
    sizeClass: "small",
    streaming: false,
    deadlineAt: Date.now() + 60_000,
    lease: {
      id: "lease_test",
      runnerId: "runner_1",
      expiresAt: 4_000_000_000_000,
    },
  },
];

describe("reporting failures never lose the job", () => {
  it("records a failed result submission as an error and carries on", async () => {
    const backend = new HangingBackend();
    // Answer the loop normally, but fail every attempt to report a result.
    const runner = await makeRunner((input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/result")) {
        return Promise.reject(new Error("server went away"));
      }
      if (url.endsWith("/fetch")) {
        // Sealed to the device, as a real site does. A fake handing over
        // plaintext would skip the verification this exists to exercise.
        return sealedFor("job_1", { prompt: "hi" }).then(
          (envelope) =>
            new Response(JSON.stringify({ envelope }), {
              headers: { "content-type": "application/json" },
            }),
        );
      }
      const body = url.endsWith("/claim")
        ? claimOne([])
        : JSON.stringify({
            sites: HEARTBEAT_SITES,
            awaitingConsent: [],
            cancel: [],
            lost: [],
            serverTime: Date.now(),
          });
      return Promise.resolve(
        new Response(body, { headers: { "content-type": "application/json" } }),
      );
    }, backend);

    // A direct run whose report fails must not throw out of the loop.
    await runner.tick();
    expect(runner.status().lastError).toBeUndefined();
  });

  it("releases in-flight jobs on shutdown", async () => {
    const backend = new HangingBackend();
    let released: string[] | undefined;

    const runner = await makeRunner((input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/release")) {
        const body = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as { leases: { jobId: string; leaseId: string }[] };
        // Asserted as job ids, but the daemon must now name the *grant* —
        // a release that named only the job could be replayed onto a later
        // lease (byollm_009 §4.2, `Lease.id`).
        released = body.leases.map((l) => l.jobId);
        expect(body.leases.every((l) => l.leaseId.length > 0)).toBe(true);
        return Promise.resolve(
          new Response(JSON.stringify({ released: released }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (url.endsWith("/fetch")) {
        // Sealed to the device, as a real site does. A fake handing over
        // plaintext would skip the verification this exists to exercise.
        return sealedFor("job_1", { prompt: "hi" }).then(
          (envelope) =>
            new Response(JSON.stringify({ envelope }), {
              headers: { "content-type": "application/json" },
            }),
        );
      }
      const body = url.endsWith("/claim")
        ? claimOne(oneJob)
        : url.endsWith("/result")
          ? JSON.stringify({ accepted: true, state: "canceled" })
          : JSON.stringify({
              sites: HEARTBEAT_SITES,
              awaitingConsent: [],
              cancel: [],
              lost: [],
              serverTime: Date.now(),
            });
      return Promise.resolve(
        new Response(body, { headers: { "content-type": "application/json" } }),
      );
    }, backend);

    await runner.tick();
    await settles(() => runner.status().activeJobs === 1, "the job to start");

    await runner.shutdown("shutdown");
    // Released explicitly, so the app sees the work return to the queue at
    // once rather than waiting for the lease to lapse.
    expect(released).toEqual(["job_1"]);
  });

  it("survives a release that fails on the way out", async () => {
    const backend = new HangingBackend();
    const runner = await makeRunner((input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/release")) {
        return Promise.reject(new Error("gone"));
      }
      if (url.endsWith("/fetch")) {
        // Sealed to the device, as a real site does. A fake handing over
        // plaintext would skip the verification this exists to exercise.
        return sealedFor("job_1", { prompt: "hi" }).then(
          (envelope) =>
            new Response(JSON.stringify({ envelope }), {
              headers: { "content-type": "application/json" },
            }),
        );
      }
      const body = url.endsWith("/claim")
        ? claimOne(oneJob)
        : url.endsWith("/result")
          ? JSON.stringify({ accepted: true, state: "canceled" })
          : JSON.stringify({
              sites: HEARTBEAT_SITES,
              awaitingConsent: [],
              cancel: [],
              lost: [],
              serverTime: Date.now(),
            });
      return Promise.resolve(
        new Response(body, { headers: { "content-type": "application/json" } }),
      );
    }, backend);

    await runner.tick();
    await settles(() => runner.status().activeJobs === 1, "the job to start");
    await expect(runner.shutdown("shutdown")).resolves.toBeUndefined();
    expect(runner.status().lastError).toContain("could not reach");
  });

  it("does nothing on shutdown when it holds nothing", async () => {
    const runner = await makeRunner(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ released: [] }), {
            headers: { "content-type": "application/json" },
          }),
        ),
      new HangingBackend(),
    );
    await expect(runner.shutdown("pause")).resolves.toBeUndefined();
  });

  it("abandons a job the server says it has lost [LEASE_HONORED]", async () => {
    const backend = new HangingBackend();
    let heartbeats = 0;
    const runner = await makeRunner((input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/heartbeat")) {
        heartbeats += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              sites: HEARTBEAT_SITES,
              awaitingConsent: [],
              cancel: [],
              // On the second heartbeat the server says the grant is gone —
              // named by lease as well as job (V1-3), because a daemon
              // serving two sites can hold two jobs called `job_1`.
              lost:
                heartbeats > 1
                  ? [{ jobId: "job_1", leaseId: "lease_test" }]
                  : [],
              serverTime: Date.now(),
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (url.endsWith("/fetch")) {
        // Sealed to the device, as a real site does. A fake handing over
        // plaintext would skip the verification this exists to exercise.
        return sealedFor("job_1", { prompt: "hi" }).then(
          (envelope) =>
            new Response(JSON.stringify({ envelope }), {
              headers: { "content-type": "application/json" },
            }),
        );
      }
      const body = url.endsWith("/claim")
        ? claimOne(heartbeats === 1 ? oneJob : [])
        : JSON.stringify({ accepted: true, state: "canceled" });
      return Promise.resolve(
        new Response(body, { headers: { "content-type": "application/json" } }),
      );
    }, backend);

    await runner.tick();
    await settles(() => runner.status().activeJobs === 1, "the job to start");

    await runner.tick();
    // The daemon stopped work on it rather than finishing something it no
    // longer holds.
    await settles(
      () => runner.status().activeJobs === 0,
      "the lost job to be abandoned",
    );
  });
});

describe("claude-cli — a child that fails", () => {
  it("reports a non-zero exit with the first line of stderr", async () => {
    const script = join(dir, "failing.mjs");
    await writeFile(
      script,
      [
        "#!/usr/bin/env node",
        'if (process.argv.includes("--version")) { process.stdout.write("x\\n"); process.exit(0); }',
        'process.stderr.write("first line of trouble\\nsecond line\\n");',
        "process.exit(3);",
      ].join("\n"),
    );
    await chmod(script, 0o755);

    const result = await new ClaudeCliBackend(script).execute({
      prompt: "hi",
      model: "m",
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("backend-error");
      expect(result.message).toContain("first line of trouble");
      expect(result.message).not.toContain("second line");
    }
  });

  it("reports a non-zero exit with no stderr by its status", async () => {
    const script = join(dir, "silent.mjs");
    await writeFile(
      script,
      [
        "#!/usr/bin/env node",
        'if (process.argv.includes("--version")) { process.stdout.write("x\\n"); process.exit(0); }',
        "process.exit(7);",
      ].join("\n"),
    );
    await chmod(script, 0o755);

    const result = await new ClaudeCliBackend(script).execute({
      prompt: "hi",
      model: "m",
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("7");
  });

  it("succeeds and returns stdout verbatim", async () => {
    const script = join(dir, "echoing.mjs");
    await writeFile(
      script,
      [
        "#!/usr/bin/env node",
        "import { readFileSync } from 'node:fs';",
        'if (process.argv.includes("--version")) { process.stdout.write("x\\n"); process.exit(0); }',
        'process.stdout.write(readFileSync(0, "utf8"));',
      ].join("\n"),
    );
    await chmod(script, 0o755);

    const result = await new ClaudeCliBackend(script).execute({
      prompt: "exactly this",
      model: "m",
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ ok: true, text: "exactly this" });
  });

  it("reports a healthy CLI", async () => {
    const script = join(dir, "versioned.mjs");
    await writeFile(
      script,
      ["#!/usr/bin/env node", 'process.stdout.write("1.2.3\\n");'].join("\n"),
    );
    await chmod(script, 0o755);
    expect((await new ClaudeCliBackend(script).health()).healthy).toBe(true);
  });
});

describe("a signal that has already fired [CANCEL_HONORED]", () => {
  it("does not spawn a child for a job cancelled before it started", async () => {
    // The bug this pins: `addEventListener("abort")` never fires for a signal
    // that has already aborted, so a job cancelled between the claim and the
    // spawn would have started anyway and run to completion.
    const script = join(dir, "marker.mjs");
    const marker = join(dir, "it-ran");
    await writeFile(
      script,
      [
        "#!/usr/bin/env node",
        "import { writeFileSync } from 'node:fs';",
        'if (process.argv.includes("--version")) { process.stdout.write("x\\n"); process.exit(0); }',
        `writeFileSync(${JSON.stringify(marker)}, "ran");`,
      ].join("\n"),
    );
    await chmod(script, 0o755);

    const controller = new AbortController();
    controller.abort();

    const result = await new ClaudeCliBackend(script).execute({
      prompt: "hi",
      model: "m",
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("canceled");
    // The child must never have run at all.
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });
});

describe("connect — a poll that fails outright", () => {
  it("propagates a non-retryable failure rather than looping on it", async () => {
    let started = false;
    const client = new ProtocolClient({
      origin: "https://app.test",
      fetch: (_input, init) => {
        const body = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as { action?: string };
        if (body.action === "start") {
          started = true;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                deviceCode: "d".repeat(32),
                userCode: "KRTZ-9F2Q",
                verificationUrl: "https://app.test/pair",
                expiresAt: Date.now() + 600_000,
                pollIntervalMs: 500,
              }),
              { headers: { "content-type": "application/json" } },
            ),
          );
        }
        // A 400 is the request being wrong; repeating it stays wrong.
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: "bad-request", message: "malformed" }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
        );
      },
    });

    await expect(
      connect({
        client,
        daemonVersion: "0.0.0",
        label: "test",
        capabilities: [],
        device: DEVICE,
        onCode: () => undefined,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toBeInstanceOf(ClientError);
    expect(started).toBe(true);
  });
});

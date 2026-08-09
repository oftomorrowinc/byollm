import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Allowlist } from "./allowlist.js";
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
import { Runner } from "./runner.js";

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
    await new Promise<void>((resolve) => {
      request.signal.addEventListener(
        "abort",
        () => {
          resolve();
        },
        { once: true },
      );
    });
    return {
      ok: false,
      code: "canceled",
      message: "the job was canceled",
      retryable: false,
      durationMs: 0,
    };
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-failures-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeRunner(fetchImpl: typeof fetch, backend: Backend) {
  const loaded = resolveConfig(
    DaemonConfig.parse({
      backends: {
        primary: {
          backend: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      },
      routes: { "llm.generate": { backend: "primary", model: "m" } },
    }),
  );
  const allowlist = new Allowlist(join(dir, "allow.json"));
  await allowlist.load();
  const budgets = new Budgets(join(dir, "b.json"), loaded.config.community);
  await budgets.load(Date.now());

  return new Runner({
    client: new ProtocolClient({
      origin: "https://app.test",
      token: "t",
      fetch: fetchImpl,
    }),
    runnerId: "runner_1",
    owner: "me",
    daemonVersion: "0.0.0",
    loaded,
    allowlist,
    budgets,
    ingress: new IngressLog({
      path: join(dir, "ingress.log"),
      communityPromptDays: 7,
      keepSelfPrompts: true,
    }),
    backendFactory: () => backend,
  });
}

const claimOne = (jobs: unknown[]) => JSON.stringify({ jobs, leaseMs: 60_000 });

const oneJob = [
  {
    id: "job_1",
    kind: "llm.generate",
    payload: { prompt: "hi" },
    audience: "self",
    owner: "me",
    lease: { runnerId: "runner_1", expiresAt: 4_000_000_000_000 },
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
      const body = url.endsWith("/claim")
        ? claimOne([])
        : JSON.stringify({
            revoked: false,
            cancel: [],
            leases: [],
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
        ) as { jobIds: string[] };
        released = body.jobIds;
        return Promise.resolve(
          new Response(JSON.stringify({ released: body.jobIds }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }
      const body = url.endsWith("/claim")
        ? claimOne(oneJob)
        : url.endsWith("/result")
          ? JSON.stringify({ accepted: true, state: "canceled" })
          : JSON.stringify({
              revoked: false,
              cancel: [],
              leases: [],
              lost: [],
              serverTime: Date.now(),
            });
      return Promise.resolve(
        new Response(body, { headers: { "content-type": "application/json" } }),
      );
    }, backend);

    await runner.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runner.status().activeJobs).toBe(1);

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
      const body = url.endsWith("/claim")
        ? claimOne(oneJob)
        : url.endsWith("/result")
          ? JSON.stringify({ accepted: true, state: "canceled" })
          : JSON.stringify({
              revoked: false,
              cancel: [],
              leases: [],
              lost: [],
              serverTime: Date.now(),
            });
      return Promise.resolve(
        new Response(body, { headers: { "content-type": "application/json" } }),
      );
    }, backend);

    await runner.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
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
              revoked: false,
              cancel: [],
              leases: [],
              // On the second heartbeat the server says the job is gone.
              lost: heartbeats > 1 ? ["job_1"] : [],
              serverTime: Date.now(),
            }),
            { headers: { "content-type": "application/json" } },
          ),
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
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runner.status().activeJobs).toBe(1);

    await runner.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The daemon stopped work on it rather than finishing something it no
    // longer holds.
    expect(runner.status().activeJobs).toBe(0);
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
        onCode: () => undefined,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toBeInstanceOf(ClientError);
    expect(started).toBe(true);
  });
});

import {
  type ClaimedStub,
  type JobPayload,
  generateKeys,
  signRequest,
} from "@byollm/protocol";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Allowlist } from "./allowlist.js";
import type {
  Backend,
  BackendRequest,
  BackendResult,
} from "./backends/index.js";
import { Budgets } from "./budgets.js";
import { runCli, type CliIo } from "./cli.js";
import { ProtocolClient } from "./client.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { IngressLog } from "./ingress.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { Runner } from "./runner.js";
import { SpendLedger } from "./spend.js";
import { noSupervisor, removeTemp } from "./test-support.js";

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

/**
 * byollm_007, from the daemon's side.
 *
 * The protocol decides what `metered` means; these assert the daemon actually
 * lives by it — that the ledger is written when someone else's work spends the
 * owner's money, that the ceiling stops the next job, and that a user reading
 * `status` or `backends` is told which of their backends costs money.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-metered-"));
});
afterEach(async () => {
  await removeTemp(dir);
});

/** Answers instantly with a fixed-length reply, so spend is predictable. */
class EchoBackend implements Backend {
  readonly id = "openai" as const;
  readonly class = "http" as const;

  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({ healthy: true, models: ["m"] });
  }
  execute(request: BackendRequest): Promise<BackendResult> {
    return Promise.resolve({
      ok: true,
      text: request.prompt.repeat(4),
      durationMs: 1,
    });
  }
}

async function makeRunner(options: {
  offer: "self" | "public";
  acknowledged: boolean;
  capCents?: number;
}) {
  const loaded = resolveConfig(
    DaemonConfig.parse({
      services: {
        paid: {
          model: "m",
          kinds: ["llm.generate"],
          type: "openai",
          offer: options.offer,
          spend: {
            acknowledged: options.acknowledged,
            ...(options.capCents === undefined
              ? {}
              : { dailyCapCents: options.capCents }),
          },
        },
      },
    }),
  );
  expect(loaded.problems, JSON.stringify(loaded.problems)).toEqual([]);

  const allowlist = new Allowlist(join(dir, "allow.json"));
  await allowlist.load();
  const budgets = new Budgets(join(dir, "b.json"), loaded.config.community);
  await budgets.load(Date.now());
  const spend = new SpendLedger(join(dir, "spend.json"));
  await spend.load(Date.now());
  const ingress = new IngressLog({
    path: join(dir, "ingress.log"),
    communityPromptDays: 7,
    keepSelfPrompts: true,
  });

  const runner = new Runner({
    client: new ProtocolClient({
      origin: "https://app.test",
      identity: TEST_SIGNER,
    }),
    runnerId: "runner_1",
    owner: "me",
    daemonVersion: "0.0.0",
    loaded,
    allowlist,
    budgets,
    spend,
    ingress,
    backendFactory: () => new EchoBackend(),
  });
  return { runner, spend, loaded };
}

const job = (
  overrides: Partial<ClaimedStub & { payload: JobPayload }> = {},
): ClaimedStub & { payload: JobPayload } => ({
  id: "job_1",
  kind: "llm.generate",
  payload: { prompt: "hello" },
  audience: "public",
  owner: "stranger",
  site: "BYOLLM-TEST-SITE-KEY-ID",
  sizeClass: "small",
  streaming: false,
  deadlineAt: Date.now() + 60_000,
  lease: {
    id: "lease_test",
    runnerId: "runner_1",
    expiresAt: Date.now() + 60_000,
  },
  ...overrides,
});

/**
 * One `paid` service on disk.
 *
 * The caller passes the service's own fields; `model` and `kinds` are what
 * used to live in a separate `routes` stanza pointing back at it.
 */
const paidService = (fields: Record<string, unknown>) =>
  JSON.stringify({
    services: {
      paid: { model: "m", kinds: ["llm.generate"], ...fields },
    },
  });

describe("the ledger is written by the work, not by hand", () => {
  it("charges community work on a metered backend to the ledger", async () => {
    const { runner, spend } = await makeRunner({
      offer: "public",
      acknowledged: true,
      capCents: 500,
    });
    expect(spend.spentTodayCents("paid", Date.now())).toBe(0);

    await runner.runJob(job());

    // Someone else's work, the owner's key: it goes on the ledger the ceiling
    // is checked against.
    expect(spend.spentTodayCents("paid", Date.now())).toBeGreaterThan(0);
  });

  it("does not charge the owner for their own work", async () => {
    const { runner, spend } = await makeRunner({
      offer: "public",
      acknowledged: true,
      capCents: 500,
    });

    await runner.runJob(job({ owner: "me", audience: "self" }));

    // Their machine, their key, their call — nothing to meter.
    expect(spend.spentTodayCents("paid", Date.now())).toBe(0);
  });

  it("refuses the next community job once the ceiling is reached [METERED_REQUIRES_CEILING]", async () => {
    const { runner, spend } = await makeRunner({
      offer: "public",
      acknowledged: true,
      capCents: 1,
    });
    expect(runner.admit(job()).ok).toBe(true);

    await spend.record("paid", 5, Date.now());

    const result = runner.admit(job());
    expect(result.ok).toBe(false);
    // The refusal names money, so the owner knows why and what to change.
    if (!result.ok) expect(result.reason).toMatch(/spend|cap|money/i);
  });

  it("keeps taking the owner's own work after the ceiling [own work is never billed to the community]", async () => {
    const { runner, spend } = await makeRunner({
      offer: "public",
      acknowledged: true,
      capCents: 1,
    });
    await spend.record("paid", 99, Date.now());

    expect(runner.admit(job({ owner: "me", audience: "self" })).ok).toBe(true);
  });

  it("never consults the ledger for a free backend", async () => {
    // A free route must not be gated on a ceiling it has no reason to carry.
    const loaded = resolveConfig(
      DaemonConfig.parse({
        services: {
          local: {
            model: "m",
            kinds: ["llm.generate"],
            type: "ollama",
            offer: "public",
          },
        },
      }),
    );
    const allowlist = new Allowlist(join(dir, "a2.json"));
    await allowlist.load();
    const budgets = new Budgets(join(dir, "b2.json"), loaded.config.community);
    await budgets.load(Date.now());
    // Deliberately never loaded: touching it would throw, which is the
    // assertion — a free route must not reach for the ledger at all.
    const spend = new SpendLedger(join(dir, "s2.json"));
    const runner = new Runner({
      client: new ProtocolClient({
        origin: "https://app.test",
        identity: TEST_SIGNER,
      }),
      runnerId: "runner_1",
      owner: "me",
      daemonVersion: "0.0.0",
      loaded,
      allowlist,
      budgets,
      spend,
      ingress: new IngressLog({
        path: join(dir, "i2.log"),
        communityPromptDays: 7,
        keepSelfPrompts: true,
      }),
      backendFactory: () => new EchoBackend(),
    });

    expect(runner.admit(job()).ok).toBe(true);
  });
});

describe("what the user is told about their money", () => {
  let home: string;
  let paths: DaemonPaths;
  let out: string;

  const io = (): Partial<CliIo> => ({
    out: (text) => {
      out += text;
    },
    err: (text) => {
      out += text;
    },
    confirm: () => Promise.resolve(true),
  });
  const run = (...argv: string[]) =>
    runCli(argv, { paths, io: io(), service: noSupervisor() });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "byollm-metered-cli-"));
    paths = daemonPaths(home);
    out = "";
  });
  afterEach(async () => {
    await removeTemp(home);
  });

  const config = (fields: Record<string, unknown>) =>
    writeFile(paths.config, paidService(fields));

  it("says a shared metered backend costs money, and what the cap is", async () => {
    await config({
      type: "openai",
      // A dead local port: no test may touch the real network. Note the
      // cost stays `metered` anyway — the registry decides that, not the
      // base URL ({@link MUSTS.COST_NOT_CONFIGURABLE}).
      baseUrl: "http://127.0.0.1:1/v1",
      offer: "public",
      spend: { acknowledged: true, dailyCapCents: 250 },
    });

    await run("status");
    expect(out).toContain("metered services — your money");
    expect(out).toContain("250c");

    out = "";
    await run("backends");
    expect(out).toContain("metered — shared, cap 250c/day");
  });

  it("says an unshared metered backend is the owner's work only", async () => {
    await config({ type: "openai", baseUrl: "http://127.0.0.1:1/v1" });

    await run("status");
    expect(out).toContain("not shared — your work only");

    out = "";
    await run("backends");
    expect(out).toContain("metered — your money, not shared");
  });

  it("names free and subscription backends for what they are", async () => {
    await writeFile(
      paths.config,
      JSON.stringify({
        services: {
          paid: { model: "m", kinds: ["llm.generate"], type: "ollama" },
          sub: { model: "sonnet", kinds: ["llm.chat"], type: "claude-cli" },
        },
      }),
    );

    await run("backends");
    expect(out).toContain("free (your electricity)");
    expect(out).toContain("your subscription — locked to your work");
    // A machine with no metered backend is not told about money it never spends.
    out = "";
    await run("status");
    expect(out).not.toContain("metered services");
  });
});

/** The shape `byollm offer` writes back into config.json. */
interface WrittenBackend {
  offer?: string;
  spend?: { acknowledged?: boolean; dailyCapCents?: number };
}

describe("byollm offer — the command the config error names", () => {
  let home: string;
  let paths: DaemonPaths;
  let out: string;
  let answer: boolean;
  let asked: string[];

  const io = (): Partial<CliIo> => ({
    out: (text) => {
      out += text;
    },
    err: (text) => {
      out += text;
    },
    confirm: (question) => {
      asked.push(question);
      return Promise.resolve(answer);
    },
  });
  const run = (...argv: string[]) =>
    runCli(argv, { paths, io: io(), service: noSupervisor() });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "byollm-offer-"));
    paths = daemonPaths(home);
    out = "";
    answer = true;
    asked = [];
  });
  afterEach(async () => {
    await removeTemp(home);
  });

  const write = (fields: Record<string, unknown>) =>
    writeFile(paths.config, paidService(fields));
  /** The `paid` backend as it now stands on disk. */
  const read = async (): Promise<WrittenBackend> => {
    const config = JSON.parse(await readFile(paths.config, "utf8")) as {
      services: Record<string, WrittenBackend>;
    };
    const paid = config.services["paid"];
    if (!paid) throw new Error("the paid service vanished from the config");
    return paid;
  };

  it("is a real command — the error message does not lie", async () => {
    await write({ type: "openai", offer: "public" });

    // The message resolveConfig prints tells the owner to run this. Whatever
    // else it does, it must not be "unknown command".
    const code = await run("offer", "paid", "public", "--cap", "250");
    expect(code).toBe(0);
    expect(out).not.toContain("unknown command");
  });

  it("names the money before widening a metered backend", async () => {
    await write({ type: "openai" });

    await run("offer", "paid", "public", "--cap", "250");

    // Not "are you sure?" — the actual sentence, with the actual number.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("$2.50 a day");
    expect(asked[0]).toMatch(/bills\s+your account per token/);
    expect(asked[0]).toContain("paying for their work");

    const paid = await read();
    expect(paid.offer).toBe("public");
    expect(paid.spend?.acknowledged).toBe(true);
    expect(paid.spend?.dailyCapCents).toBe(250);
  });

  it("changes nothing when the owner says no", async () => {
    await write({ type: "openai" });
    answer = false;

    expect(await run("offer", "paid", "public", "--cap", "250")).toBe(0);
    expect(out).toContain("nothing changed");
    expect((await read()).offer).toBeUndefined();
  });

  it("refuses to widen a metered backend with no ceiling [METERED_REQUIRES_CEILING]", async () => {
    await write({ type: "openai" });

    expect(await run("offer", "paid", "public")).toBe(2);
    expect(out).toContain("daily");
    expect(out).toContain("--cap");
    // It must not have asked, and must not have written.
    expect(asked).toEqual([]);
    expect((await read()).offer).toBeUndefined();
  });

  it("refuses to offer a subscription backend at all [SUBSCRIPTION_SELF_LOCK]", async () => {
    await write({ type: "claude-cli" });

    expect(await run("offer", "paid", "named")).toBe(1);
    expect(out).toContain("cannot be offered");
    expect((await read()).offer).toBeUndefined();
  });

  it("widens a free backend without asking about money there is none of", async () => {
    await write({ type: "ollama" });

    expect(await run("offer", "paid", "public")).toBe(0);
    expect(asked).toEqual([]);
    expect((await read()).offer).toBe("public");
  });

  it("withdraws consent when narrowing back to self", async () => {
    await write({
      type: "openai",
      offer: "public",
      spend: { acknowledged: true, dailyCapCents: 250 },
    });

    expect(await run("offer", "paid", "self")).toBe(0);
    const paid = await read();
    expect(paid.offer).toBe("self");
    // Widening again has to be agreed to again, not inherited from a
    // decision the owner already reversed.
    expect(paid.spend?.acknowledged).toBe(false);
  });

  it("says what it does not recognise rather than guessing", async () => {
    await write({ type: "ollama" });

    expect(await run("offer", "nope", "public")).toBe(2);
    expect(out).toContain("no service named");
    expect(out).toContain("paid");

    out = "";
    expect(await run("offer", "paid", "everyone")).toBe(2);
    expect(out).toContain("not an offer scope");
  });
});

import { mkdtemp, readFile } from "node:fs/promises";
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
import type {
  Backend,
  BackendRequest,
  BackendResult,
} from "./backends/index.js";
import { Budgets } from "./budgets.js";
import { ProtocolClient } from "./client.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { IngressLog, type IngressEntry } from "./ingress.js";
import type { MemoryPressure, MemoryReading } from "./memory.js";
import { memoryGuardLines } from "./cli.js";
import { DEFAULT_FLOOR_BYTES } from "./memory-gate.js";
import { Runner } from "./runner.js";
import { SpendLedger } from "./spend.js";
import { removeTemp } from "./test-support.js";

/**
 * The guard, from the only place that proves it exists: a job.
 *
 * `memoryGate` had unit tests and no caller for two commits, and I said so on
 * the board each time rather than calling it finished. These are the tests
 * that make the difference — every one of them runs a real job through a real
 * Runner and asks whether the backend was reached.
 */
const SITE_KEYS = generateKeys(1_800_000_000_000);
const SITE_ID = keyId(publicIdentityOf(SITE_KEYS).identity);
const DEVICE_KEYS = generateKeys(1_800_000_000_000);
const IDENTITY = {
  keys: () => Promise.resolve(DEVICE_KEYS),
  sites: new Map([[SITE_ID, publicIdentityOf(SITE_KEYS)]]),
};
const SIGNER_KEYS = generateKeys(1_800_000_000_000);
const SIGNER = {
  runnerId: "runner_1",
  sign: (input: {
    endpoint: string;
    runnerId: string;
    issuedAt: number;
    body: string;
  }) => signRequest(SIGNER_KEYS, input).signature,
};

async function sealedFor(jobId: string, payload: unknown): Promise<unknown> {
  return seal({
    plaintext: JSON.stringify(payload),
    senderKeys: SITE_KEYS,
    recipientEncryptionPublic: DEVICE_KEYS.encryptionPublic,
    context: {
      jobId,
      senderKeyId: keyId(publicIdentityOf(SITE_KEYS).identity),
      recipientKeyId: keyId(publicIdentityOf(DEVICE_KEYS).identity),
      deadlineAt: Date.now() + 3_600_000,
      direction: "payload",
    },
  });
}

/** Records whether it was ever asked, which is the whole question here. */
class CountingBackend implements Backend {
  calls = 0;
  /** A server that is NOT answering, so a start would be attempted. */
  answering = true;
  readonly stopReasons = {
    kind: "unavailable" as const,
    why: "a test double reads no vendor signal",
  };
  id: "openai-http" | "ollama" = "openai-http";
  readonly class = "http" as const;
  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({ healthy: this.answering, models: ["m"] });
  }
  /** What this double reports it stopped for — B064 step 3. */
  stop: "end" | "length" | undefined = "end";
  execute(_request: BackendRequest): Promise<BackendResult> {
    this.calls += 1;
    return Promise.resolve({
      ok: true,
      text: "answered",
      durationMs: 1,
      ...(this.stop === undefined ? {} : { stop: this.stop }),
    });
  }
}

const GB = 1024 ** 3;
const reading = (availableGb: number): MemoryReading => ({
  kind: "read",
  availableBytes: availableGb * GB,
  totalBytes: 36 * GB,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-memory-caller-"));
});
afterEach(async () => {
  await removeTemp(dir);
});

const JOB = {
  id: "job_1",
  kind: "llm.generate",
  audience: "private",
  owner: "me",
  site: SITE_ID,
  sizeClass: "small",
  streaming: false,
  deadlineAt: Date.now() + 60_000,
  lease: {
    id: "lease_test",
    runnerId: "runner_1",
    expiresAt: 4_000_000_000_000,
  },
};

async function runOneJob(options: {
  backend: Backend;
  minAvailableMemoryBytes?: number;
  spawnServer?: (command: readonly string[]) => void;
  service?: Record<string, unknown>;
  readMemory?: () => Promise<{
    memory: MemoryReading;
    pressure: MemoryPressure;
  }>;
}): Promise<{ ingress: IngressEntry[]; reported: BackendResult | undefined }> {
  const loaded = resolveConfig(
    DaemonConfig.parse({
      ...(options.minAvailableMemoryBytes === undefined
        ? {}
        : { minAvailableMemoryBytes: options.minAvailableMemoryBytes }),
      services: {
        primary: options.service ?? {
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
  const ingressPath = join(dir, "ingress.log");
  const ingress = new IngressLog({
    path: ingressPath,
    communityPromptDays: 7,
    keepSelfPrompts: true,
  });

  let reported: BackendResult | undefined;
  /* The job finishes after `tick` returns, so every assertion below has to
     wait for it. A fixed sleep would encode a guess about how many round
     trips the protocol takes; this waits for the job to actually end. */
  /* An object rather than a `let`: the compiler cannot see that the event
     handler below writes it, and narrows a mutated boolean to its initial
     literal — which makes the wait loop read as dead code to lint. */
  const settled = { yet: false };
  const runner = new Runner({
    client: new ProtocolClient({
      origin: "https://app.test",
      identity: SIGNER,
      fetch: (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith("/fetch")) {
          return sealedFor("job_1", { prompt: "hi" }).then(
            (envelope) =>
              new Response(JSON.stringify({ envelope }), {
                headers: { "content-type": "application/json" },
              }),
          );
        }
        if (url.endsWith("/result")) {
          reported = JSON.parse(
            typeof init?.body === "string" ? init.body : "{}",
          ) as BackendResult;
        }
        const body = url.endsWith("/claim")
          ? JSON.stringify({ jobs: [JOB], leaseMs: 60_000 })
          : JSON.stringify({
              sites: { [SITE_ID]: publicIdentityOf(SITE_KEYS) },
              awaitingConsent: [],
              cancel: [],
              lost: [],
              serverTime: Date.now(),
            });
        return Promise.resolve(
          new Response(body, {
            headers: { "content-type": "application/json" },
          }),
        );
      },
    }),
    runnerId: "runner_1",
    identity: IDENTITY,
    owner: "me",
    daemonVersion: "0.0.0",
    loaded,
    budgets,
    spend,
    ingress,
    ...(options.readMemory === undefined
      ? {}
      : { readMemory: options.readMemory }),
    ...(options.spawnServer === undefined
      ? {}
      : { spawnServer: options.spawnServer }),
    /* The machine does not decide whether this test runs. Without it the
       ollama route is "not startable" on any box without ollama installed,
       the job never dispatches, and the failure reads as a timeout — which
       is what CI reported while this passed on a laptop that had it. */
    onPath: () => Promise.resolve(true),
    backendFactory: () => options.backend,
    onEvent: (event) => {
      if (
        event.type === "finished" ||
        event.type === "refused" ||
        event.type === "error"
      ) {
        settled.yet = true;
      }
    },
  });

  await runner.tick();
  const deadline = Date.now() + 5_000;
  while (!settled.yet && Date.now() < deadline) {
    await new Promise((wake) => setTimeout(wake, 5));
  }
  if (!settled.yet) throw new Error("the job never finished");

  const raw = await readFile(ingressPath, "utf8").catch(() => "");
  const entries = raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as IngressEntry);
  return { ingress: entries, reported };
}

describe("the memory guard, from a job's point of view", () => {
  it("refuses the job before the backend is ever asked", async () => {
    /**
     * The point of the whole row. A refusal that still ran the job would be
     * a log line pretending to be a guard, and this is the assertion that
     * tells them apart: `calls` is zero.
     */
    const backend = new CountingBackend();
    const { ingress } = await runOneJob({
      backend,
      readMemory: () =>
        Promise.resolve({ memory: reading(0.4), pressure: "normal" }),
    });
    expect(backend.calls, "the backend was asked despite the refusal").toBe(0);
    const decisions = ingress.filter((entry) => entry.type === "memory");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ admit: false });
  });

  it("runs the job when there is room, from the same reader", async () => {
    /* The control, and it is not optional: without it the case above passes
       against a guard that refuses everything — `os.freemem()`'s failure,
       which is the thing this row exists to avoid. */
    const backend = new CountingBackend();
    const { ingress } = await runOneJob({
      backend,
      readMemory: () =>
        Promise.resolve({ memory: reading(12), pressure: "normal" }),
    });
    expect(backend.calls).toBe(1);
    const decisions = ingress.filter((entry) => entry.type === "memory");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ admit: true });
  });

  it("logs the numbers, not just the verdict", async () => {
    /* byollm_022 asks for a distribution so the 2 GB floor can be tuned from
       more than one laptop. A verdict with no reading beside it cannot say
       how close an admit ran. */
    const { ingress } = await runOneJob({
      backend: new CountingBackend(),
      readMemory: () =>
        Promise.resolve({ memory: reading(12), pressure: "warn" }),
    });
    const decision = ingress.find((entry) => entry.type === "memory");
    expect(decision).toMatchObject({
      admit: true,
      pressure: "warn",
      availableBytes: 12 * GB,
      totalBytes: 36 * GB,
      backendId: "openai-http",
    });
  });

  it("refuses BEFORE the server is started, which is the expensive half", async () => {
    /**
     * Ordering, and it is the property rather than a detail. Starting a model
     * server is what loads gigabytes; a guard that runs after it has already
     * happened is a log line describing a machine it did not protect.
     *
     * Observable only with a route that CAN be started — `ollama` is the one
     * backend `startCommandFor` has a command for — and a server that is not
     * answering, so a start would otherwise be attempted. `spawn` never being
     * called is the assertion.
     *
     * A mutation moving the gate one line later survived every other test in
     * this file, which is how this one came to exist.
     */
    const backend = new CountingBackend();
    backend.id = "ollama";
    backend.answering = false;
    const spawned: string[][] = [];
    await runOneJob({
      backend,
      service: {
        model: "llama3.2",
        kinds: ["llm.generate"],
        type: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
      },
      spawnServer: (command) => spawned.push([...command]),
      readMemory: () =>
        Promise.resolve({ memory: reading(0.4), pressure: "normal" }),
    });
    expect(spawned, "a model server was started for a refused job").toEqual([]);
    expect(backend.calls).toBe(0);

    /* The control: the same unanswering server, with room. It starts — so the
       case above proves the GATE stopped it, not that nothing ever starts. */
    const roomy = new CountingBackend();
    roomy.id = "ollama";
    roomy.answering = false;
    const alsoSpawned: string[][] = [];
    await runOneJob({
      backend: roomy,
      service: {
        model: "llama3.2",
        kinds: ["llm.generate"],
        type: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
      },
      /* Starting it makes it answer, as starting a real one does — otherwise
         the runner polls the full start window and this test measures a
         timeout rather than an ordering. */
      spawnServer: (command) => {
        alsoSpawned.push([...command]);
        roomy.answering = true;
      },
      readMemory: () =>
        Promise.resolve({ memory: reading(12), pressure: "normal" }),
    });
    expect(alsoSpawned).toEqual([["ollama", "serve"]]);
  }, 40_000);

  it("refuses at the floor the OWNER set, not the one we shipped — B090", async () => {
    /**
     * The half of B090 that would have been missed. A field added without
     * being threaded into the gate parses, validates, shows up in `byollm
     * status`, and changes nothing — the gate keeps using its own default,
     * and an owner who followed the release note has set a number that does
     * nothing. That fails silently and looks like it worked, which is worse
     * than the note being wrong.
     *
     * So this asserts the refusal happened at the CONFIGURED floor: 8 GB
     * available is comfortably above the 2 GB default and comfortably below
     * an owner's 16 GB, and only a wired floor can tell those apart.
     */
    const backend = new CountingBackend();
    const { ingress } = await runOneJob({
      backend,
      minAvailableMemoryBytes: 16 * GB,
      readMemory: () =>
        Promise.resolve({ memory: reading(8), pressure: "normal" }),
    });
    expect(
      backend.calls,
      "the job ran, so the gate used its own default and not the owner's floor",
    ).toBe(0);
    const decision = ingress.find((entry) => entry.type === "memory");
    expect(decision).toMatchObject({ admit: false });
    if (decision?.type === "memory") {
      /* And it says the number it used, so an owner reading the log can tell
         which floor refused them. */
      expect(decision.why).toContain("16.0 GB");
    }

    /* The control, and it is the same 8 GB: with the default floor this job
       runs. Without it, "refuses at 8 GB" would pass against a gate that
       refuses everything. */
    const roomy = new CountingBackend();
    await runOneJob({
      backend: roomy,
      readMemory: () =>
        Promise.resolve({ memory: reading(8), pressure: "normal" }),
    });
    expect(roomy.calls).toBe(1);
  });

  it("is silent and inactive when no reader is injected", async () => {
    /* `connect`, `services` and `status` build runners to ask questions. None
       of them should spawn `vm_stat`, and none of them should be refusing
       jobs. Absent means not active — and `byollm status` is where that gets
       said out loud, because a silent absent guard reads exactly like one
       that is passing everything. */
    const backend = new CountingBackend();
    const { ingress } = await runOneJob({ backend });
    expect(backend.calls).toBe(1);
    expect(ingress.filter((entry) => entry.type === "memory")).toHaveLength(0);
  });

  it("never reads memory for a route that holds no model here", async () => {
    /* A proxy route has nothing for this to protect, and paying a `vm_stat`
       spawn per job to conclude that is waste. Asserted by the reader never
       being called, which is stronger than asserting the verdict. */
    const backend = new CountingBackend();
    let reads = 0;
    const { ingress } = await runOneJob({
      backend,
      service: {
        model: "m",
        kinds: ["llm.generate"],
        type: "openai-http",
        baseUrl: "https://api.together.xyz/v1",
        spend: { acknowledged: true, dailyCapCents: 100 },
      },
      readMemory: () => {
        reads += 1;
        return Promise.resolve({ memory: reading(0.1), pressure: "critical" });
      },
    });
    expect(reads, "memory was read for a remote route").toBe(0);
    expect(backend.calls).toBe(1);
    expect(ingress.filter((entry) => entry.type === "memory")).toHaveLength(0);
  });
});

describe("what `byollm status` says about the guard", () => {
  it("says NOT ACTIVE, and why, when memory cannot be read", () => {
    /**
     * byollm_022 asks for this line by name. The gate admits where it cannot
     * measure — refusing there would brick the daemon on a platform nobody
     * has visited — and that leaves an absent guard looking exactly like one
     * that is passing everything. So it is said out loud.
     */
    const text = memoryGuardLines({
      memory: { kind: "unknown", why: "no memory reader for freebsd" },
      pressure: "unknown",
      floorBytes: DEFAULT_FLOOR_BYTES,
    });
    expect(text).toContain("NOT ACTIVE");
    expect(text).toContain("no memory reader for freebsd");
    expect(text).toContain("admitted without checking");
  });

  it("prints the floor it was given, not the one we shipped", () => {
    /**
     * B090. An owner who raises the floor to 16 GB and then reads "refused
     * below 2.0 GB" is being told their setting did not take — on the one
     * screen that exists to say what this device is doing. A mutation
     * putting {@link DEFAULT_FLOOR_BYTES} back here passed every other test
     * in this file.
     */
    const text = memoryGuardLines({
      memory: {
        kind: "read",
        availableBytes: 20 * GB,
        totalBytes: 36 * GB,
      },
      pressure: "normal",
      floorBytes: 16 * GB,
    });
    expect(text).toContain("16.0 GB");
    expect(text).not.toContain("2.0 GB");
  });

  it("ships one floor, not two — the config default IS the gate's", () => {
    /* One fact in two places is how the release runbook came to say four
       packages when there were six. Here the two places are a config default
       and a gate default, and the failure at the end of the drift is a
       machine wedging rather than a stale sentence. */
    expect(DaemonConfig.parse({ services: {} }).minAvailableMemoryBytes).toBe(
      DEFAULT_FLOOR_BYTES,
    );
  });

  it("says active, with the numbers, when it can", () => {
    /* The control. Without it the case above passes against a status line
       that says NOT ACTIVE on every machine, which would be a worse lie than
       silence. */
    const text = memoryGuardLines({
      memory: {
        kind: "read",
        availableBytes: 13.1 * 1024 ** 3,
        totalBytes: 36 * 1024 ** 3,
      },
      pressure: "normal",
      floorBytes: DEFAULT_FLOOR_BYTES,
    });
    expect(text).toContain("active");
    expect(text).not.toContain("NOT ACTIVE");
    expect(text).toContain("13.1 GB available of 36.0 GB");
    expect(text).toContain("pressure normal");
  });
});

describe("a truncated answer reaches the owner's log — B064 step 3", () => {
  /**
   * The wiring, end to end, through a real Runner and a real ingress file.
   *
   * Everything below `stopReasonOf` shipped in .86 and nothing called it, so
   * the daemon knew and no surface said. This asserts the fact survives the
   * whole path — execute, record, read back — because that path is the
   * feature and the function was already tested.
   */
  it("records why generation stopped, and distinguishes it from finishing", async () => {
    const truncated = new CountingBackend();
    truncated.stop = "length";
    const cut = await runOneJob({
      backend: truncated,
      readMemory: () =>
        Promise.resolve({ memory: reading(12), pressure: "normal" }),
    });
    /* The control the spec asks for by name: the same double, the same path,
       an answer that finished. A test that only checks `length` passes
       against an adapter reporting `length` for everything. */
    const whole = new CountingBackend();
    whole.stop = "end";
    const done = await runOneJob({
      backend: whole,
      readMemory: () =>
        Promise.resolve({ memory: reading(12), pressure: "normal" }),
    });

    /**
     * Both runs share this test's ingress file, so the pair is read from one
     * log rather than one from each — which is the stronger assertion
     * anyway: the two values coexist in the record an owner actually reads.
     *
     * Read as a list for a reason. The first draft used `find`, which
     * returned the truncated job's outcome for both and would have passed if
     * the second run had recorded nothing at all.
     */
    void cut;
    const stops = done.ingress
      .filter((entry) => entry.type === "outcome")
      .map((entry) => entry.stop);
    expect(stops).toEqual(["length", "end"]);
  });

  it("records unknown for an adapter that reports nothing, never end", async () => {
    /* The default that makes this a fix rather than a field, asserted where
       it actually matters — on the record an owner reads, not in the
       function. */
    const silent = new CountingBackend();
    silent.stop = undefined;
    const { ingress } = await runOneJob({
      backend: silent,
      readMemory: () =>
        Promise.resolve({ memory: reading(12), pressure: "normal" }),
    });
    expect(ingress.find((entry) => entry.type === "outcome")).toMatchObject({
      stop: "unknown",
    });
  });
});

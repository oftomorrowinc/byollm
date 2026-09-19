import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SealedOutcome,
  generateKeys,
  keyId,
  open,
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

/**
 * A backend that reports where its time went — the process class, B304.
 *
 * `process-backend.ts` attaches `timing: { spawnMs, firstOutputMs }` to every
 * result it resolves, and nothing else does. That single difference is why
 * Todd's claude-cli jobs completed on two devices in 4–9 seconds and never
 * appeared on the page while qwen over `openai-http` did: the timing keys rode
 * into the sealed `ran`, `RunMetadata` is `.strict()` and has never had them,
 * so the site's `openSealedOutcome` returned null and the caller dropped the
 * result without a word.
 *
 * A double rather than a real spawn, because what is under test is the SEAL,
 * not a child process — and this double's job is to produce the one field
 * shape the real one produces.
 */
class TimingBackend implements Backend {
  calls = 0;
  answering = true;
  readonly stopReasons = {
    kind: "unavailable" as const,
    why: "a test double reads no vendor signal",
  };
  /* The id stays the one the harness's config names; what matters here is the
     CLASS and the timing, which is what `process-backend.ts` contributes. */
  id: "openai-http" | "ollama" = "openai-http";
  readonly class = "process" as const;
  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({ healthy: this.answering, models: ["m"] });
  }
  execute(_request: BackendRequest): Promise<BackendResult> {
    this.calls += 1;
    return Promise.resolve({
      ok: true,
      text: "answered",
      durationMs: 1,
      stop: "end",
      /* The one line that reproduces B304. */
      timing: { spawnMs: 12, firstOutputMs: 340 },
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
}): Promise<{
  ingress: IngressEntry[];
  reported: BackendResult | undefined;
  /* What the daemon sealed, opened as the site would — B064 step 4. */
  sealed: { ran?: Record<string, unknown> } | undefined;
  /* The same bytes, unparsed, so a case can ask the PROTOCOL rather than ask
     for the fields it already expects — B304. */
  sealedRaw: unknown;
  /* Every event the owner's daemon emitted. */
  events: { type: string }[];
}> {
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
  let sealedBody: { envelope?: unknown } | undefined;
  /* What the OWNER was told, as distinct from what travelled — B304. The two
     carry deliberately different things and the whole finding is that one of
     them had been carrying the other's. */
  const events: { type: string }[] = [];
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
          /* The sealed envelope, kept so a test can open it the way the site
             does — B064 step 4. Reading `ran` off the daemon's own inputs
             would prove nothing about what actually travelled. */
          sealedBody = JSON.parse(
            typeof init?.body === "string" ? init.body : "{}",
          ) as { envelope?: unknown };
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
      events.push(event);
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
  /**
   * Open what the daemon sealed, as the site would — B064 step 4.
   *
   * The envelope is sealed to the site's encryption key and signed by the
   * device, so this is the same operation `handlers.ts` performs, with the
   * same keys. Anything less is a test of the daemon's local variables.
   */
  /**
   * Typed structurally, and **also handed back unparsed** — B304.
   *
   * The original note said this is *"a test reading a decrypted blob, and the
   * assertions below name the fields they care about"*, which was true and was
   * the hole: this harness opens the exact bytes the site parses, declined to
   * parse them as `SealedOutcome`, and so watched a payload the protocol
   * refuses go past for months. Naming the fields you care about cannot catch
   * a field you do not know is there — that is what `.strict()` is for, and it
   * was never asked.
   */
  let sealed: { ran?: Record<string, unknown> } | undefined;
  let sealedRaw: unknown;
  if (sealedBody?.envelope !== undefined) {
    const opened = await open({
      envelope: sealedBody.envelope as never,
      recipientKeys: SITE_KEYS,
      senderIdentityPublic: publicIdentityOf(DEVICE_KEYS).identity,
      expected: {
        jobId: "job_1",
        senderKeyId: keyId(publicIdentityOf(DEVICE_KEYS).identity),
        recipientKeyId: keyId(publicIdentityOf(SITE_KEYS).identity),
        direction: "result",
      },
    });
    if (opened.ok) {
      sealedRaw = JSON.parse(opened.plaintext);
      sealed = sealedRaw as {
        ran?: Record<string, unknown>;
      };
    }
  }

  return { ingress: entries, reported, sealed, sealedRaw, events };
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

  it("starts Ollama for a `:cloud` model, and never reads memory to do it", async () => {
    /**
     * Todd's exercise, 09-10 — B116's sharp case, run rather than reasoned
     * about.
     *
     * An `ollama:cloud` model is served by an Ollama daemon on loopback: the
     * transport is local, the compute is not. So both halves have to hold at
     * once and they pull opposite ways at first glance:
     *
     * - **It starts.** `type: "ollama"` is startable, and starting a stopped
     *   Ollama is exactly what `.88` proved works in the field. This is the
     *   capability B116 protects — an `openai-http` spelling of the same
     *   service is the one shape that could not be started.
     * - **The memory gate skips it, and that is correct rather than a hole.**
     *   Starting Ollama for a hosted model loads nothing locally, so there is
     *   no gigabyte to guard against. `guardApplies` asks `resolveCost`, and
     *   B097 reads the `:cloud` tag before the declared cost, so the answer is
     *   `metered` and the gate stands down.
     *
     * Memory is set critically low so a gate that DID apply would refuse —
     * which makes "it started anyway" a statement about the guard rather than
     * about a machine that happened to have room.
     */
    const backend = new CountingBackend();
    backend.id = "ollama";
    backend.answering = false;
    let reads = 0;
    const spawned: string[][] = [];
    const { ingress } = await runOneJob({
      backend,
      service: {
        model: "glm-5.2:cloud",
        kinds: ["llm.generate"],
        type: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        spend: { acknowledged: true, dailyCapCents: 2500 },
      },
      spawnServer: (command) => {
        spawned.push([...command]);
        backend.answering = true;
      },
      readMemory: () => {
        reads += 1;
        return Promise.resolve({ memory: reading(0.1), pressure: "critical" });
      },
    });
    expect(spawned, "a hosted Ollama model did not start its server").toEqual([
      ["ollama", "serve"],
    ]);
    expect(reads, "memory was read for a model that loads nothing here").toBe(
      0,
    );
    expect(backend.calls).toBe(1);
    expect(ingress.filter((entry) => entry.type === "memory")).toHaveLength(0);
  }, 40_000);

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
    const outcomes = done.ingress.filter((entry) => entry.type === "outcome");
    expect(outcomes.map((entry) => entry.stop)).toEqual(["length", "end"]);

    /**
     * And the adapter's declaration travels with it — B105.
     *
     * Without this the runner can stop recording `stopKind` and every other
     * test stays green, because the sentence that needs it is chosen in
     * `byollm log` rather than here. `unknown` from an adapter that CANNOT
     * report and `unknown` from one whose answer we did not recognise are
     * different facts, and this is the only place the distinction is
     * captured.
     */
    expect(
      outcomes.map((entry) => entry.stopKind),
      "the mapping kind was not recorded, so the log cannot tell the two unknowns apart",
    ).toEqual(["unavailable", "unavailable"]);
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

describe("what the site is told about how a job ran — B064 step 4", () => {
  /**
   * The sealed half. Step 3 put the reason in the owner's log; this is the
   * only thing a site developer on another machine can see.
   *
   * Read out of the envelope the daemon actually sealed, rather than off the
   * value passed in — the point of the row is that the fact survives the trip
   * through `RunMetadata`, and asserting the input would prove nothing about
   * the output.
   */
  const sealedRan = async (options: {
    stop: "end" | "length" | undefined;
  }): Promise<Record<string, unknown>> => {
    const backend = new CountingBackend();
    backend.stop = options.stop;
    const { sealed } = await runOneJob({
      backend,
      readMemory: () =>
        Promise.resolve({ memory: reading(12), pressure: "normal" }),
    });
    return sealed?.ran ?? {};
  };

  it("carries the stop reason, and whether the adapter could report one", async () => {
    /**
     * Two fields, because `unknown` is two facts. A site told only `unknown`
     * would say "we do not know why this stopped" for a `claude-cli` job
     * forever — true — and for a `content_filter` result, which is not the
     * same thing. That is the defect B064's third mapping kind exists to
     * prevent, and putting a bare `stop` on the wire would re-commit it.
     */
    expect(await sealedRan({ stop: "length" })).toMatchObject({
      stop: "length",
      stopReported: false,
    });

    /* The pair, from the same double: a finished answer is a different value
       and not an absent one. */
    expect(await sealedRan({ stop: "end" })).toMatchObject({ stop: "end" });
  });

  it("reports the measured duration, which used to be the literal zero", async () => {
    /**
     * `RunMetadata.durationMs` is documented as "wall-clock milliseconds the
     * backend call took" and was written as `0` at the seal on every result
     * any site has ever received — the real figure went to the local log and
     * the event and stopped there.
     *
     * Asserted as a property of the shape rather than a number: the double
     * reports 1ms, so this checks the value travelled rather than that a
     * particular clock ran.
     */
    const ran = await sealedRan({ stop: "end" });
    expect(ran["durationMs"], "the sealed duration is still hardcoded").toBe(1);
  });
});

describe("what the daemon seals is what the protocol accepts — B304", () => {
  /**
   * A claude-cli result completed on two of Todd's devices in 4–9 seconds and
   * never appeared on the test site; a qwen result over `openai-http` did.
   * Not the lease (these are seconds), not the hub (both images), not the
   * device (both finished).
   *
   * `process-backend.ts` attaches `timing: { spawnMs, firstOutputMs }` to
   * every result it resolves, and nothing else does. B195 spread
   * `result.timing` into the sealed `ran` beside the two local events.
   * `RunMetadata` is `.strict()` and has never had those keys — so the site's
   * `openSealedOutcome` returned null, the caller dropped the result, and the
   * page said "still going" until the person gave up. Silent on both sides.
   *
   * The harness above has opened these exact bytes since B064 and never
   * parsed them, because its assertions *"name the fields they care about"*.
   * A field nobody knows is there is the one case naming fields cannot cover.
   */
  it("parses, for a backend that reports where its time went", async () => {
    const { sealedRaw } = await runOneJob({ backend: new TimingBackend() });
    const parsed = SealedOutcome.safeParse(sealedRaw);
    expect(
      parsed.success,
      parsed.success
        ? ""
        : "the site refuses this and says nothing: " +
            JSON.stringify(parsed.error.issues.map((i) => i.path.join("."))),
    ).toBe(true);
  });

  it("sealed something at all, or the case above passes on nothing", async () => {
    /* `safeParse(undefined)` fails, so this direction is safe — but a harness
       that stopped sealing would turn the case above into a permanent red for
       the wrong reason, and a reader would chase the protocol. */
    const { sealedRaw } = await runOneJob({ backend: new TimingBackend() });
    expect(sealedRaw).toBeTypeOf("object");
  });

  it("keeps the timing for the owner, who is the one it is about", async () => {
    /**
     * Removed from the seal, not from the daemon. `spawnMs` and
     * `firstOutputMs` say where the time went on somebody's own machine —
     * which is what `byollm status` answers and what a site is neither owed
     * nor able to use. A fix that deleted the measurement would have traded
     * one defect for the loss of B195.
     */
    const { events } = await runOneJob({ backend: new TimingBackend() });
    const finished = events.find((e) => e.type === "finished");
    expect(finished, "the job never reported finishing").toBeDefined();
    expect(finished).toMatchObject({ spawnMs: 12, firstOutputMs: 340 });
  });

  it("keeps the split in the owner's own log too", async () => {
    /**
     * Two local homes, and both are the owner's: the `finished` event and the
     * ingress record. A fix that removed the seal's copy by deleting the
     * measurement would have passed the case above while quietly undoing
     * B195 — the first mutation run against this file did exactly that, and
     * removed the ingress spread, which nothing was watching.
     */
    const { ingress } = await runOneJob({ backend: new TimingBackend() });
    const outcome = ingress.find((entry) => "outputChars" in entry);
    expect(outcome, "no outcome was recorded").toBeDefined();
    expect(outcome).toMatchObject({ spawnMs: 12, firstOutputMs: 340 });
  });

  it("asks the protocol before sealing, rather than asserting a type", () => {
    /**
     * **A source assertion, and it is the honest shape here.** With the timing
     * gone from `ran`, the runtime cannot produce an invalid seal any more, so
     * removing this belt breaks no behaviour and survives every mutation of
     * the running code. What it guards is the NEXT field somebody spreads in.
     *
     * `satisfies SealedOutcome` was what stood here, and it is why B304 lasted
     * months: TypeScript excess-property-checks a fresh literal, and `ran`
     * arrives as a variable from another method whose return type is inferred.
     * The annotation read like a guarantee and the compiler never looked.
     *
     * `.parse` throws, and that is the trade: a job that fails loudly on the
     * owner's machine beats one that succeeds there and hangs forever on
     * somebody else's page.
     */
    const runner = readFileSync(
      new URL("./runner.ts", import.meta.url),
      "utf8",
    );
    expect(runner).toContain("SealedOutcome.parse({ outcome, ran })");
    expect(
      runner.includes("{ outcome, ran } satisfies SealedOutcome"),
      "the seal is back to a type assertion that cannot see a variable's " +
        "extra keys",
    ).toBe(false);
  });

  it("does not carry the owner's split on the wire", async () => {
    /* The other direction, asserted by absence: `.strict()` would catch it,
       and this says which keys and why, so the next reader of a red knows it
       is about audience rather than about typos. */
    const { sealed } = await runOneJob({ backend: new TimingBackend() });
    expect(Object.keys(sealed?.ran ?? {})).not.toContain("spawnMs");
    expect(Object.keys(sealed?.ran ?? {})).not.toContain("firstOutputMs");
  });
});

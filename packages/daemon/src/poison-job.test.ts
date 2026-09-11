import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import { IngressLog } from "./ingress.js";
import { Runner } from "./runner.js";
import { SpendLedger } from "./spend.js";
import { removeTemp } from "./test-support.js";

/**
 * The backstop that does not have to be clever — B041.
 *
 * A daemon that never reports a result lets the lease lapse, and the hub
 * offers the job again, and this device takes it again. Forever. There is
 * already a counter for one cause of that — a payload that never arrives —
 * and it is the right fix for that cause and scoped to it.
 *
 * These are about every other cause. The failure used below is chosen for
 * having NO remedy of its own: the payload seals and opens fine, and the
 * ingress write then throws, which is the "disk is full" case the claim
 * loop's own `catch` was written for. Nothing classifies it, nothing counts
 * it, and before this row it looped.
 */
const SITE_KEYS = generateKeys(1_800_000_000_000);
const SITE_ID = keyId(publicIdentityOf(SITE_KEYS).identity);
const DEVICE_KEYS = generateKeys(1_800_000_000_000);
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

async function sealedFor(jobId: string): Promise<unknown> {
  return seal({
    plaintext: JSON.stringify({ prompt: "hi" }),
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

class OkBackend implements Backend {
  readonly stopReasons = {
    kind: "unavailable" as const,
    why: "a test double reads no vendor signal",
  };
  readonly id = "openai-http" as const;
  readonly class = "http" as const;
  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({ healthy: true, models: ["m"] });
  }
  execute(_request: BackendRequest): Promise<BackendResult> {
    return Promise.resolve({
      ok: true,
      text: "answered",
      durationMs: 1,
      stop: "end" as const,
    });
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-poison-"));
});
afterEach(async () => {
  await removeTemp(dir);
});

const job = (id: string) => ({
  id,
  kind: "llm.generate",
  audience: "private",
  owner: "me",
  site: SITE_ID,
  sizeClass: "small",
  streaming: false,
  deadlineAt: Date.now() + 60_000,
  lease: {
    id: `lease_${id}`,
    runnerId: "runner_1",
    expiresAt: 4_000_000_000_000,
  },
});

/**
 * A daemon whose ingress write fails, which is a failure with no remedy of
 * its own — and a clock the test controls, because the backoff between
 * attempts is measured in half-minutes and nobody should wait for it.
 */
async function makeRunner(options: { failIngress?: boolean } = {}) {
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

  const ingress = new IngressLog({
    path: join(dir, "ingress.log"),
    communityPromptDays: 7,
    keepSelfPrompts: true,
  });
  if (options.failIngress === true) {
    /* The disk-is-full shape. It throws out of the job handler, the claim
       loop catches it so the daemon survives, no result is reported, and the
       lease lapses — which is the loop. */
    ingress.recordPrompt = () =>
      Promise.reject(new Error("no space left on device"));
  }

  const released: { jobId: string; reason: string }[] = [];
  const refusals: string[] = [];
  let clock = 1_800_000_000_000;
  /* An object rather than a `let`: the compiler cannot see that the event
     handler writes it, and narrows a mutated boolean to its initial literal. */
  const settled: { yet: boolean } = { yet: false };
  const reset = () => {
    settled.yet = false;
  };
  const runner = new Runner({
    client: new ProtocolClient({
      origin: "https://app.test",
      identity: SIGNER,
      fetch: (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith("/fetch")) {
          return sealedFor("job_1").then(
            (envelope) =>
              new Response(JSON.stringify({ envelope }), {
                headers: { "content-type": "application/json" },
              }),
          );
        }
        if (url.endsWith("/release")) {
          const body = JSON.parse(
            typeof init?.body === "string" ? init.body : "{}",
          ) as { leases: { jobId: string }[]; reason: string };
          for (const lease of body.leases) {
            released.push({ jobId: lease.jobId, reason: body.reason });
          }
        }
        const body = url.endsWith("/claim")
          ? JSON.stringify({ jobs: [job("job_1")], leaseMs: 60_000 })
          : JSON.stringify({
              sites: { [SITE_ID]: publicIdentityOf(SITE_KEYS) },
              awaitingConsent: [],
              cancel: [],
              lost: [],
              serverTime: clock,
            });
        return Promise.resolve(
          new Response(body, {
            headers: { "content-type": "application/json" },
          }),
        );
      },
    }),
    runnerId: "runner_1",
    identity: {
      keys: () => Promise.resolve(DEVICE_KEYS),
      sites: new Map([[SITE_ID, publicIdentityOf(SITE_KEYS)]]),
    },
    owner: "me",
    daemonVersion: "0.0.0",
    loaded,
    budgets,
    spend,
    ingress,
    now: () => clock,
    onEvent: (event) => {
      if (event.type === "refused") refusals.push(event.reason);
      /* Any way a claimed job can end. `cycle` waits for one of these rather
         than for a duration — see its note. */
      if (
        event.type === "finished" ||
        event.type === "refused" ||
        event.type === "error"
      ) {
        settled.yet = true;
      }
    },
    backendFactory: () => new OkBackend(),
  });

  /** One claim-and-handle cycle, settled. */
  /**
   * One claim-and-handle cycle, waited out by its RESULT rather than by a
   * clock.
   *
   * This slept 30ms and passed everywhere until it did not: `is refused after
   * three attempts` went red on ubuntu with nothing changed but an unrelated
   * file. A job is claimed, fetched, opened and recorded before it ends, and
   * a fixed sleep encodes a guess about how many of those hops fit in the
   * number — which `failures.test.ts` already wrote down in as many words:
   * *"Wait for a condition rather than for a duration."*
   *
   * The condition is any terminal event. A cycle that produces none times out
   * loudly instead of quietly asserting against a job still in flight, which
   * is what made the original failure read as a breaker that had not fired.
   */
  const cycle = async (expect: "terminal" | "quiet" = "terminal") => {
    /* Reset through a helper, so the compiler does not narrow the flag to the
       literal it was just assigned and then call the wait below dead. */
    reset();
    await runner.tick();
    if (expect === "quiet") {
      /**
       * A job inside its backoff is DELIBERATELY silent — not worked, not
       * released, no event — so there is no positive condition to wait for.
       *
       * Waiting a bounded moment is the only way to conclude that nothing
       * happened, and that is the one case where a duration is the honest
       * instrument rather than a guess. The assertion it serves is an
       * absence.
       */
      await new Promise((wake) => setTimeout(wake, 50));
      return;
    }
    const deadline = Date.now() + 5_000;
    while (!settled.yet && Date.now() < deadline) {
      await new Promise((wake) => setTimeout(wake, 5));
    }
    if (!settled.yet) throw new Error("the job never reached an end");
  };
  /** Move past the backoff, the way a lapsed lease does. */
  const advance = (ms: number) => {
    clock += ms;
  };
  return { runner, cycle, advance, released, refusals };
}

describe("a job this device keeps starting and never finishing", () => {
  it("is refused after three attempts, whatever the reason was", async () => {
    /**
     * The whole row in one case. Nothing here classifies the failure — the
     * breaker counts starts and stops caring why, because a classifier that
     * has to be right about every failure mode will be wrong about the next
     * one, and the next one is the one that loops.
     */
    const { cycle, advance, released, refusals } = await makeRunner({
      failIngress: true,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await cycle();
      advance(60_000); // a lease lapses; the hub offers it again
    }
    expect(
      released.filter((entry) => entry.reason === "refused"),
      "still taking it after three attempts",
    ).toHaveLength(0);

    await cycle();
    expect(released.filter((entry) => entry.reason === "refused")).toHaveLength(
      1,
    );
    expect(refusals[0]).toContain("without finishing");
  });

  it("gives the concurrency slot back when the ingress write throws", async () => {
    /**
     * B021 — and it is a leaked SLOT, not a leaked object.
     *
     * `#active.set` ran before the `try` whose `finally` releases it, with two
     * awaited writes in between: `recordPrompt` and `budgets.record`. A throw
     * there — a full disk, a permission change, a corrupt ledger — left the
     * entry in `#active` permanently.
     *
     * `free = concurrency - #active.size`, so at the default of 2 **two such
     * failures make the daemon claim nothing again, for ever** — while
     * `activeJobs: 2` and the status screen both report work in progress.
     * The device goes quiet and every surface says it is busy, which is the
     * worst pairing available: silent to the network, healthy on the console.
     *
     * The harness's own note calls this "the disk-is-full shape", so the
     * failure was already modelled here; what nothing looked at was the
     * bookkeeping it left behind.
     */
    const { runner, cycle, advance } = await makeRunner({ failIngress: true });

    /* Same rhythm as the case above: a cycle, then the lease lapses so the
       hub offers the job again. Without the advance the second claim has
       nothing to hand back and the cycle waits for a terminal event that is
       not coming. */
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await cycle();
      advance(60_000);
    }

    /* Read off the same surface an operator would: `status` is what somebody
       runs when a device has gone quiet, and it is the number that would have
       lied. */
    expect(
      runner.status().activeJobs,
      "the runner still believes it is working on jobs whose ingress write " +
        "threw — those slots never come back",
    ).toBe(0);
  });

  it("takes the slot and enters the try with nothing awaited between", () => {
    /**
     * The same property as the case above, stated where it lives — because
     * the behavioural one cannot say WHY it passes.
     *
     * What releases the slot is a `finally`, and what decides whether it runs
     * is the position of one `try`. A future edit that adds a second awaited
     * write above it — another ledger, a metric, an audit line — reintroduces
     * the leak exactly, and the case above would go on passing as long as the
     * write it happens to model stays inside.
     *
     * So this reads the source: between taking the slot and entering the try
     * there must be **no `await` at all.** Same precedent as B159's ordering
     * assertion and `spawnServer`'s guard — where the property is the ORDER of
     * two statements, reading them is the check.
     */
    const runner = readFileSync(
      fileURLToPath(new URL("./runner.ts", import.meta.url)),
      "utf8",
    );
    const took = runner.indexOf("this.#active.set(job.lease.id");
    expect(took, "the slot is no longer taken here").toBeGreaterThan(-1);

    const entered = runner.indexOf("try {", took);
    expect(entered, "no try follows the slot being taken").toBeGreaterThan(-1);

    const between = runner.slice(took, entered);
    expect(
      between.includes("await "),
      "an awaited call sits between taking the concurrency slot and the try " +
        "whose finally gives it back — if it throws, that slot never returns",
    ).toBe(false);
  });

  it("does not refuse a job that finishes, however often it comes back", async () => {
    /**
     * The control, and the one that matters most: a breaker that trips on
     * healthy work is worse than no breaker. Same job id, four cycles, every
     * one of them completing — and it must never be refused.
     */
    const { cycle, advance, released } = await makeRunner();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await cycle();
      advance(60_000);
    }
    expect(
      released.filter((entry) => entry.reason === "refused"),
      "a job that keeps succeeding was called poison",
    ).toHaveLength(0);
  });

  it("spaces the attempts, so three chances are not spent at once", async () => {
    /**
     * Without spacing the breaker is a stutter: three claims in the same
     * second, refused before a slow site or a restarting backend could
     * recover. A job arriving inside its own backoff is not worked and not
     * counted, so it does not burn one of its own chances.
     */
    const { cycle, released } = await makeRunner({ failIngress: true });
    /* `quiet`, because a throttled cycle produces no terminal event by
       design — see `cycle`'s note. */
    for (let attempt = 0; attempt < 6; attempt += 1) await cycle("quiet");
    expect(
      released.filter((entry) => entry.reason === "refused"),
      "six rapid claims spent the whole allowance",
    ).toHaveLength(0);
  });

  it("forgets a job id it has not seen for a while", async () => {
    /* A map nobody prunes is the leak this project has already fixed once,
       and a job id remembered forever is a device that refuses work it has
       no live reason to refuse. */
    const { cycle, advance, released } = await makeRunner({
      failIngress: true,
    });
    /**
     * Four cycles, not three, and that is the point of the number.
     *
     * Three attempts never trip the breaker whether the TTL prunes or not,
     * so a three-cycle version of this test passed against a TTL of
     * `MAX_SAFE_INTEGER` — it was asserting something both branches do. The
     * fourth is the first cycle where a device that never forgets refuses,
     * and a device that forgets does not.
     */
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await cycle();
      advance(11 * 60_000); // past the TTL, so each cycle starts fresh
    }
    expect(
      released.filter((entry) => entry.reason === "refused"),
      "attempts survived their own TTL",
    ).toHaveLength(0);
  });
});

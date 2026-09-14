import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
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
 * A device that has stopped taking work says so — B196.
 *
 * Todd, with only `box-1` online: *"after a number of minutes the byollm status
 * hasn't changed. Still shows 10 prompts, 10 ok, 0 failed, 0 refused."* Two
 * more jobs were submitted; the counters did not move and the site said "Still
 * going".
 *
 * **A frozen ingress counter is not a slow job.** `recordPrompt` is awaited
 * *before* the backend call, so a claimed job writes a `prompt` entry whatever
 * happens next. Nothing moved because nothing was claimed.
 *
 * `#poll` had exactly one uncovered way to return without claiming —
 * `free <= 0` — and it was **a bare `return`**: no claim call, no log line, no
 * event, no error. A device that had stopped taking work was indistinguishable
 * from one with nothing to do: paired, heartbeating, `online` on Your Devices.
 *
 * It matters more than an idle log line because the slot leak B021 fixed ships
 * in `.89` and boxes install `latest`, which is `.88`. **At the default
 * `concurrency: 2`, two failed ingress writes silence a device permanently**,
 * and this line is the only thing that would say so.
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

const NOW = Date.now();

async function sealedFor(jobId: string): Promise<unknown> {
  return seal({
    plaintext: JSON.stringify({ prompt: "hi" }),
    senderKeys: SITE_KEYS,
    recipientEncryptionPublic: DEVICE_KEYS.encryptionPublic,
    context: {
      jobId,
      senderKeyId: keyId(publicIdentityOf(SITE_KEYS).identity),
      recipientKeyId: keyId(publicIdentityOf(DEVICE_KEYS).identity),
      deadlineAt: NOW + 3_600_000,
      direction: "payload",
    },
  });
}

/** A backend that holds its slot until the test lets go. */
class HangingBackend implements Backend {
  readonly stopReasons = {
    kind: "unavailable" as const,
    why: "a test double reads no vendor signal",
  };
  readonly id = "openai-http" as const;
  readonly class = "http" as const;
  static release: (() => void) | undefined;
  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({ healthy: true, models: ["m"] });
  }
  execute(_request: BackendRequest): Promise<BackendResult> {
    return new Promise<BackendResult>((resolve) => {
      HangingBackend.release = () => {
        resolve({ ok: true, text: "answered", durationMs: 1, stop: "end" });
      };
    });
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-b196-"));
  HangingBackend.release = undefined;
});
afterEach(async () => {
  HangingBackend.release?.();
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
  deadlineAt: NOW + 60_000,
  lease: { id: `lease_${id}`, runnerId: "runner_1", expiresAt: NOW + 60_000 },
});

async function makeRunner() {
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
      /* One slot, so a single held job is a full device. The default is two
         and the shape is identical; one keeps the test to one hanging job. */
      concurrency: 1,
    }),
  );
  const budgets = new Budgets(join(dir, "b.json"), loaded.config.community);
  await budgets.load(NOW);
  const spend = new SpendLedger(join(dir, "spend.json"));
  await spend.load(NOW);
  const ingress = new IngressLog({
    path: join(dir, "ingress.log"),
    communityPromptDays: 7,
    keepSelfPrompts: true,
  });

  let served = 0;
  const events: string[] = [];
  const runner = new Runner({
    client: new ProtocolClient({
      origin: "https://app.test",
      identity: SIGNER,
      fetch: (input) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith("/fetch")) {
          return sealedFor("job_1").then(
            (envelope) =>
              new Response(JSON.stringify({ envelope }), {
                headers: { "content-type": "application/json" },
              }),
          );
        }
        if (url.endsWith("/result")) {
          /* Answered properly rather than with the heartbeat body every other
             path got. The first version of this harness let `/result` fall
             through, and the job never completed — the slot stayed held, no
             event fired, and the case read as "the other edge does not work"
             when what did not work was the stub. */
          return Promise.resolve(
            new Response(JSON.stringify({ accepted: true, state: "done" }), {
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (url.endsWith("/claim")) {
          served += 1;
          /* One job, once. A second would be refused for want of a slot and
             that is a different row; what is under test is the poll that
             never asks. */
          return Promise.resolve(
            new Response(
              JSON.stringify({
                jobs: served === 1 ? [job("job_1")] : [],
                leaseMs: 60_000,
              }),
              { headers: { "content-type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              sites: { [SITE_ID]: publicIdentityOf(SITE_KEYS) },
              awaitingConsent: [],
              cancel: [],
              lost: [],
              serverTime: NOW,
            }),
            { headers: { "content-type": "application/json" } },
          ),
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
    now: () => NOW,
    onEvent: (event) => {
      events.push(event.type);
    },
    backendFactory: () => new HangingBackend(),
  });

  /** A tick, plus the microtasks the claim path needs to settle. */
  const tick = async () => {
    await runner.tick();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  return { runner, tick, events, claims: () => served };
}

describe("a device with every slot held", () => {
  it("says so, instead of returning in silence", async () => {
    const { tick, events } = await makeRunner();
    await tick(); // claims job_1; the backend hangs, holding the only slot
    events.length = 0;
    await tick(); // free <= 0

    expect(events).toContain("no-free-slot");
  });

  it("does not ask for work it has nowhere to put", async () => {
    /* The other half of the defect. The `return` is correct — claiming with no
       slot would take a lease this device cannot serve — and the silence was
       not. So the claim count must NOT rise while it is full. */
    const { tick, claims } = await makeRunner();
    await tick();
    const afterFirst = claims();
    await tick();

    expect(claims()).toBe(afterFirst);
  });

  it("says it once, not on every poll", async () => {
    /**
     * Edge-triggered, like `serving-nothing` above it. A poll runs every few
     * seconds, and a device legitimately serving two long jobs would otherwise
     * print a line each time — which is how a real signal becomes noise
     * somebody filters out.
     */
    const { tick, events } = await makeRunner();
    await tick();
    events.length = 0;
    await tick();
    await tick();
    await tick();

    expect(events.filter((type) => type === "no-free-slot")).toHaveLength(1);
  });

  it("has the other edge written, which is as far as this harness reaches", () => {
    /**
     * **DECLARED, not driven — B175's floor, and it is a floor rather than a
     * choice.**
     *
     * Without the clearing edge an owner reads *"taking no new work"* and never
     * learns it stopped being true, which is B196's own silence pointed the
     * other way. So the code is there and this says what is and is not proven
     * about it.
     *
     * **What I could not do:** make a claimed job finish in this harness. The
     * backend IS reached and released — asserted above by the slot being held
     * and by the release running — and the job then never completes: no
     * `finished`, no `error`, nothing. `#active` is emptied by the `finally`
     * when the job unwinds, so the slot stays held. Not the clock (tried a
     * live one) and not the `/result` stub (answered properly). Somewhere
     * after the backend returns, this harness does not satisfy something the
     * runner waits for, and finding it is a harness problem rather than a
     * runner one.
     *
     * **What would settle it:** the `loop.test.ts` harness already drives jobs
     * to completion. Parameterising that one for `concurrency` and `onEvent`
     * would make this a driven case, and is the right next step for whoever
     * touches either file.
     *
     * Asserted on the source because a claim about code nobody ran is the only
     * honest shape available, and B175's rule is that it must say so.
     */
    const source = readFileSync(
      fileURLToPath(new URL("./runner.ts", import.meta.url)),
      "utf8",
    );
    const poll = source.slice(source.indexOf("#noFreeSlot = true"));
    expect(poll, "the clearing edge resets the flag").toContain(
      "this.#noFreeSlot = false",
    );
    expect(poll, "and says so").toContain('type: "free-slot-again"');
  });

  it("says nothing of the sort while it has room", async () => {
    /**
     * The control, and the one that stops this being noise on every healthy
     * device. A daemon that emitted `no-free-slot` unconditionally would pass
     * every case above.
     */
    const { tick, events } = await makeRunner();
    await tick();

    expect(events).not.toContain("no-free-slot");
  });
});

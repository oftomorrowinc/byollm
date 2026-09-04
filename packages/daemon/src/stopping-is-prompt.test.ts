import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Budgets } from "./budgets.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { IngressLog } from "./ingress.js";
import { ProtocolClient } from "./client.js";
import { Runner } from "./runner.js";
import { SpendLedger } from "./spend.js";
import { removeTemp } from "./test-support.js";

/**
 * A stop is answered when it arrives — byollm_016, 2026-09-03.
 *
 * Found by a test that was measuring something else: a parked daemon proved
 * it could promote itself in 38ms and then took ten seconds to shut down.
 *
 * **An AbortSignal is a latch, not an event.** The polling loop subscribed to
 * `abort` and never read `aborted`, and the ordinary case walks straight past
 * a subscription: the stop lands while a tick is in flight, the tick finishes,
 * and the loop calls `sleep` with a signal that has *already* aborted. No
 * listener fires for an abort that happened first, so it waits out a full
 * heartbeat — ten seconds — before the loop condition gets to see it.
 *
 * Long enough for launchd to give up on a polite stop and send a kill, which
 * lands mid-write on files this daemon keeps. The same mistake was in
 * `runLoop`'s wiring, where it was worse: an abort landing during startup
 * left a loop that nothing could ever stop.
 */
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-stop-"));
});
afterEach(async () => {
  await removeTemp(dir);
});

/** A heartbeat nobody could mistake for scheduling jitter. */
const HEARTBEAT_MS = 60_000;

async function runner(onTick: () => void) {
  const loaded = resolveConfig(
    DaemonConfig.parse({
      services: {
        primary: {
          model: "m",
          kinds: ["llm.generate"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:1/v1",
        },
      },
    }),
  );
  const budgets = new Budgets(join(dir, "b.json"), loaded.config.community);
  await budgets.load(Date.now());
  const spend = new SpendLedger(join(dir, "spend.json"));
  await spend.load(Date.now());

  return new Runner({
    // No origin is listening, so every tick fails and takes the backoff path
    // — which is the branch that sleeps, and the one that hung.
    client: new ProtocolClient({ origin: "http://127.0.0.1:1" }),
    runnerId: "runner_1",
    owner: "me",
    daemonVersion: "0.0.0",
    loaded,
    budgets,
    spend,
    heartbeatMs: HEARTBEAT_MS,
    ingress: new IngressLog({
      path: join(dir, "ingress.log"),
      communityPromptDays: 7,
      keepSelfPrompts: true,
    }),
    backendFactory: () => {
      throw new Error("no backend is needed to stop");
    },
    onEvent: (event) => {
      if (event.type === "error") onTick();
    },
  });
}

describe("stopping the polling loop", () => {
  it("returns at once when the stop lands during a tick", async () => {
    const stop = new AbortController();
    // Abort the moment the first tick reports its failure — so the signal is
    // already aborted by the time the loop reaches its sleep.
    const loop = await runner(() => {
      stop.abort();
    });

    const started = Date.now();
    await loop.run(stop.signal);
    const took = Date.now() - started;

    /* Generous by a factor the machine cannot plausibly consume: the failure
       this catches waits a full heartbeat, and anything under a second of
       that is the loop having read the latch. */
    expect(took).toBeLessThan(HEARTBEAT_MS / 4);
  }, 30_000);
});

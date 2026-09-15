import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Backend,
  BackendRequest,
  BackendResult,
} from "./backends/index.js";
import { Budgets } from "./budgets.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { IngressLog } from "./ingress.js";
import { Runner } from "./runner.js";
import { SpendLedger } from "./spend.js";
import { removeTemp } from "./test-support.js";

/**
 * A job's execution ceiling never outlives the job — B199.
 *
 * Todd's four-tab test: the box claimed two chat jobs and produced **no
 * outcome for ten minutes** — no ok, no failed, no refused. They were not
 * hung. They were grinding toward `maxWallClockMs`, **600,000 ms by default**,
 * while the job's own TTL was **120,000** and the page had stopped watching at
 * 45,000.
 *
 * **The loss is not the wasted work, it is the slot.** A held slot is a device
 * that claims nothing (B196), so at the default concurrency two dead jobs
 * silence a box for ten minutes. `.89` fixes the slot LEAK; a slot held by a
 * live child grinding past its job's death is a different loss and nothing
 * addressed it.
 *
 * The stub carries the deadline and the daemon knows the time, so the ceiling
 * is the smaller of the two. An owner who sets a long wall clock still gets it
 * — for jobs whose sites are still waiting.
 */

/** Reports the ceiling it was handed, instead of doing any work. */
let asked: number | undefined;

class CeilingReportingBackend implements Backend {
  readonly stopReasons = {
    kind: "unavailable" as const,
    why: "a test double reads no vendor signal",
  };
  readonly id = "openai-http" as const;
  readonly class = "http" as const;
  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({ healthy: true, models: ["m"] });
  }
  execute(request: BackendRequest): Promise<BackendResult> {
    asked = request.timeoutMs;
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
  dir = await mkdtemp(join(tmpdir(), "byollm-b199-"));
  asked = undefined;
});
afterEach(async () => {
  await removeTemp(dir);
});

const NOW = 1_800_000_000_000;
/** The daemon's default owner ceiling — `config.ts`'s `maxWallClockMs`. */
const WALL_CLOCK = 600_000;
/** What a stub's TTL actually was in Todd's run. */
const TTL = 120_000;

async function runnerFor() {
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
  await budgets.load(NOW);
  const spend = new SpendLedger(join(dir, "spend.json"));
  await spend.load(NOW);
  return new Runner({
    /* Never used: every case here calls `runJob` directly, which touches no
       client and no identity. Omitted rather than stubbed — a stub would be a
       claim about calls this test does not make. */
    client: {} as never,
    runnerId: "runner_1",
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
    now: () => NOW,
    backendFactory: () => new CeilingReportingBackend(),
  });
}

/** The shape `#handle` hands to `runJob`: the stub's fields plus a payload. */
const job = (deadlineAt: number | undefined) => ({
  id: "job_1",
  kind: "llm.generate" as const,
  payload: { prompt: "hi" },
  audience: "private" as const,
  owner: "me",
  site: "BYOLLM-TEST-SITE-KEY-ID",
  sizeClass: "small" as const,
  streaming: false,
  ...(deadlineAt === undefined ? {} : { deadlineAt }),
  lease: { id: "lease_1", runnerId: "runner_1", expiresAt: NOW + 60_000 },
});

describe("how long a job is allowed to grind", () => {
  it("stops at the job's TTL, not at the owner's wall clock", async () => {
    /* Todd's exact numbers: a 120s job was being given 600s to finish. */
    const runner = await runnerFor();
    await runner.runJob(job(NOW + TTL));

    expect(asked).toBe(TTL);
  });

  it("still honours the owner's ceiling when the TTL is longer", async () => {
    /**
     * The control, and it is the half that makes this a clamp rather than a
     * replacement. An owner who sets a long wall clock keeps it — the job's
     * deadline only ever takes time AWAY, never grants more.
     */
    const runner = await runnerFor();
    await runner.runJob(job(NOW + WALL_CLOCK * 10));

    expect(asked).toBe(WALL_CLOCK);
  });

  it("does not start a job whose deadline has already passed", async () => {
    /**
     * Spawning here would burn a slot on an answer nobody can still receive.
     * And `process-backend`'s own guard would have reported it as *"no time
     * limit was set for this call"* — a true sentence about the wrong problem,
     * which is the class B173 is named for.
     */
    const runner = await runnerFor();
    const ran = await runner.runJob(job(NOW - 1_000));

    expect(asked, "the backend was never reached").toBeUndefined();
    expect(ran.outcome.outcome).toBe("error");
  });

  it("leaves a job with no deadline exactly as it was", async () => {
    /* The compatibility control. `deadlineAt` is optional, and a caller that
       assembles a job without one must get the behaviour that existed before
       this row — not a refusal, and not a zero-length ceiling. */
    const runner = await runnerFor();
    await runner.runJob(job(undefined));

    expect(asked).toBe(WALL_CLOCK);
  });
});

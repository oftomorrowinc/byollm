import { CLOCK_SKEW_WARN_MS } from "@byollm/protocol";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Backend,
  BackendHealth,
  BackendResult,
} from "./backends/index.js";
import { Budgets } from "./budgets.js";
import { ProtocolClient } from "./client.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { IngressLog } from "./ingress.js";
import { SpendLedger } from "./spend.js";
import { Runner, type RunnerEvent } from "./runner.js";
import { removeTemp } from "./test-support.js";

/**
 * Telling somebody their clock is wrong before it costs them work.
 *
 * `serverTime` has been on every heartbeat response since the field was
 * added, with a docstring saying what it is for, and nothing read it. The
 * ruled proactive warning was dead from the day it was ruled — and the
 * reactive half is the wrong half alone: a refusal names the clock only once
 * drift passes the grant window, by which point every relayed job has already
 * failed.
 *
 * These drive a real heartbeat against a real server, because the thing under
 * test is a field arriving over the wire and being read.
 */

const NOW = 1_800_000_000_000;

let dir: string;
let server: Server;
let origin: string;
/** What the far side says the time is. Moved per case. */
let serverTime = NOW;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-skew-"));
  serverTime = NOW;
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/heartbeat")) {
      res.end(
        JSON.stringify({
          // A record, not an array — the site set is keyed by key id.
          sites: {},
          awaitingConsent: [],
          cancel: [],
          lost: [],
          serverTime,
        }),
      );
      return;
    }
    res.end(JSON.stringify({ jobs: [], leaseMs: 60_000 }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${String(
    typeof address === "object" && address ? address.port : 0,
  )}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await removeTemp(dir);
});

/** A backend that is simply not there. No job in this file reaches one. */
class Down implements Backend {
  readonly id = "openai-http" as const;
  readonly class = "http" as const;
  health(): Promise<BackendHealth> {
    return Promise.resolve({ healthy: false, models: [] });
  }
  execute(): Promise<BackendResult> {
    return Promise.resolve({
      ok: false,
      code: "backend-unreachable",
      message: "not reachable, and not asked",
      retryable: true,
      durationMs: 0,
    });
  }
}

/** A runner whose own clock is fixed at `NOW`, so drift is the server's. */
async function runner(seen: RunnerEvent[]) {
  const loaded = resolveConfig(
    DaemonConfig.parse({
      services: {
        primary: {
          type: "openai-http",
          baseUrl: "http://127.0.0.1:1/v1",
          model: "m",
          kinds: ["llm.generate"],
        },
      },
    }),
  );
  const budgets = new Budgets(join(dir, "b.json"), loaded.config.community);
  await budgets.load(NOW);
  const spend = new SpendLedger(join(dir, "s.json"));
  await spend.load(NOW);

  return new Runner({
    client: new ProtocolClient({
      origin,
      identity: {
        runnerId: "runner_1",
        sign: () => "sig",
      },
    }),
    runnerId: "runner_1",
    owner: "me",
    daemonVersion: "0.0.0",
    loaded,
    budgets,
    spend,
    ingress: new IngressLog({
      path: join(dir, "i.log"),
      communityPromptDays: 7,
      keepSelfPrompts: true,
    }),
    // Down, and never asked to run anything: these cases end at the
    // heartbeat. A backend that reported healthy would only advertise a
    // capability nobody claims.
    backendFactory: () => new Down(),
    now: () => NOW,
    onEvent: (event) => seen.push(event),
  });
}

const skews = (seen: RunnerEvent[]) =>
  seen.filter((e) => e.type === "clock-skew" || e.type === "clock-recovered");

describe("the clock, said out loud before it costs anything", () => {
  it("says nothing while the clocks agree", async () => {
    const seen: RunnerEvent[] = [];
    await (await runner(seen)).tick();
    expect(skews(seen)).toEqual([]);
  });

  it("says nothing at exactly the threshold", async () => {
    // The boundary belongs to the quiet side: `CLOCK_SKEW_WARN_MS` is the
    // drift a grant is still tolerated at, so warning here would warn about
    // work that runs.
    serverTime = NOW - CLOCK_SKEW_WARN_MS;
    const seen: RunnerEvent[] = [];
    await (await runner(seen)).tick();
    expect(skews(seen)).toEqual([]);
  });

  it("warns once the device is far enough ahead, and says how far", async () => {
    serverTime = NOW - 45_000;
    const seen: RunnerEvent[] = [];
    await (await runner(seen)).tick();

    // Signed as the device sees it: positive means this machine is ahead.
    // Ahead and behind are different remedies and the sign is the only thing
    // that says which.
    expect(skews(seen)).toEqual([{ type: "clock-skew", skewMs: 45_000 }]);
  });

  it("warns when it is behind too, which is the case that broke grants", async () => {
    serverTime = NOW + 45_000;
    const seen: RunnerEvent[] = [];
    await (await runner(seen)).tick();

    expect(skews(seen)).toEqual([{ type: "clock-skew", skewMs: -45_000 }]);
  });

  it("says it once, not every beat", async () => {
    // A daemon heartbeats every few seconds and a wrong clock stays wrong for
    // as long as it takes somebody to notice. A line per beat is how a real
    // warning becomes noise that gets filtered.
    serverTime = NOW - 45_000;
    const seen: RunnerEvent[] = [];
    const device = await runner(seen);
    await device.tick();
    await device.tick();
    await device.tick();

    expect(skews(seen)).toHaveLength(1);
  });

  it("says so when the clock comes back, and warns again if it drifts twice", async () => {
    // Without the recovery event a fixed clock keeps looking broken on every
    // surface that latched the warning — and the second drift would be
    // silent, which is worse.
    const seen: RunnerEvent[] = [];
    const device = await runner(seen);

    serverTime = NOW - 45_000;
    await device.tick();
    serverTime = NOW;
    await device.tick();
    serverTime = NOW - 45_000;
    await device.tick();

    expect(skews(seen).map((e) => e.type)).toEqual([
      "clock-skew",
      "clock-recovered",
      "clock-skew",
    ]);
  });
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Budgets } from "./budgets.js";
import { ProtocolClient } from "./client.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { IngressLog } from "./ingress.js";
import { Runner } from "./runner.js";
import { SpendLedger } from "./spend.js";
import { removeTemp } from "./test-support.js";
import type {
  Backend,
  BackendRequest,
  BackendResult,
} from "./backends/index.js";
import type { ClaimedStub, JobPayload } from "@byollm/protocol";

/**
 * Direct mode is kind-only, and stays that way — byollm_016 Amendment L.
 *
 * Two routes now answer the same question differently, which is a standing
 * invitation to drift. On a relayed route a person's mapping names the
 * service and a grant carries it; in direct mode there is no control plane to
 * hold a mapping, so **the owner's own config and defaults answer** and the
 * ambiguity law applies exactly as it shipped.
 *
 * This file exists so the second half cannot quietly acquire the first half's
 * behaviour. Every case here is about a device with no pinned control-plane
 * key — the one fact that decides which regime is in force.
 */
const NOW = 1_800_000_000_000;
let dir: string;

class Echo implements Backend {
  readonly id = "openai-http" as const;
  readonly class = "http" as const;
  readonly seen: string[] = [];
  constructor(private readonly service: string) {}
  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({ healthy: true, models: ["m"] });
  }
  execute(request: BackendRequest): Promise<BackendResult> {
    this.seen.push(this.service);
    return Promise.resolve({ ok: true, text: request.prompt, durationMs: 1 });
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-direct-"));
});
afterEach(async () => {
  await removeTemp(dir);
});

/** A device paired with a direct site — no control plane, no grants. */
async function device(
  services: Record<string, unknown>,
  defaults: Record<string, string> = {},
): Promise<{ runner: Runner; asked: string[] }> {
  const asked: string[] = [];
  const loaded = resolveConfig(
    DaemonConfig.parse({
      services,
      ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    }),
  );
  const budgets = new Budgets(join(dir, "b.json"), loaded.config.community);
  await budgets.load(NOW);
  const spend = new SpendLedger(join(dir, "s.json"));
  await spend.load(NOW);
  const runner = new Runner({
    client: new ProtocolClient({ origin: "https://app.test" }),
    runnerId: "runner_1",
    owner: "alice",
    daemonVersion: "0.0.0",
    // The whole point: no `controlPlanePublic`.
    loaded,
    budgets,
    spend,
    ingress: new IngressLog({
      path: join(dir, "i.log"),
      communityPromptDays: 7,
      keepSelfPrompts: true,
    }),
    backendFactory: (route) => {
      asked.push(route.service);
      return new Echo(route.service);
    },
    now: () => NOW,
  });
  return { runner, asked };
}

const http = (extra: Record<string, unknown> = {}) => ({
  type: "openai-http",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "m",
  kinds: ["llm.generate"],
  ...extra,
});

const job = (
  over: Partial<ClaimedStub> = {},
): ClaimedStub & {
  payload: JobPayload;
} => ({
  id: "job_1",
  kind: "llm.generate",
  payload: { prompt: "hello" },
  audience: "private",
  owner: "alice",
  site: "BYOLLM-TEST-SITE-KEY-ID",
  sizeClass: "small",
  streaming: false,
  deadlineAt: NOW + 60_000,
  lease: { id: "lease_1", runnerId: "runner_1", expiresAt: NOW + 60_000 },
  ...over,
});

describe("a device with no control plane", () => {
  it("runs its owner's work with no grant at all", async () => {
    // The regime that a missing pinned key selects. There is nothing to
    // verify a grant against, so requiring one would make direct mode
    // unusable rather than safe.
    const { runner } = await device({ only: http() });
    expect(runner.admit(job()).ok).toBe(true);
  });

  it("refuses everybody else, because nothing here can say who they are", async () => {
    // Ruled 2026-08-26. A local list of names would be believing the site's
    // per-job claim about its own users, which is the assertion Amendment G
    // property 1 outlawed wearing an allowlist costume.
    const { runner } = await device({ only: http({ offer: "team" }) });
    const result = runner.admit(job({ owner: "stranger", audience: "team" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not paired with a relay");
  });
});

describe("resolution is the owner's, by kind", () => {
  it("sends a job to the owner's default when several answer the kind", async () => {
    // The relayed route would resolve this from the person's mapping. Here
    // there is no mapping and no grant, so the config answers — and the
    // config's answer is the `defaults` block, not whichever service sorts
    // first.
    const { runner, asked } = await device(
      { alpha: http(), beta: http() },
      { "llm.generate": "beta" },
    );
    await runner.runJob(job());
    expect(asked).toEqual(["beta"]);
  });

  it("serves the sole claimant without asking for a default", async () => {
    // One claimant needs no ceremony: a set of one is not a choice.
    const { runner, asked } = await device({ only: http() });
    await runner.runJob(job());
    expect(asked).toEqual(["only"]);
  });

  it("withholds a kind two services answer with no default", async () => {
    // The ambiguity law, as shipped. Nobody may pick on the owner's behalf —
    // the wrong guess is the metered one — so the kind is not served at all
    // until they say which.
    const { runner, asked } = await device({ alpha: http(), beta: http() });
    const outcome = await runner.runJob(job());
    expect(outcome.outcome).toBe("error");
    expect(asked).toEqual([]);
  });
});

describe("what a site may say, and what it cannot make happen", () => {
  it("ignores a purpose, because there is nothing here to resolve it against", async () => {
    /**
     * The drift guard.
     *
     * A site's SDK is uniform across routes, so a direct site may well send a
     * purpose. Direct mode has no manifest, no mapping and no control plane
     * to join them — so the field is inert here, and the owner's default
     * answers exactly as it does for a job that named nothing.
     *
     * Asserted rather than assumed, because the failure it prevents is a
     * device that started treating a site's word about purposes as a
     * selection — which is the whole thing Amendment L moved away from.
     */
    const { runner, asked } = await device(
      { alpha: http(), beta: http() },
      { "llm.generate": "beta" },
    );
    await runner.runJob(job({ purpose: "revenue" }));
    expect(asked).toEqual(["beta"]);
  });
});

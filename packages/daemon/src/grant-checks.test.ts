import { GRANT_MAX_AGE_MS } from "@byollm/protocol";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonConfig, resolveConfig } from "./config.js";
import { Budgets } from "./budgets.js";
import { IngressLog } from "./ingress.js";
import { ProtocolClient } from "./client.js";
import { Runner, type RunnerEvent } from "./runner.js";
import { SpendLedger } from "./spend.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTemp, testControlPlane } from "./test-support.js";
import type {
  Backend,
  BackendRequest,
  BackendResult,
} from "./backends/index.js";
import type { ClaimedStub, JobPayload } from "@byollm/protocol";

/**
 * The four checks a device still makes for itself — byollm_016 Amendment J.
 *
 * A grant folds consent, membership, admission and selection into one signed
 * document, which means a bug in any one of these is a bug in all four at
 * once. That is the price of the consolidation, and this file is the interest
 * payment: each check gets its own test with everything else held valid, so a
 * failure names the check that broke rather than whichever one happened to
 * fire first.
 *
 *   1. the signature, over a document naming this owner, this job, this user
 *   2. replay — one grant admits one job, once
 *   3. offer-consistency — the named service is one this device offers
 *   4. private is absolute — no grant admits a stranger to a private service
 */

let dir: string;
const NOW = 1_800_000_000_000;

class Echo implements Backend {
  readonly id = "openai-http" as const;
  readonly class = "http" as const;
  readonly seen: string[] = [];
  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({ healthy: true, models: ["m"] });
  }
  execute(request: BackendRequest): Promise<BackendResult> {
    this.seen.push(request.prompt);
    return Promise.resolve({ ok: true, text: "ok", durationMs: 1 });
  }
}

const plane = testControlPlane();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-grant-"));
});
afterEach(async () => {
  await removeTemp(dir);
});

/** Bob's device, offering `shared` to his team and `mine` to himself. */
async function device(
  over: { onEvent?: (event: RunnerEvent) => void; now?: () => number } = {},
): Promise<Runner> {
  const loaded = resolveConfig(
    DaemonConfig.parse({
      services: {
        shared: {
          model: "m",
          kinds: ["llm.generate"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          offer: "team",
        },
        mine: {
          model: "m",
          kinds: ["llm.chat"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          offer: "private",
        },
      },
    }),
  );
  const budgets = new Budgets(join(dir, "b.json"), loaded.config.community);
  await budgets.load(NOW);
  const spend = new SpendLedger(join(dir, "s.json"));
  await spend.load(NOW);
  return new Runner({
    client: new ProtocolClient({ origin: "https://relay.test" }),
    runnerId: "runner_1",
    owner: "bob",
    daemonVersion: "0.0.0",
    controlPlanePublic: plane.controlPlanePublic,
    loaded,
    budgets,
    spend,
    ingress: new IngressLog({
      path: join(dir, "i.log"),
      communityPromptDays: 7,
      keepSelfPrompts: true,
    }),
    backendFactory: () => new Echo(),
    now: over.now ?? (() => NOW),
    ...(over.onEvent === undefined ? {} : { onEvent: over.onEvent }),
  });
}

/** Alice's job, with a grant that is valid unless a test bends it. */
const job = (
  over: Partial<ClaimedStub> = {},
  grantOver: Parameters<typeof plane.sign>[0] = {},
): ClaimedStub & { payload: JobPayload } => ({
  id: "job_1",
  kind: "llm.generate",
  payload: { prompt: "hello" },
  audience: "team",
  owner: "alice",
  site: "BYOLLM-TEST-SITE-KEY-ID",
  sizeClass: "small",
  streaming: false,
  deadlineAt: NOW + 60_000,
  lease: { id: "lease_1", runnerId: "runner_1", expiresAt: NOW + 60_000 },
  grant: plane.sign({
    jobId: "job_1",
    user: "alice",
    owner: "bob",
    kind: "llm.generate",
    service: "shared",
    issuedAt: NOW,
    ...grantOver,
  }),
  ...over,
});

describe("check 1 — the signature, and what it is over", () => {
  it("admits a job whose grant is entirely in order", async () => {
    // The control. Every negative below changes exactly one thing from here.
    expect((await device()).admit(job()).ok).toBe(true);
  });

  it("refuses a job that arrived with no grant at all", async () => {
    // Fail closed. A device that pinned a key expects a grant with every
    // job, including its owner's own, so a missing one is a relay that
    // dropped it or a version skew — indistinguishable, and both answered
    // the same way because guessing open is how this goes wrong.
    const result = (await device()).admit(job({ grant: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no grant arrived");
  });

  it("refuses a grant signed by a key this device did not pin", async () => {
    const other = testControlPlane();
    const forged = other.sign({
      jobId: "job_1",
      user: "alice",
      owner: "bob",
      service: "shared",
      issuedAt: NOW,
    });
    const result = (await device()).admit(job({ grant: forged }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not signed by");
  });

  it("refuses a genuine grant lifted from a different job", async () => {
    const result = (await device()).admit(job({}, { jobId: "job_other" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("different job");
  });

  it("refuses a genuine grant written for a different device owner", async () => {
    const result = (await device()).admit(job({}, { owner: "carol" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("different device owner");
  });

  it("refuses a grant naming a different user than the job", async () => {
    // The stub's `owner` is a claim by whoever routed it; the grant's `user`
    // is signed. A grant for bob attached to a job stubbed as alice's would
    // otherwise serve alice and charge the budget against a name nobody
    // authorised.
    const result = (await device()).admit(job({}, { user: "someone-else" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("different user");
  });

  it("refuses a grant older than the window, and names the clock when it is the clock", async () => {
    const runner = await device();

    const stale = runner.admit(
      job({}, { issuedAt: NOW - GRANT_MAX_AGE_MS - 1_000 }),
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toContain("signed too long ago");

    // Far enough out that the clock is the story rather than the grant.
    const skewed = runner.admit(
      job({}, { issuedAt: NOW - GRANT_MAX_AGE_MS - 600_000 }),
    );
    expect(skewed.ok).toBe(false);
    if (!skewed.ok) {
      expect(skewed.reason).toContain("clock");
      expect(skewed.reason).toContain("fix the clock, not the relay");
    }
  });
});

describe("check 2 — replay", () => {
  it("admits a grant once and refuses the same one after", async () => {
    const runner = await device();
    const claimed = job();
    expect(runner.admit(claimed).ok).toBe(true);

    const again = runner.admit(claimed);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toContain("already been used");
  });

  it("does not spend a grant that was refused for another reason", async () => {
    // A grant burned by a refusal would make the retry fail for a second,
    // unrelated reason — and the upstream re-offers with a fresh grant
    // anyway, so there is nothing to protect by burning it early.
    const runner = await device();
    const refused = job({ kind: "llm.image" as never });
    expect(runner.admit(refused).ok).toBe(false);

    // Same grant id, now on a job this device can actually run.
    const retry = job();
    retry.grant = refused.grant;
    expect(runner.admit(retry).ok).toBe(true);
  });

  it("lets a re-claimed job through on a fresh grant", async () => {
    // Why single-use binds to the grant and not the job: a claim that times
    // out is re-claimed, and the control plane authors a *second* grant for
    // the same job id. Binding to the job would refuse the device's own
    // recovery.
    const runner = await device();
    expect(runner.admit(job()).ok).toBe(true);
    expect(runner.admit(job()).ok).toBe(true);
  });
});

describe("check 3 — offer-consistency", () => {
  it("refuses a grant naming a service this device does not offer", async () => {
    // The control plane chooses from what the device advertised. A name it
    // did not is either stale or forged, and either way this device has
    // nothing to run it on.
    const result = (await device()).admit(job({}, { service: "not-mine" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no backend");
  });

  it("refuses a grant whose service cannot serve the job's kind", async () => {
    // `mine` answers `llm.chat`; this job is `llm.generate`. Resolution has
    // to agree on both halves or the grant is naming a pairing that does not
    // exist.
    const result = (await device()).admit(job({}, { service: "mine" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no backend");
  });

  it("refuses when the job asks for one service and the grant resolved another", async () => {
    // Two answers to a settled question. Refused rather than silently
    // overridden, because a silent override is how "the grant decides" turns
    // into "whichever we read last".
    const result = (await device()).admit(job({ service: "mine" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("different service");
  });
});

describe("what the run log is told", () => {
  it("names which check refused, not just that one did", async () => {
    /**
     * A refusal that says only "the job did not run" leaves somebody
     * comparing four possibilities by hand. These are the events `byollm run`
     * prints, and each names the check — a forged grant and a slow clock are
     * the same outcome and completely different problems.
     */
    const seen: string[] = [];
    const runner = await device({
      onEvent: (event) => {
        if (event.type === "grant-refused") seen.push(event.refusal);
      },
    });

    runner.admit(job({ grant: undefined }));
    runner.admit(job({}, { jobId: "elsewhere" }));
    runner.admit(job({}, { user: "somebody-else" }));
    runner.admit(job({}, { issuedAt: NOW - GRANT_MAX_AGE_MS - 1_000 }));
    const spent = job();
    runner.admit(spent);
    runner.admit(spent);

    expect(seen).toEqual([
      "absent",
      "wrong-job",
      "wrong-user",
      "expired",
      "replayed",
    ]);
  });
});

describe("the replay set does not grow forever", () => {
  it("forgets a grant once no fresh one could carry its id", async () => {
    /**
     * An entry only has to outlive the grant naming it: past
     * {@link GRANT_MAX_AGE_MS} the freshness check refuses that grant anyway,
     * so keeping the id would be guarding a door already shut. Without this a
     * long-running daemon accumulates one entry per job it has ever admitted.
     *
     * Observed through behaviour rather than by reading the map: the same id
     * becomes usable again once its window has passed, which is exactly what
     * "forgotten" means and is also proof it is not a leak.
     */
    let now = NOW;
    const runner = await device({ now: () => now });

    expect(runner.admit(job()).ok).toBe(true);
    expect(runner.admit(job()).ok).toBe(true);

    // Far enough on that nothing signed at NOW is fresh any more, and a grant
    // signed now reuses the id the swept entry held.
    now = NOW + GRANT_MAX_AGE_MS + 1;
    const reissued = job({}, { issuedAt: now });
    expect(runner.admit(reissued).ok).toBe(true);
  });
});

describe("check 4 — private is absolute", () => {
  it("refuses a stranger on a private service, with a perfectly valid grant", async () => {
    /**
     * The security posture in one test.
     *
     * This grant is genuine: signed by the pinned key, fresh, for this job,
     * naming a service this device really offers. A control plane that had
     * been fully compromised could author exactly this. It is refused anyway,
     * because `matchAudience` never consults admission for a `private`
     * service — the branch that would carry the grant is not reached.
     *
     * That is what "absolute" means here, and it is why the check is
     * structural rather than a line of code somebody could reorder.
     */
    const result = (await device()).admit(
      job(
        { kind: "llm.chat", audience: "team" },
        { kind: "llm.chat", service: "mine" },
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reason).toContain("offered to its owner only");
  });

  it("still runs the owner's own work on a private service", async () => {
    // The control for the above: `private` is not "off", it is "mine".
    const result = (await device()).admit(
      job(
        { kind: "llm.chat", owner: "bob", audience: "private" },
        { kind: "llm.chat", service: "mine", user: "bob" },
      ),
    );
    expect(result.ok).toBe(true);
  });
});

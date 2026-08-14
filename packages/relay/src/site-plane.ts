import { JobStub, SealedEnvelope } from "@byollm/protocol";
import { z } from "zod";
import type { PlaneResult } from "./daemon-plane.js";
import type { RelayState } from "./state.js";

/**
 * The plane a site talks to.
 *
 * **Outbound from the site, like everything else in this product.** A relay
 * that called site webhooks would need every site publicly reachable, which is
 * the connectivity problem the hub exists to delete — and it would put the
 * relay in the position of initiating contact, which is the posture the whole
 * design avoids. So a site polls, exactly as a daemon does, and the relay
 * never opens a connection to anyone.
 *
 * ## The three-beat exchange
 *
 * A site cannot seal at enqueue: a payload is encrypted to the device that
 * claims it, and at enqueue nobody has. So enqueue publishes a **stub**, and
 * sealing happens later, on demand:
 *
 * 1. `enqueue` — here is a stub; route it.
 * 2. `pending` — who claimed anything of mine, and what key do I seal to?
 * 3. `payload` — here is the ciphertext for that device.
 *
 * Then `results` collects what comes back. Four endpoints, all polled, none of
 * which ever carries a plaintext or a private key.
 *
 * The gap between beats 2 and 3 is the `awaiting-payload` state, and the
 * reason it needs its own timeout: a site that dies between them leaves a
 * device holding a job whose work will never arrive.
 */

const EnqueueRequest = z
  .object({
    siteId: z.string().min(1),
    /**
     * Everything the relay learns about the job.
     *
     * `JobStub` is exhaustive by construction and asserted so in the protocol
     * package — a site that tried to attach a prompt here would be refused by
     * the schema, not by a reviewer.
     */
    stub: JobStub,
  })
  .strict();

const PayloadRequest = z
  .object({
    siteId: z.string().min(1),
    jobId: z.string().min(1),
    /** Sealed to the claiming device. Opaque to us and to the schema. */
    envelope: SealedEnvelope,
  })
  .strict();

const ok = (body: unknown): PlaneResult => ({ status: 200, body });
const fail = (status: number, error: string, message: string): PlaneResult => ({
  status,
  body: { error, message },
});

export interface SitePlaneDeps {
  readonly state: RelayState;
  readonly now: () => number;
}

export class SitePlane {
  readonly #deps: SitePlaneDeps;

  constructor(deps: SitePlaneDeps) {
    this.#deps = deps;
  }

  enqueue(body: unknown): PlaneResult {
    const parsed = EnqueueRequest.safeParse(body);
    if (!parsed.success) {
      return fail(400, "bad-request", "enqueue failed schema validation");
    }
    const job = this.#deps.state.enqueue({
      id: parsed.data.stub.id,
      siteId: parsed.data.siteId,
      stub: parsed.data.stub,
    });
    return ok({ jobId: job.id, state: job.state });
  }

  /**
   * What needs sealing, and who to seal it to.
   *
   * The response carries the claiming device's **public** keys — which is the
   * entire reason a blind relay can exist. The relay is a directory here, not
   * a participant: it tells the site an address, and what the site sends to
   * that address is unreadable on the way through.
   */
  pending(siteId: string): PlaneResult {
    this.#deps.state.sweep(this.#deps.now());
    const jobs = this.#deps.state.awaiting(siteId).map((job) => ({
      jobId: job.id,
      // Non-null by construction: `awaiting` only returns claimed jobs. The
      // optional chain is here so a future state-machine edit that broke that
      // invariant would produce a missing field rather than a crash on the
      // routing path.
      device: job.claimedBy?.device,
      runnerId: job.claimedBy?.runnerId,
      leaseId: job.claimedBy?.leaseId,
      /** So a site can decline to seal for a claim about to expire. */
      awaitingUntil: job.awaitingUntil,
    }));
    return ok({ jobs });
  }

  payload(body: unknown): PlaneResult {
    const parsed = PayloadRequest.safeParse(body);
    if (!parsed.success) {
      return fail(400, "bad-request", "payload failed schema validation");
    }
    const job = this.#deps.state.job(parsed.data.jobId);
    if (job?.siteId !== parsed.data.siteId) {
      return fail(404, "not-found", "unknown job");
    }
    if (job.state !== "awaiting-payload") {
      // The timeout fired and the job went back to the queue, or another
      // device already has it. Refusing is what makes the timeout mean
      // something: a late seal must not land on a claim that has moved.
      return fail(409, "too-late", `job is ${job.state}, not awaiting payload`);
    }
    job.payload = parsed.data.envelope;
    job.state = "ready";
    delete job.awaitingUntil;
    return ok({ jobId: job.id, state: job.state });
  }

  /** Sealed results, for the site to open and verify. */
  results(siteId: string): PlaneResult {
    const jobs = this.#deps.state.finished(siteId).map((job) => ({
      jobId: job.id,
      envelope: job.result,
      disposition: job.disposition,
      runnerId: job.claimedBy?.runnerId,
      /**
       * Which device ran it, so the site can verify the signature against the
       * key it was told to seal to — and so `RESULT_PROVENANCE` can name a
       * foreign device rather than guessing (cloud_004 §11.2).
       */
      device: job.claimedBy?.device,
    }));
    return ok({ jobs });
  }
}

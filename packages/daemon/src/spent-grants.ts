import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { GRANT_MAX_AGE_MS } from "@byollm/protocol";

const SpentFile = z
  .object({
    version: z.literal(1),
    /** Grant id to the moment past which it could not be replayed anyway. */
    spent: z.record(z.string(), z.number().int().positive()),
  })
  .strict();

/**
 * Grants this device has already admitted — byollm-review 2026-08-27.
 *
 * A grant admits one job, once. That was enforced by a `Map` that lived only
 * in the process, defended in a comment: "an entry can only matter for as
 * long as the grant naming it is still fresh, and a device that has restarted
 * since is past that window anyway."
 *
 * The second half is false, and it is the half the argument rests on.
 * {@link GRANT_MAX_AGE_MS} is two minutes; a supervised restart — systemd, a
 * crash loop, a deploy — completes in about a second. So the window is not
 * "past" at all: the set comes back empty while the grant is still perfectly
 * fresh, and a relay that re-delivers the same stub gets a second admission
 * and a second execution. Double-spend of somebody's metered backend, or
 * duplicated side effects, on work that was already done.
 *
 * ## What durable means here, exactly
 *
 * Written with a **synchronous** write, and that is the whole mechanism. The
 * threat is a process that dies and is restarted by a supervisor, which is
 * survived the moment the bytes reach the operating system — the page cache
 * outlives the process. It is not `fsync`, so a machine losing power between
 * the write and the flush can still forget. That is a worse failure with a
 * far smaller window, and paying an `fsync` per admitted job to close it
 * would put disk latency in front of every claim.
 *
 * Synchronous rather than awaited because {@link Runner.admit} answers
 * synchronously, and the record has to be durable *before* the job runs —
 * writing afterwards would leave exactly the gap this closes. The file holds
 * only ids that are still fresh, so it is small by construction rather than
 * by pruning policy.
 */
export class SpentGrants {
  readonly #path: string | undefined;
  #spent = new Map<string, number>();

  /**
   * Without a path this is memory-only, which is what tests want and what
   * direct mode is: no control plane, no grants, nothing to replay.
   */
  constructor(path?: string) {
    this.#path = path;
  }

  /** Read what survived the last run, dropping whatever has expired. */
  load(now: number): void {
    if (this.#path === undefined) return;
    try {
      const parsed = SpentFile.safeParse(
        JSON.parse(readFileSync(this.#path, "utf8")),
      );
      if (parsed.success) {
        this.#spent = new Map(Object.entries(parsed.data.spent));
      }
    } catch {
      /**
       * A missing or corrupt file reads as "nothing spent".
       *
       * The unsafe direction, and it is the right one here: the alternative
       * is a device that refuses every grant because a file did not parse,
       * which turns a corrupt cache into a total outage. What is lost is
       * replay protection across one restart — the state this had always,
       * before today — and it is bounded by the freshness window.
       */
      this.#spent = new Map();
    }
    this.#forget(now);
  }

  /** Has this grant already admitted a job? */
  has(grantId: string, now: number): boolean {
    this.#forget(now);
    return this.#spent.has(grantId);
  }

  /** Burn it, durably enough to survive a restart. */
  spend(grantId: string, issuedAt: number, now: number): void {
    this.#spent.set(grantId, issuedAt + GRANT_MAX_AGE_MS);
    this.#forget(now);
    if (this.#path === undefined) return;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeFileSync(
        this.#path,
        JSON.stringify({
          version: 1,
          spent: Object.fromEntries(this.#spent),
        }),
        { mode: 0o600 },
      );
    } catch {
      // A device that cannot write this still ran the job, and refusing the
      // work because the note failed would trade a rare double-execution for
      // a certain outage. In-memory protection stands for this process.
    }
  }

  /**
   * Drop entries that can no longer matter.
   *
   * An id only has to outlive the grant naming it: past the freshness window
   * the verifier refuses it anyway, so keeping it would guard a shut door.
   * Swept on use rather than on a timer — a daemon claiming nothing has
   * nothing to forget and should not wake up to say so.
   */
  #forget(now: number): void {
    for (const [id, expiresAt] of this.#spent) {
      if (expiresAt <= now) this.#spent.delete(id);
    }
  }
}

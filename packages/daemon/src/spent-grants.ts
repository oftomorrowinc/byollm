import { z } from "zod";
import { CLOCK_SKEW_WARN_MS, GRANT_MAX_AGE_MS } from "@byollm/protocol";
import { readLedgerSync, writeLedgerSync } from "./ledger.js";

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
  #untrusted: string | undefined;
  #untrustedUntil = 0;

  /**
   * Without a path this is memory-only, which is what tests want and what
   * direct mode is: no control plane, no grants, nothing to replay.
   */
  constructor(path?: string) {
    this.#path = path;
  }

  /**
   * Read what survived the last run, dropping whatever has expired.
   *
   * A file that will not parse is no longer read as "nothing spent". That
   * reading was chosen deliberately here — the comment argued that refusing
   * every grant turns a corrupt cache into a total outage — and the argument
   * is sound against refusing *forever*. It is not an argument for this,
   * because the exposure and the remedy have the same clock: an id only
   * matters while the grant naming it is still fresh, so refusing for that
   * long is all fail-closed ever needed. A torn write plus a supervised
   * restart inside a grant's window lets the same valid grant execute twice,
   * with nothing forged.
   */
  load(now: number): void {
    if (this.#path === undefined) return;
    const read = readLedgerSync(this.#path, SpentFile);
    if (read.state === "loaded") {
      this.#spent = new Map(Object.entries(read.data.spent));
    } else {
      this.#spent = new Map();
    }
    if (read.state === "untrusted") {
      this.#untrusted = read.why;
      /* Everything the lost file could have been protecting is expired by
         here, so this is where refusal stops being protection and starts
         being an outage. Skew is added because the grants being refused were
         stamped by somebody else's clock, and this device tolerates that much
         disagreement everywhere else it reads one. */
      this.#untrustedUntil = now + GRANT_MAX_AGE_MS + CLOCK_SKEW_WARN_MS;
    }
    this.#forget(now);
  }

  /**
   * Why every relayed grant is being refused, if it is.
   *
   * This is the one ledger whose brake covers the owner's own jobs too. The
   * other two count what the machine did for other people, and their brakes
   * stop exactly that. This one guards the wire: it is what stands between a
   * re-delivered stub and a second execution, and a duplicate of your own
   * metered job is still your money.
   */
  blockedReason(now: number): string | undefined {
    if (this.#untrusted === undefined) return undefined;
    if (now >= this.#untrustedUntil) {
      // The explicit reset. Nothing that was in the unreadable file can be
      // replayed now, so the empty set in memory is the truth again.
      this.#untrusted = undefined;
      return undefined;
    }
    return this.#untrusted;
  }

  /** Has this grant already admitted a job? */
  has(grantId: string, now: number): boolean {
    this.#forget(now);
    return this.#spent.has(grantId);
  }

  /**
   * Burn it, durably, and say whether that worked.
   *
   * Returns `false` when the burn is not on disk, and the caller must refuse
   * the job. This used to swallow the write failure and let the job run on
   * in-memory protection alone — which is precisely the protection that a
   * restart erases, so the case where the note fails and the case where the
   * note is needed are the same case.
   */
  spend(grantId: string, issuedAt: number, now: number): boolean {
    if (this.#path === undefined) {
      // Memory-only: direct mode, and the tests. There is no relay here to
      // re-deliver anything, so in-memory is the whole of the guarantee.
      this.#spent.set(grantId, issuedAt + GRANT_MAX_AGE_MS);
      this.#forget(now);
      return true;
    }
    if (this.blockedReason(now) !== undefined) return false;

    this.#spent.set(grantId, issuedAt + GRANT_MAX_AGE_MS);
    this.#forget(now);
    try {
      writeLedgerSync(
        this.#path,
        JSON.stringify({
          version: 1,
          spent: Object.fromEntries(this.#spent),
        }),
      );
      return true;
    } catch {
      /* Burned in memory and refused anyway. Keeping it burned is the safe
         direction: this process will not admit it either, and the upstream
         re-offers with a fresh grant rather than retrying this one. */
      return false;
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

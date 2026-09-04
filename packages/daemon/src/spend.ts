import { z } from "zod";
import { LedgerWriter, readLedger } from "./ledger.js";

const SpendFile = z
  .object({
    version: z.literal(1),
    /** Per backend key: epoch-ms timestamps and the cents charged. */
    entries: z.record(
      z.string(),
      z.array(
        z.object({ at: z.number().int().positive(), cents: z.number().min(0) }),
      ),
    ),
  })
  .strict();

/**
 * What the owner has spent running other people's work on a metered backend.
 *
 * byollm_007 §4: a widened metered backend must carry a ceiling and stop at
 * it. A ceiling nobody counts against is a comment, so this is the counting.
 *
 * **On accuracy, honestly.** Providers do not return a price, so this
 * estimates from token counts and an owner-supplied rate. It will not match an
 * invoice to the cent. It does not need to: its job is to stop a runaway, and
 * for that a defensible over-estimate is worth more than a precise number
 * arriving too late. The ceiling is a brake, not an accountant.
 */
export class SpendLedger {
  readonly #path: string;
  #entries: Record<string, { at: number; cents: number }[]> = {};
  #loaded = false;
  #untrusted: string | undefined;
  readonly #writer: LedgerWriter;

  constructor(path: string) {
    this.#path = path;
    this.#writer = new LedgerWriter(path);
  }

  /**
   * Read the ledger, and remember whether it could be read at all.
   *
   * This used to funnel every failure — unparseable JSON, wrong schema, an
   * I/O error — into the same empty object as a file that had never been
   * written, and the comment here promised a brake that `hasReachedCeiling`
   * did not apply. Zero spent is the *unsafe* reading: with a cap configured,
   * `0 >= cap` is false and the metered gate opens on exactly the state a
   * torn write produces.
   */
  async load(now: number): Promise<void> {
    const read = await readLedger(this.#path, SpendFile);
    this.#entries = read.state === "loaded" ? read.data.entries : {};
    this.#untrusted = read.state === "untrusted" ? read.why : undefined;
    this.#prune(now);
    this.#loaded = true;
  }

  /**
   * Why this ledger cannot be counted on, if it cannot — for `byollm status`.
   *
   * The owner has to be able to find out why their machine stopped taking
   * community work. A brake nobody can explain looks like a broken daemon.
   */
  untrustedReason(): string | undefined {
    return this.#untrusted;
  }

  /** Cents spent on community work for this backend in the last 24 hours. */
  spentTodayCents(backendKey: string, now: number): number {
    this.#assertLoaded();
    const since = now - 86_400_000;
    return (this.#entries[backendKey] ?? [])
      .filter((e) => e.at >= since)
      .reduce((sum, e) => sum + e.cents, 0);
  }

  /**
   * Has this backend spent its daily ceiling?
   *
   * A backend with no ceiling reads as reached — not as unlimited. That is
   * the safe direction and it matches the config rule: sharing without a
   * ceiling is refused at load, so reaching this state means something is
   * inconsistent and the brake should be on.
   */
  hasReachedCeiling(
    backendKey: string,
    capCents: number | undefined,
    now: number,
  ): boolean {
    /* An unreadable ledger reads as reached, whatever the cap says. The
       counts behind this number are gone, so the honest answer to "how much
       has been spent" is "unknown", and unknown spends nothing further of
       somebody else's money. Only community metered work consults this — the
       owner's own jobs never reach it, so a bookkeeping failure cannot brake
       the machine's own work. */
    if (this.#untrusted !== undefined) return true;
    if (capCents === undefined) return true;
    return this.spentTodayCents(backendKey, now) >= capCents;
  }

  /** Record an estimated charge for community work. */
  async record(backendKey: string, cents: number, now: number): Promise<void> {
    this.#assertLoaded();
    /* The latch. Writing here would replace an unreadable ledger with a file
       holding one entry and call it the day's total — destroying the evidence
       and releasing the brake in the same line. It clears on a clean load,
       which is what happens once the owner moves the bad file aside. */
    if (this.#untrusted !== undefined) return;
    (this.#entries[backendKey] ??= []).push({ at: now, cents });
    this.#prune(now);
    await this.#writer.write(() =>
      JSON.stringify({ version: 1, entries: this.#entries }),
    );
  }

  /** Everything spent per backend today, for `byollm status`. */
  summary(now: number): Record<string, number> {
    this.#assertLoaded();
    const out: Record<string, number> = {};
    for (const key of Object.keys(this.#entries)) {
      out[key] = this.spentTodayCents(key, now);
    }
    return out;
  }

  #assertLoaded(): void {
    if (!this.#loaded) throw new Error("spend ledger used before load()");
  }

  /** Anything older than a day can never affect the window again. */
  #prune(now: number): void {
    const cutoff = now - 86_400_000;
    const pruned: Record<string, { at: number; cents: number }[]> = {};
    for (const [key, entries] of Object.entries(this.#entries)) {
      const kept = entries.filter((e) => e.at >= cutoff);
      if (kept.length > 0) pruned[key] = kept;
    }
    this.#entries = pruned;
  }
}

/**
 * Estimate the cost of a call in cents.
 *
 * Deliberately crude and deliberately generous: characters over four is a
 * rough token count, and the rate is whatever the owner said. Over-estimating
 * trips the brake early, which is the failure everyone prefers.
 */
export function estimateCents(
  promptChars: number,
  outputChars: number,
  centsPerMillionTokens: number,
): number {
  const tokens = (promptChars + outputChars) / 4;
  return (tokens / 1_000_000) * centsPerMillionTokens;
}

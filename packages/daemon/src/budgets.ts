import { z } from "zod";
import type { CommunityBudget } from "./config.js";
import { LedgerWriter, readLedger } from "./ledger.js";

const BudgetFile = z
  .object({
    version: z.literal(1),
    /** Epoch-ms timestamps of community jobs accepted, newest last. */
    accepted: z.array(z.number().int().positive()),
  })
  .strict();

export type BudgetRefusal =
  "hourly-cap" | "daily-cap" | "payload-too-large" | "ledger-untrusted";

export type BudgetDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly refusal: BudgetRefusal;
      readonly detail: string;
    };

/**
 * The owner's ceiling on work done for other people
 * ({@link MUSTS.COMMUNITY_BUDGETS}).
 *
 * byollm_004 §4 distinguishes two directions of abuse, and this is the one
 * aimed *at* the volunteer: a stranger who can enqueue unlimited `public`
 * jobs owns your GPU. Jobs for the machine's own owner are never counted —
 * their machine, their call.
 */
export class Budgets {
  readonly #path: string;
  readonly #limits: CommunityBudget;
  #accepted: number[] = [];
  #loaded = false;
  #untrusted: string | undefined;
  readonly #writer: LedgerWriter;

  constructor(path: string, limits: CommunityBudget) {
    this.#path = path;
    this.#limits = limits;
    this.#writer = new LedgerWriter(path);
  }

  /**
   * Read the record of what has already been accepted.
   *
   * Every failure used to become an empty array, which reconstructs the
   * counts as zero and passes both caps — the file that says "you have
   * already run your hundred jobs today" and the file that will not parse
   * were the same answer.
   */
  async load(now: number): Promise<void> {
    const read = await readLedger(this.#path, BudgetFile);
    this.#accepted = read.state === "loaded" ? [...read.data.accepted] : [];
    this.#untrusted = read.state === "untrusted" ? read.why : undefined;
    this.#prune(now);
    this.#loaded = true;
  }

  /** Why community work is braked, if it is — for `byollm status`. */
  untrustedReason(): string | undefined {
    return this.#untrusted;
  }

  /**
   * May this community job run?
   *
   * @param payloadChars - total payload text length, checked against the
   * stricter community limit rather than the protocol's absolute ceiling.
   */
  check(now: number, payloadChars: number): BudgetDecision {
    if (!this.#loaded) throw new Error("budgets used before load()");
    /* Before the counts, because the counts are the thing in doubt. Refusing
       is a nuisance for strangers and costs the owner nothing: only work for
       other people is checked here, and their own jobs never reach it. */
    if (this.#untrusted !== undefined) {
      return {
        ok: false,
        refusal: "ledger-untrusted",
        detail:
          "this device cannot read its record of community work, so it is " +
          "not accepting any until that is fixed",
      };
    }
    this.#prune(now);

    if (payloadChars > this.#limits.maxPayloadChars) {
      return {
        ok: false,
        refusal: "payload-too-large",
        detail:
          `community jobs are limited to ${String(this.#limits.maxPayloadChars)} ` +
          `characters; this one is ${String(payloadChars)}`,
      };
    }

    const hour = this.#countSince(now - 3_600_000);
    if (hour >= this.#limits.maxJobsPerHour) {
      return {
        ok: false,
        refusal: "hourly-cap",
        detail: `already ran ${String(hour)} community jobs in the last hour`,
      };
    }

    const day = this.#countSince(now - 86_400_000);
    if (day >= this.#limits.maxJobsPerDay) {
      return {
        ok: false,
        refusal: "daily-cap",
        detail: `already ran ${String(day)} community jobs today`,
      };
    }
    return { ok: true };
  }

  /** Count a community job as accepted. Call only after {@link check} passes. */
  async record(now: number): Promise<void> {
    // The latch: an untrusted ledger is not overwritten with a count of one.
    if (this.#untrusted !== undefined) return;
    this.#accepted.push(now);
    this.#prune(now);
    await this.#writer.write(() =>
      JSON.stringify({ version: 1, accepted: this.#accepted }),
    );
  }

  /** Current usage, for `byollm status`. */
  usage(now: number): { hour: number; day: number; limits: CommunityBudget } {
    this.#prune(now);
    return {
      hour: this.#countSince(now - 3_600_000),
      day: this.#countSince(now - 86_400_000),
      limits: this.#limits,
    };
  }

  #countSince(since: number): number {
    return this.#accepted.filter((at) => at >= since).length;
  }

  /** Anything older than a day can never affect either window again. */
  #prune(now: number): void {
    const cutoff = now - 86_400_000;
    this.#accepted = this.#accepted.filter((at) => at >= cutoff);
  }
}

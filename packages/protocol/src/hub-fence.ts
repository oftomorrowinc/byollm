/**
 * What byollm.cloud can see, in the words a person reads — B039.
 *
 * ## Why a sentence is in a published package
 *
 * This one sentence has to be true in three places at once: the privacy page
 * that prints it, the check beside the hub's schema that proves every recorded
 * column is claimed by one of its clauses, and the page test that pins the
 * wording. Two of those live in `byollm-cloud`, one in `byollm-cloud-web`, and
 * **a check cannot read another repository** — so until now the sentence was
 * written out three times and nothing compared the copies.
 *
 * That is not a tidiness problem. An enumeration is a promise, and a promise
 * kept in three places drifts in two of them: the copy beside the schema is
 * the one that fails when a column is added, and if it is not the copy on the
 * page, the page stays reassuring and stops being true. Which is worse than
 * never having made the promise.
 *
 * `byollm_023` named the only two shapes — a copy per repository (they
 * diverge, silently) or one source both import (it goes stale, loudly, as a
 * version pin). **Todd ruled shape 2 on 2026-09-17**, and the reason is the
 * one that decides it: staleness is a number somebody can compare, and B164's
 * cross-repository pin comparison is the thing that compares it. Divergence
 * has no such number.
 *
 * ## Why it lives in `@byollm/protocol` and not a package of its own
 *
 * It was one, for a day. **Todd ruled on 2026-09-19: no seventh package** —
 * *"I do think just adding it to protocol and importing that makes a ton of
 * sense"* — and `packages/agreements` was deleted rather than marked private.
 * Both consuming repositories already pin `@byollm/protocol`, so the sentence
 * arrives on a pin they carry instead of a name they would have to adopt, and
 * the cut stops carrying a package that had never been published.
 *
 * ## Published, not internal
 *
 * It ships to npm rather than living in a private repository, and that is a
 * property rather than an accident: a promise about what a hosted service can
 * see is worth more when anybody can install the package, read the sentence,
 * and check it against what the service does. Protocol is public, so that is
 * unchanged by the move.
 */

/**
 * The hub fence, verbatim — ruled by Todd, 2026-09-04.
 *
 * Asserted whole rather than by keyword wherever it is checked: "close
 * enough" is not a standard a page about what we can see gets to use, and a
 * paraphrase that drifted would leave the other repository checking a sentence
 * nobody ships.
 */
export const HUB_FENCE =
  "byollm.cloud sees only what routing and metering need: which devices " +
  "and sites are connected, each job's kind, size, and outcome, and " +
  "timestamps. Never prompts, never answers, never credentials.";

/**
 * A clause of {@link HUB_FENCE}, and the columns it accounts for.
 *
 * The mapping is here rather than beside the schema for the same reason the
 * sentence is: it is a fact about the sentence, and the sentence is shared.
 * What stays beside the schema is the CHECK — every recorded column must be
 * claimed by one of these before that suite passes — because the columns are
 * the hub's and only the hub's repository can enumerate them.
 *
 * Coupling copy to columns by check rather than by convention is the whole of
 * the ruling: the enumeration is only a promise if something fails when the
 * code outgrows it.
 */
export interface FenceClause {
  /** The clause as it appears in {@link HUB_FENCE}. */
  readonly says: string;
  /** The recorded columns this clause accounts for. */
  readonly covers: readonly string[];
}

/**
 * Every clause, with what it covers.
 *
 * A column not claimed by any clause is a fact about somebody that the page
 * does not mention, which is what the check beside the schema refuses.
 */
export const HUB_FENCE_CLAUSES: readonly FenceClause[] = Object.freeze([
  {
    says: "which devices and sites are connected",
    covers: Object.freeze(["owner_id", "site_id", "member_id"]),
  },
  {
    says: "each job's kind, size, and outcome",
    covers: Object.freeze(["kind", "size_class", "disposition", "bytes"]),
  },
  {
    says: "and timestamps",
    covers: Object.freeze(["at", "month", "updated_at"]),
  },
  /*
   * Ruled plumbing, not a new fact about a person — Todd, 2026-09-04.
   *
   * Named here rather than silently tolerated. A column exempted by a ruling
   * and a column nobody noticed look identical to a check that just skips
   * them, and only one of those is a decision.
   */
  {
    says: "(metering plumbing, ruled unenumerated)",
    covers: Object.freeze(["id", "job_id", "price_version"]),
  },
]);

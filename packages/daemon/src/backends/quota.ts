/**
 * Is this CLI blocked by its own quota, and until when — byollm_019 §3.1.
 *
 * A subscription CLI that is signed in, healthy, and simply *busy until 7pm*
 * used to classify as `backend-error`, which is the class for "something went
 * wrong once" and which the runner deliberately does nothing about. So every
 * job took the slow path: claimed by a device whose service would fail,
 * failing, and telling the site nothing until the job's TTL ran out. The
 * fallback Todd promised Eric cannot fire, because the site was never told
 * anything to fall back *from*.
 *
 * Distinct from `unauthorized`, and that is the point rather than tidiness:
 * the remedies are opposite. A signed-out CLI needs a person at a terminal. A
 * quota-blocked one needs **time and nothing else**, and telling somebody to
 * sign in when their account is merely busy is the remedy-must-match-the-cause
 * failure in a new place.
 *
 * ## The corpus admits only what a CLI actually said — ruled 2026-09-03
 *
 * Every entry below is verbatim output somebody met, with the date and the
 * version that produced it. **Guessed strings never.** The reason is in the
 * failure modes, which are not symmetric:
 *
 *   - a phrase we have not seen changes nothing — the service stays
 *     advertised and behaves exactly as it does today;
 *   - a phrase we invented that matches something else withdraws a service
 *     that works, and tells its owner to wait for a block that does not exist.
 *
 * **The failure mode of the match is silence, not a wrong action** — the rule
 * the auth corpus states, and which that corpus learned the hard way by
 * growing wrong the first time.
 *
 * An empty corpus is a legal state. The machinery ships either way; what it
 * does with nothing observed is nothing, which is today's behaviour.
 *
 * ## What it does not read
 *
 * Never the model's own answer. A prompt asking about rate limits, or a model
 * discussing them, must not withdraw the service that answered — so callers
 * pass only a *failure* diagnostic, and only when the adapter has already
 * decided the call failed.
 */

/** One thing a CLI really printed, kept with the evidence that it did. */
interface Observation {
  /** The pattern, anchored on words rather than substrings. */
  readonly pattern: RegExp;
  /** Which CLI said it, and the version that said it. */
  readonly seenOn: string;
  /** When somebody met it. */
  readonly seenAt: string;
  /** The output, near enough verbatim to recognise. */
  readonly verbatim: string;
}

/**
 * Observed quota blocks.
 *
 * Adding one is not a code change so much as a filing: paste what the CLI
 * said, name the version, date it. Nothing here may be written from
 * documentation, from a changelog, or from a guess about how the sentence
 * probably goes.
 */
const OBSERVED: readonly Observation[] = [
  {
    // Met on Todd's Mac; the same message the outside report quoted when it
    // showed Codex reporting failure while exiting zero.
    pattern: /\busage limit\b/iu,
    seenOn: "codex-cli 0.149.1",
    seenAt: "2026-09-03",
    verbatim:
      "You've hit your usage limit. Try again at Sep 3rd, 2026 8:28 AM.",
  },
];

/**
 * When the CLI says it will be back.
 *
 * A reason without a clock turns "wait" into "give up" — somebody told their
 * service is blocked and not told for how long has no way to tell an hour from
 * a week, and reaches for the remedy that always looks available: turning it
 * off.
 *
 * Read only from observed shapes, and absent is a perfectly good answer. A
 * wrong time is worse than none: it would have somebody come back to a machine
 * that is still blocked, having been told it would not be.
 */
function until(message: string, now: number): number | undefined {
  // "Try again at Sep 3rd, 2026 8:28 AM." — codex-cli 0.149.1, 2026-09-03.
  const at = /\btry again at ([^.]+)\./iu.exec(message);
  if (at?.[1] === undefined) return undefined;
  // The ordinal suffix is not something `Date` parses; nothing else in the
  // string needs touching.
  const parsed = Date.parse(at[1].replace(/(\d+)(st|nd|rd|th)\b/iu, "$1"));
  if (Number.isNaN(parsed)) return undefined;
  // A time already past is a time we read wrong — a block that ended before
  // we were told about it is not a block. Silence beats a confident mistake.
  return parsed > now ? parsed : undefined;
}

export interface QuotaBlock {
  /** The CLI's own words, for the owner and nobody else. */
  readonly detail: string;
  /** Epoch ms the CLI expects to be back, when it said so. */
  readonly until?: number;
}

/**
 * Classify one failure diagnostic.
 *
 * `undefined` means "not a quota block as far as we know", which is the answer
 * for everything the corpus has not met. Callers must already have decided the
 * call failed: this reads a diagnostic, never an answer.
 */
export function quotaBlock(
  message: string,
  now: number,
): QuotaBlock | undefined {
  if (!OBSERVED.some((seen) => seen.pattern.test(message))) return undefined;
  const at = until(message, now);
  return { detail: message, ...(at === undefined ? {} : { until: at }) };
}

/** What the corpus holds, for the test that proves it is reachable at all. */
export const observedQuotaCorpus = OBSERVED;

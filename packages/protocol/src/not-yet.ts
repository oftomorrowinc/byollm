import { JobKind } from "./kinds.js";

/**
 * What BYOLLM does not do yet — one list, rendered on every surface.
 *
 * Todd, 2026-10-06: the sites did not call out the limits the way the
 * open-sourcing post did. The post's sentence is the source of the words; this
 * is the source of the list. The README's "Not yet", byo-llm.com's "What it
 * doesn't do yet" and byollm.cloud render from here, and a test on each
 * surface fails when its copy and this disagree.
 *
 * Hand-written beside `about.ts` rather than inside it, because that file is
 * generated from the ABOUT markdown and this one derives from code.
 */
export interface NotYet {
  /** The missing thing, phrased so "no …" reads as a sentence. */
  readonly what: string;
  /** What that means for you, when the name alone does not say. */
  readonly detail?: string;
}

/** "a", "a and b", "a, b and c". */
const and = (items: readonly string[]): string =>
  items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.slice(-1).join("")}`;

/**
 * The list for a given set of job kinds. The kinds entry is derived, not
 * typed: a third kind changes what every surface says the day it lands.
 * Exported for the test that proves it; surfaces read {@link NOT_YET}.
 */
export function notYetFor(kinds: readonly string[]): readonly NotYet[] {
  return Object.freeze([
    { what: "tool use" },
    { what: "access to your local files" },
    { what: "streaming", detail: "a result comes back whole" },
    {
      what: `job kinds beyond ${and(kinds)}`,
      detail: "no embeddings or images yet",
    },
    {
      what: "jobs while your device is offline",
      detail: "your device has to be online for your jobs to run",
    },
  ]);
}

/** What BYOLLM does not do yet, in the post's order. */
export const NOT_YET: readonly NotYet[] = notYetFor(JobKind.options);

export const NOT_YET_LEDE = "Things we know are limiting right now:";

export const NOT_YET_TAIL =
  "We have plans for every one of these, and we are building in public.";

/** The list as one paragraph — the post's sentence, from the list. */
export function notYetSentence(list: readonly NotYet[] = NOT_YET): string {
  const items = list.map(
    ({ what, detail }) => `no ${what}${detail ? ` (${detail})` : ""}`,
  );
  return `${NOT_YET_LEDE} ${and(items)}. ${NOT_YET_TAIL}`;
}

/**
 * One entry as a list line: "Streaming — a result comes back whole".
 *
 * Every list surface renders this, so the README, byo-llm.com and
 * byollm.cloud cannot each phrase an entry their own way.
 */
export function notYetLine({ what, detail }: NotYet): string {
  const head = what.charAt(0).toUpperCase() + what.slice(1);
  return detail ? `${head} — ${detail}` : head;
}

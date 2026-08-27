import { z } from "zod";
import { JOB_KINDS, JobKind } from "./kinds.js";

/**
 * What a site says it needs — byollm_016 Amendment L.
 *
 * A site declares **purposes**, and each purpose lists the job kinds it uses.
 * A person then maps each purpose to one of their own services, on the consent
 * screen, and that mapping *is* the consent. The control plane joins the two
 * at claim time and signs the result into a grant.
 *
 * ## Why a site declares needs instead of naming services
 *
 * Because it cannot name one. The site's vocabulary is its own purposes; the
 * person's vocabulary is their services; and the two never meet. A site asks
 * for "writing assistant, llm.chat" and learns only whether that slot is
 * satisfiable — never which model answered, never whose machine, never even
 * the name of the service. Key-vs-value reaches its strongest form here: the
 * site cannot describe what it wants *or* name it, only ask for what it
 * declared.
 *
 * ## Keys are ids; labels are prose
 *
 * They are separate fields and nothing derives one from the other, which is
 * the amendment's ruling and worth restating where somebody will read it. A
 * key travels on every job and is what mappings are stored against, so it is
 * stable-or-nothing: renaming one deletes a purpose and creates another,
 * unmapping everybody who had chosen for it. A label is changeable whenever
 * the site likes and is the **only** thing a consent screen renders.
 */

/**
 * The purpose a site gets when it declares no purposes of its own.
 *
 * Reserved, and refused by {@link Manifest} rather than by whatever handles
 * registration. A site with a single undifferentiated use has one purpose —
 * everything it does — and that purpose needs an id because mappings are
 * keyed by one. An id taken from the site's own vocabulary would collide the
 * day it declared a real purpose of the same name.
 *
 * **Never rendered.** "default → your Claude" tells a person nothing; a
 * consent screen shows the site's own name for this slot, because that is
 * what a single-purpose site's one purpose actually is.
 */
export const RESERVED_PURPOSE = "default";

/**
 * The characters a string may contain when a person will read it to decide.
 *
 * The purpose **key** got a strict slug regex the day it was written, because
 * it travels. The **label** got a length cap and nothing else — and it is the
 * field the whole consent decision rests on: the module below says it is "the
 * only thing a consent screen renders", and it reaches notification emails and
 * daemon logs too.
 *
 * Three classes are refused, each because it makes rendered text mean
 * something other than what was declared:
 *
 * - **Control characters.** A newline lets one label spoof the rows around it
 *   on a consent screen or in an email; ANSI escapes corrupt a terminal when a
 *   CLI prints the purpose; NUL truncates in whatever reads it next.
 * - **Bidi controls.** `U+202E` and its relatives reorder what follows, so
 *   "Read your files‮ — tnatsissa gnitirW" renders as something the site did
 *   not write. This is the attack that matters here: it changes the sentence a
 *   person consents to, invisibly, with every character individually innocent.
 * - **Zero-width characters.** They pad a label past nothing visible, which is
 *   how two purposes come to look identical on the screen where telling them
 *   apart is the point.
 *
 * Refused at parse rather than escaped at render. There are four renderers
 * already — consent screen, email, CLI, logs — and an escaping rule has to be
 * right in all of them; a parse rule is right once.
 *
 * ## What this costs, said plainly
 *
 * `\p{Cf}` takes zero-width joiners with it, so a multi-person emoji in a
 * label is refused. That is a real cost and it is the right trade here: the
 * same codepoint that joins an emoji family pads two labels into looking
 * identical, and this is the field where telling them apart is the decision.
 *
 * `\p{Cn}` — unassigned — is deliberately **not** refused, though it looks
 * like it belongs. Which codepoints are unassigned depends on the Unicode
 * version of whatever engine is parsing, so including it would make a manifest
 * valid on one deployment and refused on another, drifting silently as
 * runtimes update. A rule whose answer depends on the reader is not a rule.
 */
const RENDERABLE = /^[^\p{Cc}\p{Cf}\p{Cs}\p{Co}]+$/u;

const renderable = (max: number, what: string) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(
      RENDERABLE,
      `a ${what} is text a person reads — no control characters, ` +
        "direction overrides or zero-width padding",
    )
    // A label of spaces passes every rule above and renders as an empty row.
    .refine((value) => value.trim() !== "", {
      message: `a ${what} cannot be blank`,
    });

/**
 * A purpose key: a slug, and stable for the life of the purpose.
 *
 * Constrained because it is an **id on a signed document**, not a display
 * string. Something a site can print, a person can recognise in a URL, and
 * nobody has to escape. The label carries everything expressive.
 */
const PurposeKey = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "a purpose key is a lowercase slug — letters, digits and hyphens",
  )
  .max(64);

export const Purpose = z
  .object({
    /**
     * What a person reads on the consent screen. The only rendered field.
     *
     * Declared rather than derived from the key, because a key is a
     * compromise between machines and this is not. "Writing Assistant" is
     * what somebody understands; `writing-assistant` is what travels.
     */
    label: renderable(80, "label"),
    /** One line of context for the consent screen. Optional. */
    description: renderable(280, "description").optional(),
    /**
     * The kinds this purpose uses.
     *
     * A purpose may span kinds, and a mapping is per (purpose, kind) — so a
     * person can send this purpose's chat to one service and its generation
     * to another. Listing a kind here is what makes that slot appear.
     */
    kinds: z
      .array(JobKind)
      .min(1)
      /**
       * Bounded by the vocabulary itself, and unique.
       *
       * This was `.min(1)` and nothing else: one purpose could declare
       * `["llm.chat"]` repeated a million times, every element individually
       * valid, and the consent screen renders one slot per (purpose, kind).
       *
       * The maximum is derived rather than chosen — a purpose cannot need
       * more kinds than exist, so `JOB_KINDS.length` is the honest ceiling
       * and it grows with the protocol instead of becoming a number somebody
       * has to remember to raise.
       */
      .max(JOB_KINDS.length)
      .refine((kinds) => new Set(kinds).size === kinds.length, {
        message: "a purpose lists each kind once",
      }),
  })
  .strict();
export type Purpose = z.infer<typeof Purpose>;

/**
 * Everything a site needs, by purpose key.
 *
 * At least one purpose: a site that declares none is a site that can enqueue
 * nothing, and accepting it would mean the first refusal a person saw came
 * from a job rather than from registration.
 */
/**
 * How many purposes one site may declare.
 *
 * There was no bound at all: a site could declare fifty thousand, each one
 * individually valid, and the consent screen renders a slot per (purpose,
 * kind) — so the page that *is* the consent mechanism becomes unusable, and
 * the notification mail that enumerates slots grows with it.
 *
 * Thirty-two is chosen rather than derived, and the number is an argument: a
 * purpose is a thing a person reads and decides about one at a time, and a
 * screen asking more than about thirty separate questions has stopped being a
 * consent screen whatever it renders. Of Tomorrow Press declares five. A site
 * that genuinely needs more has a product question to answer before it has a
 * schema one.
 */
export const MAX_PURPOSES = 32;

export const Manifest = z
  .record(PurposeKey, Purpose)
  .refine((manifest) => Object.keys(manifest).length > 0, {
    message: "a manifest declares at least one purpose",
  })
  .refine((manifest) => Object.keys(manifest).length <= MAX_PURPOSES, {
    message:
      `a manifest declares at most ${String(MAX_PURPOSES)} purposes — a ` +
      "consent screen is a set of questions somebody answers one at a time",
  })
  .refine((manifest) => !(RESERVED_PURPOSE in manifest), {
    message:
      `"${RESERVED_PURPOSE}" is reserved for a site that declares no ` +
      "purposes of its own — give this one a name from your own vocabulary",
  });
export type Manifest = z.infer<typeof Manifest>;

/**
 * The manifest a site with no declared purposes is treated as having.
 *
 * The sugar in Amendment L, made explicit rather than special-cased
 * downstream: everything after this point sees a manifest with one purpose,
 * so no consent screen, mapping table or resolver needs a branch for the
 * flat-list case.
 *
 * The label is the caller's — a site's own name — because it is the one thing
 * that can make "everything this site does" read as a sentence about a
 * particular site rather than about software in general.
 */
export function singlePurposeManifest(input: {
  readonly label: string;
  readonly kinds: readonly JobKind[];
}): Manifest {
  return {
    [RESERVED_PURPOSE]: { label: input.label, kinds: [...input.kinds] },
  };
}

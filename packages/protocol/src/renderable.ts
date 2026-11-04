import { z } from "zod";

/*
 * Moved out of `manifest.ts` so a tool declaration (`tools.ts`) can hold its
 * description to the same rule without an import cycle: the consent screen
 * renders a tool's description exactly as it renders a purpose's label
 * (byollm_012 §4).
 */

/**
 * The characters a string may contain when a person will read it to decide.
 *
 * The purpose **key** got a strict slug regex the day it was written, because
 * it travels. The **label** got a length cap and nothing else — and it is the
 * field the whole consent decision rests on: `manifest.ts` says it is "the
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

export const renderable = (max: number, what: string): z.ZodString =>
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

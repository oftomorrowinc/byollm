import { z } from "zod";
import { JOB_KINDS, JobKind } from "./kinds.js";
import { renderable } from "./renderable.js";
import {
  TOOL_LIMITS,
  ToolName,
  ToolSpec,
  toolsDigest,
  type ToolLimits,
} from "./tools.js";

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

/**
 * How a purpose's work is routed — RESERVED at 0.1.0, not yet acted on (B236).
 *
 * ## Why a key nothing reads is the highest-leverage thing in this file
 *
 * {@link Purpose} is `.strict()`, and that is right: a manifest is written by
 * hand by a third party, and a typo'd key that is silently ignored is a site
 * whose consent screen quietly says something other than what its author
 * wrote. The cost of `.strict()` is that **there is no such thing as an
 * additive change to it.** A key added in 1.4 is rejected by every validator
 * built before 1.4, and the OSS repository ships the server — so those
 * validators will exist, on machines nobody can upgrade, run by people who
 * have no idea a key was added.
 *
 * The window in which this field can be introduced is therefore now: before
 * the wire is declared stable, while every validator in existence is ours.
 * After that the shape is load-bearing whether or not anything reads it.
 *
 * So the values are the ruled ones (B232 house lanes, B233 fallback lanes),
 * the schema refuses anything else, and no code branches on it. A site may
 * write `routing` today and get exactly the behaviour it gets without it,
 * which is the point: the manifest it writes today is still valid the day
 * the lanes land.
 *
 * ## What each value will mean, when something reads it
 *
 * - `user-choice` — the person maps this purpose to one of their own
 *   services, and that mapping is the consent. Today's only behaviour, and
 *   the default for a manifest that says nothing.
 * - `site-fixed` — the site pays for and pins the service (B232's house
 *   lane). The person is told, and consents to that rather than to a mapping.
 * - `user-first-with-fallback` — the person's service if they have one, the
 *   site's if they do not (B233).
 *
 * **The commitment attached to those last two** is written in the lock
 * document rather than here, because it binds behaviour this file cannot
 * enforce: a hub that does not implement a lane treats the purpose as
 * `user-choice` and SAYS SO in a field rather than silently downgrading it,
 * and a lane added later carries its own disclosure and never weakens an
 * existing lane's promise.
 */
export const PurposeRouting = z.enum([
  "user-choice",
  "site-fixed",
  "user-first-with-fallback",
]);
export type PurposeRouting = z.infer<typeof PurposeRouting>;

/**
 * What a purpose that does not say means.
 *
 * Named once, here, rather than written into the schema as `.default()`. A
 * zod default is applied at PARSE, which would mean every manifest read by
 * anything becomes a manifest with a `routing` key — and a hub that parses a
 * site's manifest, stores it and serves it back would be handing a key to
 * readers that predate it. The thing this field exists to avoid, performed by
 * the field itself.
 *
 * Parsing stays shape-preserving; the default is applied where the value is
 * USED, by {@link routingOf}.
 */
export const DEFAULT_ROUTING: PurposeRouting = "user-choice";

/**
 * The routing a purpose asks for, defaulted.
 *
 * The one place the absent case is answered, so that when B232 and B233 do
 * act on this there is no second opinion about what "not stated" meant.
 */
export function routingOf(purpose: Purpose): PurposeRouting {
  return purpose.routing ?? DEFAULT_ROUTING;
}

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
    /**
     * How this purpose is routed — RESERVED, validated, not acted on (B236).
     *
     * Optional rather than defaulted, so that a manifest without it parses to
     * a manifest without it. See {@link PurposeRouting} for why a key nothing
     * reads is worth adding before launch, and {@link routingOf} for the one
     * place "not stated" is answered.
     */
    routing: PurposeRouting.optional(),
    /**
     * The site's tools for this purpose, by name — byollm_012 §4.
     *
     * Required when `kinds` lists `llm.tools` and refused otherwise. 1 to 16.
     * Each description is what the consent screen lists on the purpose's
     * `llm.tools` row (§10), so it follows the renderable rules a label does.
     * The tools run on the site, never on the device
     * ({@link MUSTS.TOOLS_RUN_AT_SITE}).
     */
    tools: z
      .record(ToolName, ToolSpec)
      .refine(
        (tools) => {
          const count = Object.keys(tools).length;
          return count >= 1 && count <= TOOL_LIMITS.maxTools;
        },
        {
          message: `a purpose declares 1 to ${String(TOOL_LIMITS.maxTools)} tools`,
        },
      )
      .optional(),
    /**
     * The purpose's call budget, 1 to 20 — the number the consent screen
     * states (§10). Unset means {@link TOOL_LIMITS.defaultMaxToolCalls}, applied
     * where it is used ({@link toolLimitsOf}) rather than at parse, for the
     * reason {@link DEFAULT_ROUTING} gives. Only with `llm.tools`.
     */
    maxToolCalls: z
      .number()
      .int()
      .min(1)
      .max(TOOL_LIMITS.maxToolCalls)
      .optional(),
    /**
     * How much tool-result text one job of this purpose may read, 1 to
     * 256,000 — what makes the context cap part of the job's size before it
     * runs (§8). Unset means {@link TOOL_LIMITS.defaultMaxToolResultChars}.
     * Only with `llm.tools`.
     */
    maxToolResultChars: z
      .number()
      .int()
      .min(1)
      .max(TOOL_LIMITS.maxToolResultChars)
      .optional(),
  })
  .strict()
  .superRefine((purpose, ctx) => {
    const tools = purpose.kinds.includes("llm.tools");
    if (tools && purpose.tools === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["tools"],
        message: "a purpose that lists llm.tools declares its tools",
      });
    }
    if (!tools) {
      for (const field of [
        "tools",
        "maxToolCalls",
        "maxToolResultChars",
      ] as const) {
        if (purpose[field] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `${field} belongs to a purpose that lists llm.tools`,
          });
        }
      }
    }
  });
export type Purpose = z.infer<typeof Purpose>;

/**
 * A purpose's two tool limits, defaulted — byollm_012 §4.
 *
 * The one place "not stated" is answered, so the consent screen's number,
 * the payload's `purposeLimits` and the digest the device compares are the
 * same number.
 */
export function toolLimitsOf(purpose: Purpose): ToolLimits {
  return {
    maxToolCalls: purpose.maxToolCalls ?? TOOL_LIMITS.defaultMaxToolCalls,
    maxToolResultChars:
      purpose.maxToolResultChars ?? TOOL_LIMITS.defaultMaxToolResultChars,
  };
}

/**
 * The `toolsDigest` of a purpose as the manifest of record declares it, or
 * `undefined` for a purpose without `llm.tools` — byollm_012 §4.
 *
 * What the control plane signs into an `llm.tools` grant, and what the hub
 * compares an enqueue's digest with (`tools-manifest-mismatch`).
 */
export function purposeToolsDigest(purpose: Purpose): string | undefined {
  if (purpose.tools === undefined) return undefined;
  return toolsDigest({ tools: purpose.tools, ...toolLimitsOf(purpose) });
}

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

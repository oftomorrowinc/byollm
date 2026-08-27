import { z } from "zod";
import { JobKind } from "./kinds.js";

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

export const Purpose = z
  .object({
    /**
     * What a person reads on the consent screen. The only rendered field.
     *
     * Declared rather than derived from the key, because a key is a
     * compromise between machines and this is not. "Writing Assistant" is
     * what somebody understands; `writing-assistant` is what travels.
     */
    label: z.string().min(1).max(80),
    /** One line of context for the consent screen. Optional. */
    description: z.string().min(1).max(280).optional(),
    /**
     * The kinds this purpose uses.
     *
     * A purpose may span kinds, and a mapping is per (purpose, kind) — so a
     * person can send this purpose's chat to one service and its generation
     * to another. Listing a kind here is what makes that slot appear.
     */
    kinds: z.array(JobKind).min(1),
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
export const Manifest = z
  .record(PurposeKey, Purpose)
  .refine((manifest) => Object.keys(manifest).length > 0, {
    message: "a manifest declares at least one purpose",
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

import { SealedOutcome, type JobOutcome } from "@byollm/protocol";

/**
 * Open a sealed outcome, once, for both lanes — B064 step 4's prerequisite.
 *
 * `handlers.ts` and `cloud.ts` each did the same three things to a decrypted
 * envelope: parse the JSON, validate it as a {@link SealedOutcome}, and check
 * the clear-text disposition against what was sealed. Two copies of one
 * decision, and the only difference between them was how they reported a
 * failure — a refusal message on the direct lane, `null` on the cloud lane.
 *
 * **Extracted BEFORE the shape changes rather than after.** Step 4 adds a
 * field to what the daemon seals, and a field added to two independent
 * readers is a field added correctly to one of them: the direct lane and the
 * cloud lane would agree until the day they did not, and the lane that broke
 * is the one Kevin is on. Instruction 9 — one definition, both ends — and
 * here both ends are two files in the same package.
 *
 * The disposition check has to live inside this rather than beside it. It is
 * the reason the function exists at all: byollm_009 §6.1 puts it here because
 * **this is the only party that can open the envelope**, so it is the only
 * place the relay's clear-text routing hint can be checked against the truth.
 * Left to the callers it would be a step somebody forgets in the third lane.
 */
export type OpenedOutcome =
  | { readonly ok: true; readonly value: SealedOutcome }
  | { readonly ok: false; readonly why: string };

export function openSealedOutcome(input: {
  /** The decrypted envelope body. */
  readonly plaintext: string;
  /**
   * What the relay was told this job became.
   *
   * Checked, never trusted: it travelled in the clear and the sealed copy is
   * the one the device signed.
   */
  readonly disposition: JobOutcome["outcome"];
}): OpenedOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.plaintext);
  } catch {
    return { ok: false, why: "the sealed result was not valid JSON" };
  }

  const sealed = SealedOutcome.safeParse(parsed);
  if (!sealed.success) {
    return { ok: false, why: "the sealed result was not an outcome" };
  }

  if (sealed.data.outcome.outcome !== input.disposition) {
    return {
      ok: false,
      why: "the declared disposition is not the one that was sealed",
    };
  }

  return { ok: true, value: sealed.data };
}

import type { JobKind } from "@byollm/protocol";

/**
 * The kinds a 0.1.4 upstream has never heard of — byollm_021 §Rollout R2.
 *
 * `Capability.kind` is a closed enum, and a 0.1.4 upstream parses the
 * heartbeat strictly: one of these in the advertisement and the whole
 * heartbeat is refused, so the device goes dark for everything, not only for
 * the new kind. Guard (b) is what keeps that from happening, and these are
 * the kinds it may take out of a retry.
 *
 * Named, not derived: the C060 test derives the same list from the 0.1.4
 * protocol published on npm and compares, so this cannot drift from what a
 * 0.1.4 upstream actually refuses.
 */
export const KINDS_AFTER_0_1_4: readonly JobKind[] = Object.freeze([
  "llm.tools",
  "llm.vision",
  "llm.image",
]);

export function isAfter014(kind: JobKind): boolean {
  return KINDS_AFTER_0_1_4.includes(kind);
}

/**
 * What the owner is told when guard (b)'s retry succeeded — R2's sentence:
 * *"<upstream> runs byollm 0.1.4 or older and cannot carry the site's tools —
 * update it, or turn tools off for `qwen`"*.
 *
 * Only ever said after the retry without the new kinds was ACCEPTED, which
 * is the evidence that they were the cause. A refusal the retry did not cure
 * blames no version.
 */
export function predatesMessage(input: {
  readonly upstream: string;
  readonly kinds: readonly JobKind[];
  readonly services: readonly string[];
}): string {
  const tools = input.kinds.includes("llm.tools");
  const images = input.kinds.some(
    (k) => k === "llm.vision" || k === "llm.image",
  );
  const what = [
    ...(tools ? ["the site's tools"] : []),
    ...(images ? ["images"] : []),
  ].join(" or ");
  const off = [...(tools ? ["tools"] : []), ...(images ? ["images"] : [])].join(
    " and ",
  );
  const services = input.services.map((s) => `\`${s}\``).join(", ");
  return (
    `${input.upstream} runs byollm 0.1.4 or older and cannot carry ${what} ` +
    `— update it, or turn ${off} off for ${services}`
  );
}

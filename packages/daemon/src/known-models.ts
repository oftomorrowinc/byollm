import type { BackendId } from "@byollm/protocol";

/**
 * Models a backend's CLI is known to accept — byollm_017 ruling 3.
 *
 * **Suggestions, and nothing stronger.** The promise this product makes is
 * that a model released this morning works this morning, which a frozen list
 * anywhere a person picks from breaks on the first day it matters. So free
 * text is always allowed, and what makes it safe is ruling 2: a candidate is
 * probed against the real CLI before it is written, so "found is not works"
 * is answered by the machine rather than by a list somebody maintains.
 *
 * These ship with the daemon and are announced with the capability, so the
 * dashboard shows what *this device's* CLI knows rather than what the cloud
 * last heard about. A list held cloud-side would be one more thing to update
 * on release day and wrong for everybody who had not upgraded.
 *
 * Aliases first, dated ids after. The aliases are what people type and what
 * survives a model refresh; the dated ids are what somebody pins when they
 * need this month's behaviour not to move under them.
 */
const KNOWN: Partial<Record<BackendId, readonly string[]>> = Object.freeze({
  "claude-cli": Object.freeze([
    "opus",
    "sonnet",
    "haiku",
    "claude-opus-4-1",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
  ]),
  "codex-cli": Object.freeze(["gpt-5-codex", "gpt-5", "o4-mini"]),
});

/**
 * What to suggest for a backend, or nothing.
 *
 * An empty list is the honest answer for a local server: it serves whatever
 * has been pulled onto that machine, which this module cannot know and the
 * server itself can be asked. A reader must not render an empty list as "no
 * models available" — it is "nothing to suggest", which is a different fact
 * and the reason the wire field is optional rather than defaulted to `[]`.
 */
export function knownModelsFor(id: BackendId): readonly string[] {
  return KNOWN[id] ?? [];
}

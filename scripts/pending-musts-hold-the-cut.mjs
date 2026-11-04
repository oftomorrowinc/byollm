#!/usr/bin/env node
/**
 * No release is tagged while an image MUST is `pending`, and no stable one
 * while any MUST is — #7053, as amended by Owl (#55886 point 3).
 *
 *   node scripts/pending-musts-hold-the-cut.mjs        # the repo's version
 *   node scripts/pending-musts-hold-the-cut.mjs 0.1.5-beta.1
 *
 * ## Why
 *
 * byollm_012 §12 and byollm_021 §10 were registered by the protocol card
 * before the features they bind, so their MUSTs are `pending`: adjudicated,
 * with their checks assigned, and verified by nothing yet. The kit forces the
 * promotion when a check is built (a check claiming a `pending` MUST is
 * miscovered, and so is a daemon test citing one). This is the other side:
 * the check that never got built.
 *
 * ## The two rules, and why the beta is not exempt
 *
 * - **Any cut, prerelease included, while a MUST that is not a tool MUST is
 *   pending.** byollm_021 §Rollout R2 step 2 is where the blob endpoints go
 *   live on the hub, Signals and Press, on `0.1.5-beta.1`. A beta carrying a
 *   `pending` `BLOBS_SEALED` is the blob path live on three servers with
 *   nothing having checked that a store holds no key.
 * - **A stable cut while any MUST is pending.** Tools are the one thing the
 *   cut line lets ride on the beta: R2 rules that if they have not passed
 *   review by 2026-12-01, `llm.tools` comes out before the clean release. The
 *   card that does that (R8 card 10) takes the tool MUSTs and their table rows
 *   out with the kind; otherwise this refuses the release the cut line was
 *   written to let through, which is the right refusal until somebody has.
 *
 * A tool MUST is one whose `source` is byollm_012.
 *
 * ## How it reads the registry
 *
 * From `packages/protocol/src/musts.ts` as text, because `tag.sh` runs before
 * anything is built and a stale `dist` would answer for a different tree.
 * Its test compares this reading with the registry's own
 * `mustsVerifiedBy("pending")`, so the two cannot drift apart unnoticed.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Every `pending` MUST in the source, with whether it is a tool MUST — one
 * whose `source` is byollm_012, which the cut line lets ride on a beta.
 */
export function pendingMustsIn(source) {
  const pending = [];
  const blocks = source.split(/\n {2}(?=[A-Z][A-Z0-9_]+: must\(\{)/u);
  for (const block of blocks) {
    const id = /^([A-Z][A-Z0-9_]+): must\(\{/u.exec(block)?.[1];
    if (id === undefined) continue;
    // The entry's own field, not one inside its `planned` record.
    const own = block.replace(/planned:\s*\{[\s\S]*?\}\s*,?/u, "");
    if (!/verifiedBy:\s*"pending"/u.test(own)) continue;
    const tool = /source:\s*"byollm_012\b/u.test(own);
    pending.push({ id, tool });
  }
  return pending.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** How many MUST entries the source declares — the reader's own control. */
/**
 * MUSTs of byollm_012 and byollm_021 that are verified, and still owe checks
 * another card builds — #7055.
 *
 * A MUST enforced by several parties is promoted when the first party's
 * checks land: card 3 built the daemon's half of `TOOLS_BUDGETED` and
 * `TOOLS_MATCH_CONSENT`, and the relay's, the site SDK's and the hub's (C039,
 * C040, C047) are cards 2 and 4's, recorded in `planned`. Promotion took the
 * MUST out of {@link pendingMustsIn}, so without this a stable cut would pass
 * with two of §8's "three counters, on purpose" unchecked — the gate reading
 * the kind and not what the kind still owes.
 */
export function plannedMustsIn(source) {
  const planned = [];
  const blocks = source.split(/\n {2}(?=[A-Z][A-Z0-9_]+: must\(\{)/u);
  for (const block of blocks) {
    const id = /^([A-Z][A-Z0-9_]+): must\(\{/u.exec(block)?.[1];
    if (id === undefined) continue;
    const record = /planned:\s*\{[\s\S]*?checks:\s*\[([^\]]*)\]/u.exec(block);
    if (record === null) continue;
    const own = block.replace(/planned:\s*\{[\s\S]*?\}\s*,?/u, "");
    if (/verifiedBy:\s*"pending"/u.test(own)) continue;
    if (!/source:\s*"byollm_0(?:12|21)\b/u.test(own)) continue;
    const checks = [...(record[1] ?? "").matchAll(/"([^"]+)"/gu)].map(
      (m) => m[1],
    );
    const tool = /source:\s*"byollm_012\b/u.test(own);
    planned.push({ id, tool, checks });
  }
  return planned.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function mustBlocksIn(source) {
  return [...source.matchAll(/\n {2}[A-Z][A-Z0-9_]+: must\(\{/gu)].length;
}

/** A stable version has no prerelease part. */
export function isStable(version) {
  return /^\d+\.\d+\.\d+$/u.test(version);
}

/** Why `version` may not be tagged, or `null` when it may. */
export function refusal(version, pending, planned = []) {
  const blocking = isStable(version)
    ? pending
    : pending.filter((must) => !must.tool);
  const owing = isStable(version)
    ? planned
    : planned.filter((must) => !must.tool);
  if (blocking.length === 0 && owing.length === 0) return null;
  if (blocking.length === 0) {
    const ids = owing
      .map((must) => `${must.id} (${must.checks.join(", ")})`)
      .join(", ");
    return (
      `refusing to tag ${version}: ${String(owing.length)} MUST(s) still ` +
      `owe checks another party builds — ${ids}.\n` +
      "  Each is verified on one side and planned on another. Build the " +
      "planned\n  checks and take them out of `planned`, or take the " +
      "feature out of this release."
    );
  }
  const ids = blocking.map((must) => must.id).join(", ");
  return (
    `refusing to tag ${version}: ${String(blocking.length)} MUST(s) are ` +
    `still pending — ${ids}.\n` +
    "  A pending MUST has its checks assigned and nothing verifying it. " +
    "Build\n  the checks and promote it (its spec table's Verified cell " +
    "moves too), or\n  take the feature it binds out of this release. " +
    (isStable(version)
      ? "A stable release carries none."
      : "Only byollm_012's tool MUSTs may ride on a prerelease.")
  );
}

function main() {
  const version =
    process.argv[2] ??
    JSON.parse(readFileSync(`${ROOT}packages/protocol/package.json`, "utf8"))
      .version;
  const source = readFileSync(`${ROOT}packages/protocol/src/musts.ts`, "utf8");
  const pending = pendingMustsIn(source);
  const planned = plannedMustsIn(source);
  const why = refusal(version, pending, planned);
  if (why !== null) {
    console.error(why);
    process.exit(1);
  }
  console.log(
    pending.length === 0 && planned.length === 0
      ? `no MUST is pending; ${version} may be tagged.`
      : `${String(pending.length + planned.length)} tool MUST(s) pending or owing checks; ${version} is a prerelease and may carry them.`,
  );
}

if (realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  main();

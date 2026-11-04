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
export function mustBlocksIn(source) {
  return [...source.matchAll(/\n {2}[A-Z][A-Z0-9_]+: must\(\{/gu)].length;
}

/** A stable version has no prerelease part. */
export function isStable(version) {
  return /^\d+\.\d+\.\d+$/u.test(version);
}

/** Why `version` may not be tagged, or `null` when it may. */
export function refusal(version, pending) {
  const blocking = isStable(version)
    ? pending
    : pending.filter((must) => !must.tool);
  if (blocking.length === 0) return null;
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
  const pending = pendingMustsIn(
    readFileSync(`${ROOT}packages/protocol/src/musts.ts`, "utf8"),
  );
  const why = refusal(version, pending);
  if (why !== null) {
    console.error(why);
    process.exit(1);
  }
  console.log(
    pending.length === 0
      ? `no MUST is pending; ${version} may be tagged.`
      : `${String(pending.length)} tool MUST(s) pending; ${version} is a prerelease and may carry them.`,
  );
}

if (realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  main();

import type { DaemonHeartbeat } from "./heartbeat.js";
import { noteNamesThisProgram, readAppNote } from "./app-note.js";
import type { ServicePlatform } from "./service.js";

/**
 * `byollm status` says when the BYOLLM app's own Node is older than this
 * release calls safe — #11052, ruled on #10660: "C for the first version.
 * The warning is only for a Node our installer put there, never a person's
 * own."
 *
 * ## The number
 *
 * The lowest Node this release calls safe. It is NOT `engines`, and nothing
 * but this file reads it: `engines` applies to every install, so raising it
 * would refuse updates on a person's own Node (Owl's point 2 on #10660),
 * while this number only ever produces a sentence about a Node the app
 * installed.
 *
 * It starts at the `engines` floor, so on the day it ships nothing is warned
 * about. Raising it is a release step — docs/releasing.md says to check
 * Node's security releases and set it. `app-node.test.ts` holds it at or
 * above the `engines` floor.
 */
export const LOWEST_SAFE_NODE = "22.14.0";

/** `22.13.1` or `v22.13.1` as three numbers; anything else is no version. */
function parts(version: string): readonly [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Is `version` older than `floor`? An unreadable version is not older: a
 * warning is a promotion, and an answer nobody can read promotes nothing.
 */
export function nodeIsOlder(version: string, floor: string): boolean {
  const have = parts(version);
  const need = parts(floor);
  if (have === undefined || need === undefined) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return (have[i] ?? 0) < (need[i] ?? 0);
  }
  return false;
}

/**
 * The app's own Node, when the daemon runs on it and it is older than
 * {@link LOWEST_SAFE_NODE}; otherwise nothing.
 *
 * "The daemon runs on it" is read from the daemon's last heartbeat, which
 * names the Node and program that wrote it — not from this process. `status`
 * is a different process: the tray runs it from the app's Node even when a
 * person has since moved the daemon to their own with `byollm start`, and a
 * person may type it from an npm install while the daemon is the app's.
 *
 * The last beat, fresh or not: it is the Node the daemon last ran on, and
 * the one its start-at-login entry starts again. A beat from a release that
 * did not record its Node says nothing, and neither does Linux, where the
 * app does not ship and the note is never read (#11051).
 */
export async function oldAppNode(input: {
  readonly notePath: string;
  readonly platform: ServicePlatform;
  readonly beat: DaemonHeartbeat | undefined;
  readonly resolve?: (path: string) => Promise<string>;
}): Promise<{ readonly version: string } | undefined> {
  const { beat, platform } = input;
  if (platform === "linux") return undefined;
  if (
    beat?.execPath === undefined ||
    beat.scriptPath === undefined ||
    beat.node === undefined
  ) {
    return undefined;
  }
  const read = await readAppNote(input.notePath);
  if (read.kind !== "note") return undefined;
  const ours = await noteNamesThisProgram(
    read.note,
    { execPath: beat.execPath, scriptPath: beat.scriptPath },
    platform,
    input.resolve,
  );
  if (!ours) return undefined;
  return nodeIsOlder(beat.node, LOWEST_SAFE_NODE)
    ? { version: beat.node }
    : undefined;
}

/** Plain `status`'s one line for it, and the only place it is worded. */
export function oldAppNodeLine(version: string): string {
  return (
    `node: this BYOLLM came with its own Node (${version}), which is older ` +
    `than this release calls safe (${LOWEST_SAFE_NODE}) — downloading BYOLLM ` +
    `again replaces it.\n`
  );
}

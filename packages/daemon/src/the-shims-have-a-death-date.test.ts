import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeartbeatRequest } from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { DAEMON_VERSION } from "./index.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { removeTemp } from "./test-support.js";

/**
 * B044 — the compat shims have a death date, and this is what makes it one.
 *
 * A deprecation with a date on a board row is a deprecation that outlives
 * everybody who remembers agreeing to it. The rename notices, `listModels`
 * behind `models`, and the vestigial `paused` wire field are all supposed to
 * go at 0.1.0. Nothing about publishing 0.1.0 would notice if they did not.
 *
 * So the version itself is the trigger. While this is a prerelease the
 * shims must be *present* — that arm is not decoration, it is the control
 * that stops this whole file from passing because a name changed somewhere
 * and every assertion quietly went vacuous. On the first non-prerelease
 * version the arms swap, and the cut cannot be tagged green until the
 * deletions land.
 *
 * The failure message is the instruction, because the person who reads it
 * will be mid-release and will not have this context.
 */
const PRERELEASE = DAEMON_VERSION.includes("-");

const SHIMS = ["install", "uninstall", "models"] as const;

describe(`the deprecation shims, at ${DAEMON_VERSION}`, () => {
  let paths: DaemonPaths;
  let out: string;
  let err: string;
  const io = (): CliIo => ({
    out: (t) => (out += t),
    err: (t) => (err += t),
  });

  beforeEach(async () => {
    paths = daemonPaths(await mkdtemp(join(tmpdir(), "byollm-death-")));
    out = "";
    err = "";
  });
  afterEach(async () => {
    await removeTemp(paths.root);
  });

  for (const shim of SHIMS) {
    it(`\`byollm ${shim}\` ${PRERELEASE ? "still works and says what to type" : "is gone"}`, async () => {
      const code = await runCli([shim], {
        paths,
        io: io(),
        service: {
          platform: "linux" as const,
          execPath: process.execPath,
          scriptPath: "/tmp/byollm-death-date-not-real",
          home: paths.root,
          uid: 0,
          run: () => Promise.resolve({ code: 1, output: "" }),
          wait: () => Promise.resolve(),
        },
      });
      if (PRERELEASE) {
        expect(err, `${shim} should still print its rename notice`).toContain(
          "is now `byollm",
        );
      } else {
        expect(
          err,
          `0.1.0 is the cut that deletes the deprecation aliases (B044).\n` +
            `Remove \`${shim}\` from RENAMED and from the switch in cli.ts,\n` +
            `and delete listModels with \`models\`.`,
        ).toContain("unknown command");
        expect(code).toBe(2);
      }
    });
  }

  it(`the vestigial \`paused\` wire field ${PRERELEASE ? "is still required" : "is gone"}`, () => {
    /**
     * The one that is not ours alone to delete. `paused` survived B043 only
     * because HeartbeatRequest is `.strict()` on both sides: a daemon that
     * stops sending a required field is refused by a hub that has not
     * upgraded, and the hub is the side that does not upgrade when a laptop
     * does. 0.1.0 is where one publish moves both, so it is where the field
     * goes — and this fires on the daemon's version, in the repo that also
     * holds the protocol, which is the only place the two are in step.
     */
    const shape = HeartbeatRequest.shape as Record<string, unknown>;
    if (PRERELEASE) {
      expect(shape).toHaveProperty("paused");
    } else {
      expect(
        Object.keys(shape),
        `0.1.0 moves the protocol and the daemon together (B044), so this\n` +
          `is where \`paused\` leaves HeartbeatRequest: nothing has set it\n` +
          `true since B043. Drop it from packages/protocol/src/wire.ts, from\n` +
          `the runner's heartbeat and the connect probe in cli.ts, and from\n` +
          `the server's records/store. Publish protocol and hub in lockstep.`,
      ).not.toContain("paused");
    }
  });
});

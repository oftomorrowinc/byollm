import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { generateKeys, publicIdentityOf, keyId } from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { runSetup, type SetupIo } from "./setup.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { noSupervisor, removeTemp } from "./test-support.js";
import { TEST_YOUR_DEVICE } from "./test-your-device.js";

/**
 * The line a new person reads first, printed exactly once.
 *
 * It printed twice in Todd's setup: `install` said it on success and setup's
 * completion line said it again, three lines apart. Among the first sentences
 * this product ever says to somebody.
 *
 * The unit tests either side of the fix assert silence in setup and noise in
 * install — separately, with `run` stubbed, so neither of them can see the
 * duplicate. **This drives the real wiring**: `runSetup` with the same
 * `(argv) => runCli(...)` bridge `commandSetup` builds in production, against a
 * hub that pairs and a supervisor that reports a live daemon. Counting the
 * occurrences is the only check that could have failed before the fix and
 * passes after it.
 */
const SITE = publicIdentityOf(generateKeys(1_800_000_000_000));

let home: string;
let paths: DaemonPaths;
let hub: Server;
let origin: string;
let out: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-once-"));
  paths = daemonPaths(home);
  out = "";
  hub = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { action?: string };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          body.action === "start"
            ? {
                deviceCode: "device-code-long-enough-to-pass",
                userCode: "RGDY-YQE8",
                verificationUrl: "https://dashboard.test/devices?pair=1",
                expiresAt: Date.now() + 600_000,
                pollIntervalMs: 500,
              }
            : {
                status: "approved",
                runnerId: "runner-1",
                owner: "owner-1",
                sites: { [keyId(SITE.identity)]: SITE },
              },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${String((hub.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    hub.close(() => {
      resolve();
    });
  });
  await removeTemp(home);
});

/** A terminal that answers yes to everything and keeps the transcript. */
function saysYes(name: string): SetupIo {
  return {
    interactive: true,
    out: (text) => {
      out += text;
    },
    err: (text) => {
      out += text;
    },
    ask: (question) =>
      Promise.resolve(question.includes("called") ? name : "y"),
  };
}

describe("the first sentence a new person reads", () => {
  it("prints once through a whole setup, not twice", async () => {
    const io: CliIo = {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        out += text;
      },
      confirm: () => Promise.resolve(true),
    };
    /* A supervisor that accepts the unit and reports a live daemon, so
       `install` reaches the success path where the sentence belongs. */
    const service = {
      ...noSupervisor(),
      platform: "darwin" as const,
      home,
      run: (command: readonly string[]) =>
        Promise.resolve({
          code: 0,
          output: command[1] === "print" ? "state = running\n\tpid = 7" : "",
        }),
      wait: () => Promise.resolve(),
    };

    await runSetup(
      paths,
      saysYes("todd-mbp-2023"),
      (id) => Promise.resolve(id === "claude-cli"),
      () => Promise.resolve([]),
      () => Promise.resolve({ installed: true, answers: true } as const),
      () => Promise.resolve(true),
      // The production bridge, verbatim from `commandSetup`.
      (argv) =>
        runCli([...argv, ...(argv[0] === "connect" ? [origin] : [])], {
          paths,
          io,
          service,
        }),
    );

    const times = out.split(TEST_YOUR_DEVICE).length - 1;
    expect(times, `printed ${String(times)} times:\n${out}`).toBe(1);
  }, 20_000);
});

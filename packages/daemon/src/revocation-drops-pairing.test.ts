import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeys, publicIdentityOf, keyId } from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { Pairings } from "./pairings.js";
import { removeTemp } from "./test-support.js";

/**
 * Revocation is durable on this side too — cloud_008 §2.3, finding 24.
 *
 * The daemon stopped on revocation and said so, and left the pinned site key
 * on disk. `byollm run` came back tomorrow and tried to reconnect to a site
 * that had withdrawn consent — refused, correctly, but the machine still held
 * a key for a relationship that had ended, and `byollm list` still showed the
 * pairing. Revocation is the site saying it is over; only one side was
 * remembering that.
 *
 * Driven through the CLI against a real server, because that is where the
 * wiring is. A unit test of `Pairings.remove` would have passed all along —
 * the method was always there, and nothing called it.
 */

let home: string;
let paths: DaemonPaths;
let server: Server;
let origin: string;
let out: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-revoke-"));
  paths = daemonPaths(home);
  out = "";
});

afterEach(async () => {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  await removeTemp(home);
});

/** A config pointing at a backend that is definitely not running. */
async function writeConfig(): Promise<void> {
  await writeFile(
    paths.config,
    JSON.stringify({
      services: {
        local: {
          model: "m",
          kinds: ["llm.generate"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:1/v1",
        },
      },
    }),
  );
}

/** An upstream that has revoked whoever is asking. */
async function revokingServer(): Promise<void> {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      // Every endpoint, heartbeat included — V1-2. This server used to answer
      // heartbeat 200 with an empty site set and let the daemon infer the
      // rest; the inference is gone, and this test would otherwise be
      // asserting that a daemon deletes its pairing over a projection that
      // happened to be empty.
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "revoked", message: "no" }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${String(
    typeof address === "object" && address ? address.port : 0,
  )}`;
}

/**
 * One paired site, as a pairing row holds it — keyed by its identity key id.
 */
const PAIRED_KEYS = generateKeys(1_800_000_000_000);
const PAIRED_SITE = publicIdentityOf(PAIRED_KEYS);
const PAIRED_SITES = { [keyId(PAIRED_SITE.identity)]: PAIRED_SITE };

/** What a heartbeat says while the pairing still stands. */
const HEARTBEAT_SITES = PAIRED_SITES;

describe("a revoked daemon", () => {
  /**
   * Twenty seconds, not vitest's default five — 2026-08-21.
   *
   * Both cases here start a real run loop against a real local server, let it
   * heartbeat, abort it, and wait for it to wind down. That is several rounds
   * of filesystem and socket work, and on the Windows runner it has now
   * exceeded five seconds twice — blocking a release the second time. The
   * default is a budget for a test that computes something; this one operates
   * a daemon.
   *
   * Raising the ceiling rather than shortening the work, deliberately: the
   * timing *is* the subject. The comment below records that an earlier version
   * hung for five seconds by assuming `run` returns on its own, and a test
   * trimmed until it fits a default is a test that stops being able to notice
   * that again.
   */
  it("drops the pairing rather than keeping a key for a dead relationship", async () => {
    await writeConfig();
    await revokingServer();
    const pairings = new Pairings(paths.pairings);
    await pairings.load();
    await pairings.put({
      origin,
      runnerId: "runner_test",
      owner: "alice",
      sites: PAIRED_SITES,
      pairedAt: 1_800_000_000_000,
    });

    // Aborted rather than left to end on its own: revocation stops the
    // *runner*, and `byollm run` can be watching several origins, so the
    // process keeps going for the others. Worth knowing — the first version
    // of this test assumed the command would return and hung for five
    // seconds instead.
    const stop = new AbortController();
    setTimeout(() => {
      stop.abort();
    }, 300);
    await runCli(["run", origin], {
      signal: stop.signal,
      paths,
      io: {
        out: (text) => {
          out += text;
        },
        err: () => undefined,
      },
    });
    const after = new Pairings(paths.pairings);
    await after.load();
    expect(after.get(origin)).toBeUndefined();
    // And the user is told what happened and how to undo it — a pairing that
    // vanishes silently is indistinguishable from one that broke.
    expect(out).toContain("pairing dropped");
    expect(out).toContain("byollm connect");
  }, 20_000);

  it("keeps the pairing when the upstream has not revoked it", async () => {
    await writeConfig();
    // The positive control. "Delete the pairing whenever the loop ends" would
    // pass the test above and lose every daemon's pairing on Ctrl-C.
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/heartbeat")) {
        res.end(
          JSON.stringify({
            sites: HEARTBEAT_SITES,
            awaitingConsent: [],
            cancel: [],
            lost: [],
            serverTime: Date.now(),
          }),
        );
        return;
      }
      res.end(JSON.stringify({ jobs: [], leaseMs: 60_000 }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    origin = `http://127.0.0.1:${String(
      typeof address === "object" && address ? address.port : 0,
    )}`;

    const pairings = new Pairings(paths.pairings);
    await pairings.load();
    await pairings.put({
      origin,
      runnerId: "runner_test",
      owner: "alice",
      sites: PAIRED_SITES,
      pairedAt: 1_800_000_000_000,
    });

    const stop = new AbortController();
    setTimeout(() => {
      stop.abort();
    }, 150);
    await runCli(["run", origin], {
      paths,
      io: { out: () => undefined, err: () => undefined },
      signal: stop.signal,
    });

    const after = new Pairings(paths.pairings);
    await after.load();
    expect(after.get(origin)).toBeDefined();
    // Same budget, same reason: this one flaked on Windows first.
  }, 20_000);
});

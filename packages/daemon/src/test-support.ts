import { once } from "node:events";
import { readdirSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { sep } from "node:path";
import {
  RESERVED_PURPOSE,
  generateKeys,
  signGrant,
  type GrantClaims,
  type SignedGrant,
} from "@byollm/protocol";
import { rm } from "node:fs/promises";

/**
 * Remove a temp directory, tolerating a write that lands mid-removal.
 *
 * `rm -rf` walks a tree; a file created during the walk makes the parent
 * non-empty again and the whole call fails with `ENOTEMPTY`. The daemon writes
 * lazily — its key file appears the first time anything asks for its identity
 * — so a late write can land after a test believes it is done.
 *
 * This failed once in CI and nowhere locally, which is the shape of every
 * cleanup race: the window is real but narrow, and a loaded machine widens
 * it. Retried rather than serialised, because the alternative is every test
 * knowing which paths make the daemon touch disk.
 */
export async function removeTemp(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  // A leaked temp directory is not worth failing a test run over.
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

import type { ServiceIo } from "./cli.js";

/**
 * A machine with no service supervisor, for tests.
 *
 * `status` asks the platform whether the daemon is supervised, and without
 * this every test that runs `status` would shell out to the host's real
 * `launchctl` or `systemctl` — a unit test that queries (and could install
 * into) whoever runs it. The runner reports the shape of a missing binary,
 * which is what a container without an init system actually returns.
 */
export function noSupervisor(): ServiceIo {
  return {
    platform: "linux",
    execPath: "/usr/bin/node",
    scriptPath: "/tmp/byollm/bin.js",
    run: () => Promise.resolve({ code: 127, output: "" }),
  };
}

/**
 * A control plane a unit test can hold — Amendment J.
 *
 * Admission is a signed document now, so a test that wants a stranger's job
 * admitted has to produce one. That is more setup than `allowlist.add` was,
 * and the extra line is the point: it is exactly what the daemon checks, so a
 * test that skips it is testing a device that refuses.
 *
 * `sign` takes the whole claim set so a test can bend any single field and
 * watch the device refuse — which is how the four checks are tested one at a
 * time rather than through whichever one happens to fire first.
 */
export function testControlPlane(now = 1_800_000_000_000): {
  readonly controlPlanePublic: string;
  readonly sign: (over: Partial<GrantClaims>) => SignedGrant;
} {
  const keys = generateKeys(now);
  let serial = 0;
  return {
    controlPlanePublic: keys.identityPublic,
    sign: (over) => {
      serial += 1;
      return signGrant(keys, {
        grantId: `grant_${String(serial)}`,
        jobId: "job_1",
        // A key id, and it always was — it sat in a field documented as the
        // control plane's namespace, which is the muddle the rename fixes.
        site: "BYOLLM-TEST-SITE-KEY-ID",
        user: "stranger",
        owner: "me",
        // What a stub carrying no purpose actually resolves to. `"testing"`
        // was a value no engine would ever sign: the engine resolves an
        // absent stub purpose to `RESERVED_PURPOSE` before signing, so a
        // default of anything else made every fixture a grant that disagreed
        // with its own job about which slot it was for.
        purpose: RESERVED_PURPOSE,
        kind: "llm.generate",
        service: "paid",
        issuedAt: Date.now(),
        ...over,
      });
    },
  };
}

/**
 * Every file under a directory, with names a check can match on — B209.
 *
 * `readdirSync(dir, { recursive: true })` yields the platform's own separator,
 * so on Windows a name reads `backends\index.ts`. Three call sites across two
 * files then tested those names against literals written with `/` —
 * `!name.startsWith("specs/")`, `name.endsWith("/index.ts")` — and every one
 * of them silently matched nothing there. **Our own `specs/` was read as a
 * published surface and reported 17 retired verbs that are deliberately
 * history; every export read as an orphan because the entry-point list came
 * back empty.** Green on macOS and Linux the whole time, red on
 * `windows-latest` for four days.
 *
 * Fixing each call site would leave three copies of one rule and the next
 * walk would be written the way the first three were. **The separator is not
 * the bug — assuming one is** — so the walk itself lives here and hands back
 * names that are already `/`.
 *
 * `relative` is what a check matches on; `path` is what opens the file, and it
 * keeps the platform's own form because that is the one the filesystem wants.
 */
export interface UnreachableBackend {
  /** Usable as a service's `baseUrl`. */
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

/**
 * A base URL with nothing behind it, on every machine.
 *
 * Tests wrote `http://127.0.0.1:1/v1` (or `:2`, or left an `ollama` service
 * on its default `:11434`) for "a backend that is definitely not running",
 * assuming a closed loopback port refuses at once. It does on macOS and on
 * CI's Linux. On WSL2, and behind some host firewalls, the SYN is dropped
 * instead: `OpenAiHttpBackend.health` then waits out its own 5 s
 * `AbortSignal.timeout`, which is exactly the unit test timeout, so the test
 * can never win the race — 34 tests red on a clean clone, every one a
 * timeout. Port 1 alone kept passing, and only because it is on the fetch
 * spec's bad-port list, so undici refuses it before opening a socket.
 *
 * So the port is real: an ephemeral loopback listener that closes every
 * connection the moment it is accepted. `fetch` fails within milliseconds
 * (`ECONNRESET` / "other side closed"), the probe reports `healthy: false`
 * with the same "could not reach the model server" detail a refusal gives,
 * and the daemon takes the same not-healthy branch it takes in CI. No
 * network policy is consulted, and no well-known port that a real server on
 * the developer's machine might be sitting on is touched.
 *
 * Unref'd so a forgotten `close` cannot hold a worker open; close it in
 * `afterAll` all the same.
 */
export async function unreachableBackend(): Promise<UnreachableBackend> {
  const server = createServer((socket) => {
    socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.unref();
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

export function treeOf(dir: string): { relative: string; path: string }[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).map(
    (name) => ({
      relative: name.split(sep).join("/"),
      path: `${dir}${name}`,
    }),
  );
}

/**
 * Give a test's state directory one pairing — #9703.
 *
 * `byollm start` installs nothing on a machine with no pairing, because the
 * daemon it would supervise exits at once and the supervisor restarts it
 * forever. A test about what `start` does once that is settled pairs first,
 * the way `byollm setup` does before it runs `start`.
 */
export async function pairedForStart(
  pairingsPath: string,
  origin = "https://hub.test",
): Promise<void> {
  const { Pairings } = await import("./pairings.js");
  const pairings = new Pairings(pairingsPath);
  await pairings.load();
  await pairings.put({
    origin,
    runnerId: "runner_1",
    owner: "me",
    sites: {},
    pairedAt: Date.now(),
  });
}

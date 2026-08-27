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

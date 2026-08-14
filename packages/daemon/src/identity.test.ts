import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPublicIdentity, verifyWith } from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceIdentity } from "./identity.js";
import { removeTemp } from "./test-support.js";

/**
 * The device key is the one file the daemon writes that cannot be reissued.
 * Everything here is about not destroying it and not leaking it.
 */

let dir: string;
const NOW = 1_800_000_000_000;
const identity = () => new DeviceIdentity(join(dir, "keys.json"));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byollm-identity-"));
});
afterEach(async () => {
  await removeTemp(dir);
});

describe("first run", () => {
  it("generates a usable identity", async () => {
    const keys = await identity().load(NOW);
    expect(
      verifyPublicIdentity({
        identity: keys.identityPublic,
        encryption: keys.encryptionPublic,
        encryptionSig: keys.encryptionSig,
      }),
    ).toBe(true);
  });

  it("generates once and reuses it forever", async () => {
    // Regenerating would orphan every pairing the owner has.
    const first = await identity().load(NOW);
    const second = await identity().load(NOW + 86_400_000);
    expect(second.identityPublic).toBe(first.identityPublic);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it.skipIf(process.platform === "win32")(
    "writes the private key 0600",
    async () => {
      await identity().load(NOW);
      const mode = (await stat(join(dir, "keys.json"))).mode & 0o777;
      expect(mode & 0o077).toBe(0);
    },
  );

  it.runIf(process.platform === "win32")(
    "on Windows, records that the mode is not what protects the key",
    async () => {
      // Node synthesizes `mode` on Windows: a writable file reports 0o666
      // whatever `writeFile` was given, and `chmod` only toggles read-only.
      // So the 0600 above is not a protection there — the file is protected
      // by the ACLs it inherits from the user profile directory, which is a
      // weaker and less visible guarantee. Asserting the POSIX bits would
      // have quietly claimed otherwise. See docs/security.md §3.4.
      await identity().load(NOW);
      const mode = (await stat(join(dir, "keys.json"))).mode & 0o777;
      expect(mode & 0o077).not.toBe(0);
    },
  );

  it("does not lose a race between two daemons starting at once", async () => {
    // `wx` means the loser reads the winner's file rather than overwriting a
    // key the other may already be pairing with.
    const [a, b] = await Promise.all([
      identity().load(NOW),
      identity().load(NOW),
    ]);
    expect(a.identityPublic).toBe(b.identityPublic);
  });
});

describe("a damaged key file is not silently replaced", () => {
  it("refuses invalid JSON, naming the file and the consequence", async () => {
    await writeFile(join(dir, "keys.json"), "{ truncated", { mode: 0o600 });
    // Generating fresh keys here would orphan every pairing and look like a
    // network fault. Refusing lets the owner decide.
    await expect(identity().load(NOW)).rejects.toThrow(/re-pairing every app/);
  });

  it("refuses a well-formed file of the wrong shape", async () => {
    await writeFile(
      join(dir, "keys.json"),
      JSON.stringify({ version: 1, identityPublic: "only-this" }),
      { mode: 0o600 },
    );
    await expect(identity().load(NOW)).rejects.toThrow(/not a valid key file/);
  });

  it("leaves the damaged file on disk", async () => {
    await writeFile(join(dir, "keys.json"), "{ truncated", { mode: 0o600 });
    await identity()
      .load(NOW)
      .catch(() => undefined);
    // Recovery may still be possible from it, or from a backup of it.
    expect(await readFile(join(dir, "keys.json"), "utf8")).toBe("{ truncated");
  });
});

describe("permissions are re-checked, not assumed", () => {
  it.skipIf(process.platform === "win32")(
    "tightens and warns when the file has been widened",
    async () => {
      await identity().load(NOW);
      // A restore from backup, a careless chmod -R, a synced folder.
      await chmod(join(dir, "keys.json"), 0o644);

      const warnings: string[] = [];
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk: unknown): boolean => {
        warnings.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      };
      try {
        await identity().load(NOW);
      } finally {
        process.stderr.write = original;
      }

      expect(warnings.join("")).toMatch(/readable by other users/);
      expect((await stat(join(dir, "keys.json"))).mode & 0o077).toBe(0);
    },
  );

  it.runIf(process.platform === "win32")(
    "on Windows, says nothing rather than warning on every start",
    async () => {
      // The check is skipped there because it would fire every time and
      // claim to have fixed something it had not.
      await identity().load(NOW);
      const warnings: string[] = [];
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk: unknown): boolean => {
        warnings.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      };
      try {
        await identity().load(NOW);
      } finally {
        process.stderr.write = original;
      }
      expect(warnings.join("")).not.toMatch(/readable by other users/);
    },
  );
});

describe("signing with the device key", () => {
  it("produces a signature that verifies against the published identity", async () => {
    const id = identity();
    const keys = await id.load(NOW);
    const nonce = Buffer.from("upstream-issued-nonce");

    expect(
      verifyWith(keys.identityPublic, nonce, await id.sign(nonce, NOW)),
    ).toBe(true);
  });

  it("exposes a fingerprint an owner can compare", async () => {
    expect(await identity().fingerprint(NOW)).toMatch(/^BYOLLM(-\w{4}){6}$/);
  });

  it("never puts a private key in the public identity", async () => {
    const id = identity();
    const keys = await id.load(NOW);
    const published = JSON.stringify(await id.publicIdentity(NOW));
    expect(published).not.toContain(keys.identityPrivate);
    expect(published).not.toContain(keys.encryptionPrivate);
  });
});

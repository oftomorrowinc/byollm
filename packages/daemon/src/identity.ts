import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  StoredKeys,
  fingerprint,
  generateKeys,
  publicIdentityOf,
  signWith,
  type PublicIdentity,
} from "@byollm/protocol";

/**
 * This machine's identity — byollm_009 §3.
 *
 * Generated once, at first run, and then never again: the device key *is* the
 * daemon, in a way a runner token never was. A token is a bearer secret a
 * server minted and can reissue; this is the machine saying who it is, and
 * nothing upstream can mint one.
 *
 * That difference is why this file is treated more carefully than the others
 * the daemon writes. Losing it means re-pairing every site. Leaking it means
 * someone else can be this machine.
 */
export class DeviceIdentity {
  readonly #path: string;
  #keys: StoredKeys | undefined;

  constructor(path: string) {
    this.#path = path;
  }

  /**
   * Load the keys, generating them on first run.
   *
   * A corrupt file is **not** silently replaced. Generating fresh keys over
   * an unreadable file would silently orphan every pairing the owner has —
   * every site would see an unknown device and refuse — and it would look
   * like a network problem. Refusing loudly names the file and lets the owner
   * decide, which is the only honest option when the alternative is
   * destroying something unrecoverable.
   */
  async load(now: number): Promise<StoredKeys> {
    if (this.#keys) return this.#keys;

    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return this.#create(now);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `${this.#path} is not valid JSON. This file is this machine's ` +
          `identity; delete it only if you accept re-pairing every app.`,
        { cause: error },
      );
    }

    const result = StoredKeys.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `${this.#path} is not a valid key file. This file is this machine's ` +
          `identity; delete it only if you accept re-pairing every app.`,
      );
    }

    await this.#warnIfReadable();
    this.#keys = result.data;
    return result.data;
  }

  /** The public half, for pairing and the handshake. */
  async publicIdentity(now: number): Promise<PublicIdentity> {
    return publicIdentityOf(await this.load(now));
  }

  /** What the owner compares out of band. */
  async fingerprint(now: number): Promise<string> {
    return fingerprint((await this.load(now)).identityPublic);
  }

  /** Sign a challenge nonce. */
  async sign(data: Uint8Array, now: number): Promise<string> {
    return signWith(await this.load(now), data);
  }

  async #create(now: number): Promise<StoredKeys> {
    const keys = generateKeys(now);
    await mkdir(dirname(this.#path), { recursive: true });
    // `wx` so two daemons racing at first start cannot each believe they
    // created the identity — the loser reads what the winner wrote rather
    // than overwriting a key the other has already begun pairing with.
    try {
      await writeFile(this.#path, JSON.stringify(keys, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return this.load(now);
      }
      throw error;
    }
    this.#keys = keys;
    return keys;
  }

  /**
   * Say something if the key file is group- or world-readable.
   *
   * We write `0600`, but a restore from backup, a careless `chmod -R`, or a
   * synced folder can widen it afterwards. Tightening it silently would hide
   * that something else on this machine is treating the file as ordinary
   * data, which is worth knowing.
   *
   * **Windows is exempt, because the check would lie.** Node's `mode` there
   * is synthesized — a writable file reports `0o666` regardless of what was
   * passed to `writeFile`, and `chmod` only toggles the read-only flag. So on
   * Windows this would warn on every start and claim to fix something it had
   * not fixed. The honest position is in `docs/security.md` §3.4: on Windows
   * the key file is protected by the ACLs it inherits from the user profile,
   * not by a mode we set.
   */
  async #warnIfReadable(): Promise<void> {
    if (process.platform === "win32") return;
    try {
      const mode = (await stat(this.#path)).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        process.stderr.write(
          `warning: ${this.#path} is mode ${mode.toString(8)} — this machine's\n` +
            `private key is readable by other users. Fixing to 0600.\n`,
        );
        await chmod(this.#path, 0o600);
      }
    } catch {
      // A stat failure must not stop a daemon from starting.
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
  StoredKeys,
  fingerprint,
  generateKeys,
  publicIdentityOf,
  signRequest,
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

  /** Sign one outgoing protocol request (byollm_009 §4.2). */
  async signRequest(input: {
    endpoint: string;
    runnerId: string;
    issuedAt: number;
    body: string;
  }): Promise<string> {
    return signRequest(await this.load(input.issuedAt), input).signature;
  }

  async #create(now: number): Promise<StoredKeys> {
    const keys = generateKeys(now);
    await mkdir(dirname(this.#path), { recursive: true });

    // Written somewhere else, then **linked** into place — and the reason is
    // a Windows CI failure on this file's own race test.
    //
    // It was `writeFile(…, { flag: "wx" })`: exclusive create, so two daemons
    // racing at first start could not each believe they had made the
    // identity. That half was right and remains. What it does not give is an
    // *atomic* file: `wx` creates the name and then writes the bytes, so
    // between those two moments the other daemon reads a file that exists and
    // is empty. On Linux the window is small enough that this passed for
    // months; on Windows it opened wide enough to fail, with "keys.json is
    // not valid JSON" — a message about corruption, for a file that was
    // merely half-written.
    //
    // `link` makes the name appear only when the content is already complete,
    // and fails with EEXIST if somebody won the race first. Both properties in
    // one syscall, on every platform that has hard links.
    // A unique name per attempt, not per process. Two daemons in one process
    // is a test rather than a deployment, and this file's own race test is
    // exactly that: with the pid as the suffix, both wrote the same temp,
    // the second overwrote the first, and the daemon that won the `link`
    // returned keys that were never the ones on disk. A worse failure than
    // the one being fixed, and invisible anywhere but here.
    const temp = `${this.#path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(keys, null, 2), { mode: 0o600 });
    try {
      await link(temp, this.#path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        await rm(temp, { force: true });
        // The winner's file, complete by construction now.
        return this.load(now);
      }
      // A filesystem without hard links (some network and FAT mounts). Fall
      // back to the old behaviour rather than refusing to start: a smaller
      // race is better than no daemon, and this path is rare enough that
      // saying so in a comment is the honest treatment.
      if (code === "EPERM" || code === "ENOSYS" || code === "EXDEV") {
        await rm(temp, { force: true });
        try {
          await writeFile(this.#path, JSON.stringify(keys, null, 2), {
            mode: 0o600,
            flag: "wx",
          });
        } catch (fallbackError) {
          if ((fallbackError as NodeJS.ErrnoException).code === "EEXIST") {
            return this.load(now);
          }
          throw fallbackError;
        }
        this.#keys = keys;
        return keys;
      }
      await rm(temp, { force: true });
      throw error;
    }
    await rm(temp, { force: true });
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

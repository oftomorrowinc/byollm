import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * One person, on one server, allowed to run work on this machine.
 *
 * Keyed by **(server origin, user id)** because owner ids are
 * server-namespace-local: `alice` on one app is not `alice` on another, and a
 * list keyed by id alone would silently merge strangers.
 */
export const AllowEntry = z
  .object({
    /** Origin of the server that issued the id, e.g. `https://app.example.com`. */
    origin: z.string().min(1),
    /** The app's id for the user. */
    owner: z.string().min(1),
    /** Optional human label, so the list is readable a month later. */
    note: z.string().optional(),
    addedAt: z.number().int().positive(),
  })
  .strict();
export type AllowEntry = z.infer<typeof AllowEntry>;

const AllowFile = z
  .object({
    version: z.literal(1),
    entries: z.array(AllowEntry),
  })
  .strict();

/**
 * The daemon's local `named` allowlist.
 *
 * byollm_001 Rev 1 §B: a `named` job is admitted only when *this* list names
 * its owner. A server's assertion that a runner is allowed is never enough —
 * honouring it would mean obeying the server rather than enforcing against
 * it. One file, every paired app, so the owner has one place to see everyone
 * who can use their machine.
 *
 * The list is **empty by default**, which is what makes a fresh daemon
 * effectively self-only until the owner deliberately widens it.
 */
export class Allowlist {
  readonly #path: string;
  #entries: AllowEntry[] = [];
  #loaded = false;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.#path, "utf8");
      const parsed = AllowFile.safeParse(JSON.parse(raw));
      // A corrupt allowlist reads as empty rather than throwing: failing
      // closed here means refusing community work, which is the safe
      // direction, and the owner sees an empty `byollm allow --list`.
      this.#entries = parsed.success ? parsed.data.entries : [];
    } catch {
      this.#entries = [];
    }
    this.#loaded = true;
  }

  #assertLoaded(): void {
    if (!this.#loaded) {
      throw new Error("allowlist used before load()");
    }
  }

  /** Does this list admit `owner` on `origin`? */
  admits(origin: string, owner: string): boolean {
    this.#assertLoaded();
    const normalized = normalizeOrigin(origin);
    return this.#entries.some(
      (entry) =>
        normalizeOrigin(entry.origin) === normalized && entry.owner === owner,
    );
  }

  /** A predicate bound to one origin, for {@link matchAudience}. */
  predicateFor(origin: string): (owner: string) => boolean {
    return (owner) => this.admits(origin, owner);
  }

  list(): readonly AllowEntry[] {
    this.#assertLoaded();
    return [...this.#entries];
  }

  async add(entry: Omit<AllowEntry, "addedAt">, now: number): Promise<void> {
    this.#assertLoaded();
    const normalized = normalizeOrigin(entry.origin);
    if (this.admits(normalized, entry.owner)) return;
    this.#entries.push(
      AllowEntry.parse({ ...entry, origin: normalized, addedAt: now }),
    );
    await this.#save();
  }

  /** Remove an entry. Returns whether anything was removed. */
  async remove(origin: string, owner: string): Promise<boolean> {
    this.#assertLoaded();
    const normalized = normalizeOrigin(origin);
    const before = this.#entries.length;
    this.#entries = this.#entries.filter(
      (entry) =>
        !(
          normalizeOrigin(entry.origin) === normalized && entry.owner === owner
        ),
    );
    if (this.#entries.length === before) return false;
    await this.#save();
    return true;
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(
      this.#path,
      `${JSON.stringify({ version: 1, entries: this.#entries }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}

/**
 * Compare origins by scheme, host and port only.
 *
 * `https://app.test/` and `https://app.test` must be the same entry — a
 * trailing slash is not a different server, and treating it as one would let
 * an allowlist silently fail to match.
 */
export function normalizeOrigin(input: string): string {
  try {
    return new URL(input).origin;
  } catch {
    return input.replace(/\/+$/, "");
  }
}

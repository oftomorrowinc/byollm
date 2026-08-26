import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { normalizeOrigin } from "./origins.js";

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

/**
 * One person this device will **not** serve, whatever a roster says.
 *
 * The local veto — byollm_001 Amendment G, property 3. Same key as an allow
 * entry, and deliberately a different list: an allowlist that could be read
 * as a denylist is one where deleting a row changes its meaning.
 */
export const VetoEntry = z
  .object({
    origin: z.string().min(1),
    owner: z.string().min(1),
    note: z.string().optional(),
    addedAt: z.number().int().positive(),
  })
  .strict();
export type VetoEntry = z.infer<typeof VetoEntry>;

const AllowFile = z
  .object({
    version: z.literal(1),
    entries: z.array(AllowEntry),
    /**
     * Optional, because every file written before the veto existed has none —
     * and a file with no vetoes is a device that has refused nobody, which is
     * the truthful reading of its absence.
     */
    denied: z.array(VetoEntry).default([]),
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
  #denied: VetoEntry[] = [];
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
      // A corrupt file reads as no allow entries **and no vetoes**, which is
      // the safe direction for both: the first refuses community work, and
      // the second refuses nobody a roster admits. Failing closed on the veto
      // would mean an unreadable file silently locking out a whole team.
      this.#denied = parsed.success ? parsed.data.denied : [];
    } catch {
      this.#entries = [];
      this.#denied = [];
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

  /**
   * Is this person vetoed on this device — Amendment G, property 3.
   *
   * The local half of admission, and the only local half: a veto subtracts
   * from what a roster says, and nothing here can add to it. That asymmetry
   * is the point. An owner who wants somebody served edits the roster, which
   * is the one place membership lives; an owner who wants somebody *stopped*
   * needs it to work on this machine, now, without waiting for a sync that
   * may never arrive.
   */
  vetoes(origin: string, owner: string): boolean {
    this.#assertLoaded();
    const normalized = normalizeOrigin(origin);
    return this.#denied.some(
      (entry) =>
        normalizeOrigin(entry.origin) === normalized && entry.owner === owner,
    );
  }

  /** Everyone this device is refusing, for `byollm status` to show. */
  vetoed(): readonly VetoEntry[] {
    this.#assertLoaded();
    return [...this.#denied];
  }

  /** Record a veto. Idempotent — refusing twice is refusing once. */
  async veto(entry: Omit<VetoEntry, "addedAt">, now: number): Promise<void> {
    this.#assertLoaded();
    const normalized = normalizeOrigin(entry.origin);
    if (this.vetoes(normalized, entry.owner)) return;
    this.#denied.push(
      VetoEntry.parse({ ...entry, origin: normalized, addedAt: now }),
    );
    await this.#save();
  }

  /**
   * Lift a veto. Returns whether one was lifted.
   *
   * Not an "add": it restores whatever the roster already says, which may be
   * nothing. Amendment G forbids a local list that *grants*, and this grants
   * nothing — it stops subtracting.
   */
  async unveto(origin: string, owner: string): Promise<boolean> {
    this.#assertLoaded();
    const normalized = normalizeOrigin(origin);
    const before = this.#denied.length;
    this.#denied = this.#denied.filter(
      (entry) =>
        !(
          normalizeOrigin(entry.origin) === normalized && entry.owner === owner
        ),
    );
    if (this.#denied.length === before) return false;
    await this.#save();
    return true;
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(
      this.#path,
      `${JSON.stringify(
        { version: 1, entries: this.#entries, denied: this.#denied },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }
}

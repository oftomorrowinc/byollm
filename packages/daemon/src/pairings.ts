import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PublicIdentity } from "@byollm/protocol";
import { z } from "zod";
import { normalizeOrigin } from "./allowlist.js";

/**
 * One paired server.
 *
 * A daemon may pair with several apps; each pairing is a separate identity
 * with its own token and its own owner. Nothing is shared between them —
 * `owner` from one server means nothing on another
 * ({@link MUSTS.PAIR_ONE_USER}).
 */
export const Pairing = z
  .object({
    origin: z.string().min(1),
    runnerId: z.string().min(1),
    /** The app's id for this daemon's owner. */
    owner: z.string().min(1),
    ownerLabel: z.string().optional(),
    /**
     * The sites this pairing covers, keyed by each site's identity key id.
     *
     * Pinned rather than fetched: a key re-fetched on each connection is a
     * key an upstream can change, which is the whole thing pinning prevents.
     * The owner compares a fingerprint against what the site displays.
     *
     * A **map**, because one pairing covers an upstream rather than a site
     * (cloud_009 §5): a user who connects a site on a web dashboard has no
     * reason to run a command on a laptop afterwards, so the set follows
     * consent and arrives on the heartbeat. A direct site is one entry, which
     * is the same shape rather than a special case.
     *
     * `site` and `token` are gone. `token` was a bearer credential nothing
     * had minted, sent or read since alpha.18 — a secret kept at rest for
     * nothing. `site` was the single-site shape, and carrying both would be
     * two answers to "which key opens this", which is this project's most
     * repeated bug. Pre-1.0, an existing pairing file is re-paired rather
     * than migrated, and the README says so.
     */
    sites: z.record(z.string().min(1), PublicIdentity),
    /**
     * Every site ever approved here, with the key it was approved under —
     * V1-1.
     *
     * `sites` follows consent and shrinks; this only grows. Without it, an
     * upstream could drop a site id from one heartbeat and re-offer it on the
     * next under a key of its own choosing, and the daemon would read the
     * second offer as somebody new rather than as the substitution pinning
     * exists to refuse.
     *
     * Optional on disk: a file written before this existed is read as "the
     * sites in it were approved", which is true — they came through
     * `connect`'s fingerprint compare.
     */
    known: z.record(z.string().min(1), PublicIdentity).optional(),
    /**
     * Offered by the upstream, approved by nobody — shown, never served.
     *
     * Kept in the file because the person who answers is at a *different*
     * process: the daemon is in its run loop, and `byollm approve` needs the
     * key to pin the one that was on screen rather than re-asking the
     * upstream for it.
     */
    pending: z.record(z.string().min(1), PublicIdentity).optional(),
    pairedAt: z.number().int().positive(),
  })
  .strict();
export type Pairing = z.infer<typeof Pairing>;

/**
 * Drop the site entries that cannot be read, and name them — V1-9.
 *
 * Mutates the row in place before it is parsed, which is the only point where
 * "skip what you cannot read" can be applied per entry to a `z.record`.
 * Returns the keys removed, so a caller can say which rather than leaving
 * somebody to wonder why a site went quiet.
 */
function siftEntries(row: unknown): string[] {
  const dropped: string[] = [];
  if (typeof row !== "object" || row === null) return dropped;
  for (const field of ["sites", "known", "pending"] as const) {
    const map = (row as Record<string, unknown>)[field];
    if (typeof map !== "object" || map === null) continue;
    const kept: Record<string, unknown> = {};
    for (const [id, entry] of Object.entries(map as Record<string, unknown>)) {
      if (PublicIdentity.safeParse(entry).success) {
        kept[id] = entry;
        continue;
      }
      dropped.push(`${field}.${id}`);
    }
    // Rebuilt rather than deleted from: a map with entries removed one by one
    // is the same map, and this way the row that gets parsed is only ever
    // made of entries that parsed.
    (row as Record<string, unknown>)[field] = kept;
  }
  return dropped;
}

/**
 * The file's shape, with its rows left unparsed — cloud_008 §2.3a.
 *
 * `z.array(z.unknown())` on purpose. This used to be `z.array(Pairing)`, and
 * `safeParse` is all-or-nothing: **one malformed row silently disconnected
 * the daemon from every site it had paired with.** The CLI then said "not
 * paired with <origin>" — a true sentence about a state nobody intended — and
 * `byollm list` showed nothing rather than showing a problem.
 *
 * Third instance of the shape in this brief. §0.1 was the control-plane
 * projection, where one bad device row froze revocation for everyone; §2.1a
 * was the routing store, where two stubs written by an older version denied
 * every claim on the hub. This is the same lesson on the daemon's own disk:
 * **parse per row, skip what you cannot read, and say which one.**
 *
 * A bad row here is one pairing's problem. It was never everyone's.
 */
const PairingFile = z
  .object({ version: z.literal(1), pairings: z.array(z.unknown()) })
  .strict();

/** A row that would not parse, for the caller to report. */
export interface SkippedPairing {
  /** Whatever the row called its origin, when it had a usable one. */
  readonly origin: string;
  /** Which fields failed, never their values. */
  readonly problem: string;
}

/** The daemon's paired servers, on disk. */
export class Pairings {
  readonly #path: string;
  #pairings: Pairing[] = [];
  #skipped: SkippedPairing[] = [];
  #loaded = false;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<void> {
    this.#pairings = [];
    this.#skipped = [];
    let file: unknown;
    try {
      file = JSON.parse(await readFile(this.#path, "utf8"));
    } catch (error) {
      // A daemon that has never paired is the ordinary case rather than an
      // error, so a missing file stays silent. **Anything else does not** —
      // V1-9. Unreadable and never-paired were one branch, and they say
      // opposite things: one means "run `byollm connect`", the other means
      // this machine has pairings it cannot see, and the CLI would have
      // offered the first advice in both cases.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.#skipped.push({
          origin: this.#path,
          problem:
            code === undefined
              ? "the pairings file is not valid JSON"
              : `the pairings file could not be read (${code})`,
        });
      }
      this.#loaded = true;
      return;
    }

    const parsed = PairingFile.safeParse(file);
    if (!parsed.success) {
      this.#skipped.push({
        origin: this.#path,
        problem: "the pairings file is not in a shape this version can read",
      });
      this.#loaded = true;
      return;
    }

    for (const row of parsed.data.pairings) {
      // Per *entry*, one level further down than §2.3a went — V1-9.
      //
      // `sites` is a single `z.record`, so one unreadable site entry failed
      // the whole pairing: the amplification this file's own comment is about,
      // repeating itself inside the row it fixed. A machine paired with four
      // sites lost all four because one of them was written by a version that
      // spells a key differently.
      const dropped = siftEntries(row);
      const pairing = Pairing.safeParse(row);
      if (pairing.success) {
        this.#pairings.push(pairing.data);
        for (const name of dropped) {
          this.#skipped.push({
            origin: pairing.data.origin,
            problem: `a site entry could not be read (${name})`,
          });
        }
        continue;
      }
      const origin = (row as { origin?: unknown }).origin;
      this.#skipped.push({
        origin: typeof origin === "string" ? origin : "an unnamed entry",
        // Paths, not values: a pairing row holds pinned keys, and a
        // diagnostic that quotes the row puts key material in a log. (It held
        // a bearer token too, until alpha.25 removed a credential nothing had
        // ever sent — the rule outlived the secret, and so should the habit.)
        problem: pairing.error.issues.map((i) => i.path.join(".")).join(", "),
      });
    }
    this.#loaded = true;
  }

  /**
   * Rows the last {@link load} could not read.
   *
   * Exposed rather than logged from here: this class has no opinion about
   * where a message goes, and the CLI is the thing with a user in front of
   * it. Empty on a healthy file, which is what makes it worth checking.
   */
  get skipped(): readonly SkippedPairing[] {
    this.#assertLoaded();
    return [...this.#skipped];
  }

  list(): readonly Pairing[] {
    this.#assertLoaded();
    return [...this.#pairings];
  }

  get(origin: string): Pairing | undefined {
    this.#assertLoaded();
    const normalized = normalizeOrigin(origin);
    return this.#pairings.find(
      (pairing) => normalizeOrigin(pairing.origin) === normalized,
    );
  }

  /** Add or replace the pairing for an origin. Re-pairing supersedes. */
  async put(pairing: Pairing): Promise<void> {
    this.#assertLoaded();
    const normalized = normalizeOrigin(pairing.origin);
    this.#pairings = this.#pairings.filter(
      (existing) => normalizeOrigin(existing.origin) !== normalized,
    );
    this.#pairings.push({ ...pairing, origin: normalized });
    await this.#save();
  }

  /** Forget a pairing. Returns whether one was removed. */
  async remove(origin: string): Promise<boolean> {
    this.#assertLoaded();
    const normalized = normalizeOrigin(origin);
    const before = this.#pairings.length;
    this.#pairings = this.#pairings.filter(
      (pairing) => normalizeOrigin(pairing.origin) !== normalized,
    );
    if (this.#pairings.length === before) return false;
    await this.#save();
    return true;
  }

  #assertLoaded(): void {
    if (!this.#loaded) throw new Error("pairings used before load()");
  }

  /**
   * Write the file, or leave the old one — V1-9.
   *
   * Written elsewhere and renamed into place, for the reason `identity.ts`
   * gives at length about `keys.json`: an in-place write makes the name exist
   * while the bytes are still arriving, and a daemon reading it in that window
   * sees a truncated file. `load()` treats unparseable as never-paired, so a
   * torn write here disconnected a machine from every site it served — and
   * `byollm list` then said, accurately and uselessly, that nothing was
   * paired.
   *
   * `rename` rather than `link`, because this replaces: `keys.json` is created
   * once and must never be overwritten, so it wants `link`'s EEXIST. Here the
   * whole point is that the new file takes the old one's place in one step.
   */
  async #save(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const body = `${JSON.stringify(
      { version: 1, pairings: this.#pairings },
      null,
      2,
    )}\n`;
    // A unique name per attempt: two writers sharing one temp name is how the
    // identity file's first fix broke its own race test.
    const temp = `${this.#path}.${randomUUID()}.tmp`;
    try {
      // Pinned keys live here. Nobody else on a shared machine reads them.
      await writeFile(temp, body, { mode: 0o600 });
      await rename(temp, this.#path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}

/**
 * Record the site set an upstream just described, if it moved.
 *
 * The heartbeat is the authority on which sites a pairing covers (cloud_009
 * §5), and the file has to follow it: a daemon that learns the set every few
 * seconds and forgets it at every restart behaves differently depending on
 * how recently it was rebooted.
 *
 * Its own function rather than a branch inside the run loop, because a seam
 * that cannot be called cannot be tested — and this one has four outcomes
 * worth naming: nothing paired here, nothing changed, written, and the write
 * failed. Returns what happened so a caller can say so without inspecting the
 * file.
 */
export async function recordSites(
  pairings: Pairings,
  origin: string,
  sites: ReadonlyMap<string, PublicIdentity>,
  /** Ever approved, and offered-but-unapproved — V1-1. */
  extra: {
    readonly known?: ReadonlyMap<string, PublicIdentity>;
    readonly pending?: ReadonlyMap<string, PublicIdentity>;
  } = {},
): Promise<"unpaired" | "unchanged" | "written"> {
  const pairing = pairings.get(origin);
  if (!pairing) return "unpaired";
  const next = {
    ...pairing,
    sites: Object.fromEntries(sites),
    ...(extra.known ? { known: Object.fromEntries(extra.known) } : {}),
    // Written even when empty, and deleted rather than left behind: a
    // `pending` map that outlived the offer would have `byollm sites` showing
    // somebody a question the upstream stopped asking.
    ...(extra.pending
      ? extra.pending.size === 0
        ? { pending: undefined }
        : { pending: Object.fromEntries(extra.pending) }
      : {}),
  };
  if (next.pending === undefined)
    delete (next as { pending?: unknown }).pending;
  // Compared as text, deliberately: the values are small, flat and
  // JSON-shaped, and a deep-equality helper here would be a second
  // implementation of a comparison the file format already defines.
  if (JSON.stringify(next) === JSON.stringify(pairing)) return "unchanged";
  await pairings.put(next);
  return "written";
}

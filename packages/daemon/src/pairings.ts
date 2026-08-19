import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    /**
     * A bearer token this daemon no longer mints, sends or reads — cloud_008
     * §2.4, finding 37.
     *
     * Optional, and only so that a pairings file written before alpha.18
     * still parses: `Pairing` is `.strict()`, so making it absent would make
     * every existing row unreadable — and §2.3a would then dutifully skip
     * them one by one and report a daemon paired with nothing. A schema
     * change is a data migration; that lesson cost the hub an outage window
     * in §2.1a and is not worth learning twice.
     *
     * Never written by this version. It disappears from a file the first time
     * anything rewrites it, and this field goes when no supported version can
     * still be holding one.
     */
    token: z.string().min(1).optional(),
    /** The app's id for this daemon's owner. */
    owner: z.string().min(1),
    ownerLabel: z.string().optional(),
    /**
     * The site's public keys, pinned at pairing (byollm_009 §5).
     *
     * Pinned rather than fetched: a key re-fetched on each connection is a
     * key an upstream can change, which is the whole thing pinning prevents.
     * The owner can compare `sitePin`'s fingerprint against what the site
     * displays.
     */
    site: PublicIdentity,
    /**
     * Every site this pairing carries, keyed by the site's identity key id.
     *
     * **Accepted, not yet written** — cloud_009 §5's first release. One
     * pairing per hub, and which sites it carries is a projection of consent
     * rather than something frozen at pairing: a user who connects a site in
     * the dashboard has no reason to go back to a laptop and run a command,
     * so the set arrives on the heartbeat and this is where it lands.
     *
     * The order matters and is the whole reason this field is here a release
     * early. `Pairing` is `.strict()`, so a row carrying `sites` read by a
     * daemon that predates it fails to parse — and §2.3a's per-row parse
     * would dutifully skip it and report a daemon paired with nothing. So:
     * this release accepts it, the next writes it, and a third drops `site`.
     * No release ever writes a shape the previous one cannot read.
     *
     * The key is the id `stub.site` carries (Amendment A §A.3), so the
     * runner's lookup is a map read with no second namespace in it.
     */
    sites: z.record(z.string().min(1), PublicIdentity).optional(),
    pairedAt: z.number().int().positive(),
  })
  .strict();
export type Pairing = z.infer<typeof Pairing>;

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
    } catch {
      // No file, or not JSON at all. Nothing to salvage row by row, and a
      // daemon that has never paired is the ordinary case rather than an
      // error — so this stays silent where a bad *row* does not.
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
      const pairing = Pairing.safeParse(row);
      if (pairing.success) {
        this.#pairings.push(pairing.data);
        continue;
      }
      const origin = (row as { origin?: unknown }).origin;
      this.#skipped.push({
        origin: typeof origin === "string" ? origin : "an unnamed entry",
        // Paths, not values: a pairing row holds a bearer token and a key,
        // and a diagnostic that quotes the row would put both in a log.
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

  async #save(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(
      this.#path,
      `${JSON.stringify({ version: 1, pairings: this.#pairings }, null, 2)}\n`,
      // Tokens live here. Nobody else on a shared machine gets to read them.
      { mode: 0o600 },
    );
  }
}

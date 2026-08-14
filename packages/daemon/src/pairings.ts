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
    /** Bearer token. This file is written 0600 for exactly this reason. */
    token: z.string().min(1),
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
    pairedAt: z.number().int().positive(),
  })
  .strict();
export type Pairing = z.infer<typeof Pairing>;

const PairingFile = z
  .object({ version: z.literal(1), pairings: z.array(Pairing) })
  .strict();

/** The daemon's paired servers, on disk. */
export class Pairings {
  readonly #path: string;
  #pairings: Pairing[] = [];
  #loaded = false;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<void> {
    try {
      const parsed = PairingFile.safeParse(
        JSON.parse(await readFile(this.#path, "utf8")),
      );
      this.#pairings = parsed.success ? parsed.data.pairings : [];
    } catch {
      this.#pairings = [];
    }
    this.#loaded = true;
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

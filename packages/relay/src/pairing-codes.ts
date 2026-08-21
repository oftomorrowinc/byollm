import { randomBytes } from "node:crypto";
import type { PublicIdentity } from "@byollm/protocol";

/**
 * Pending pairing codes — cloud_009, the cloud-pairing flow.
 *
 * `byollm connect` speaks the device-code flow: ask for a code, show it, poll
 * while a human approves it in a browser. A relay had no way to hold that
 * pending state, so cloud pairing was never implemented — the hub accepted
 * only the shape where the device is *already* approved, and nothing in the
 * control plane created device rows at all. Every test passed because they
 * drive direct mode or seed the row with a service key: the checks proved the
 * parts and never the seam.
 *
 * ## Why the relay holds the code, and the control plane holds the decision
 *
 * The code is a short-lived handle on an *assertion* — "this keypair would
 * like to be a machine" — and the relay is allowed to hold assertions. The
 * approval is a human looking at a fingerprint, which belongs to the control
 * plane where that human is signed in.
 *
 * So nothing here approves anything. The daemon's poll asks whether the
 * control plane's projection now contains this device as approved, and the
 * answer comes from the projection rather than from a flag somebody set here.
 * That is what keeps the fence intact in both directions: the hub never
 * writes to the control plane, and the control plane never writes to the hub.
 *
 * ## What a code is worth on its own
 *
 * Nothing. Holding a device code lets you ask "has anyone approved this
 * keypair yet", and the answer is only ever yes for a keypair whose owner
 * approved it by eye. Stolen mid-flight it grants no access, which is why it
 * can be a URL-safe string a person reads aloud rather than a credential.
 */

/** What the relay remembers between `start` and `poll`. */
export interface PendingPairing {
  /** The secret the daemon polls with. Never shown to a human. */
  readonly deviceCode: string;
  /** The short code a person reads and types into the dashboard. */
  readonly userCode: string;
  /** The keys the daemon presented. What a human is about to approve. */
  readonly device: PublicIdentity;
  /** Label the daemon offered, for the approval screen. */
  readonly label: string;
  readonly platform: string;
  /** Epoch ms. After this the code is gone, approved or not. */
  readonly expiresAt: number;
}

export interface PairingCodes {
  put(pending: PendingPairing): Promise<void>;
  /** By the secret the daemon holds. */
  byDeviceCode(deviceCode: string): Promise<PendingPairing | undefined>;
  /** By the short code a human typed. */
  byUserCode(userCode: string): Promise<PendingPairing | undefined>;
  /** After a successful pairing, so a code is single-use. */
  drop(deviceCode: string): Promise<void>;
}

/**
 * Codes a person reads aloud, from an alphabet that survives being read aloud.
 *
 * Crockford's, minus the letters that become other letters over a phone: no
 * I/L/O/U. Eight characters in two groups — enough entropy that guessing is
 * not a strategy against a code that lives for ten minutes and grants nothing
 * on its own.
 */
const HUMAN_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newUserCode(): string {
  // `Array.from` rather than an indexed loop, so there is no index the
  // compiler cannot prove is in range and therefore no non-null assertion —
  // this codebase forbids them, and a `!` here would be one written for the
  // convenience of a loop rather than because anything was known.
  const groups = Array.from(randomBytes(8), (byte) =>
    HUMAN_ALPHABET.charAt(byte % HUMAN_ALPHABET.length),
  );
  return `${groups.slice(0, 4).join("")}-${groups.slice(4).join("")}`;
}

/** The secret half. Long and URL-safe; never shown to anybody. */
export const newDeviceCode = (): string =>
  randomBytes(32).toString("base64url");

/** How long a person has to walk to their browser and type eight characters. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * The in-memory implementation, for the reference relay and its tests.
 *
 * The hub replaces it with one backed by Valkey, because a hub is two
 * replicas and a code minted on one must be pollable on the other — the same
 * reason its routing store is not a `Map`.
 */
export class MemoryPairingCodes implements PairingCodes {
  readonly #byDevice = new Map<string, PendingPairing>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #live(pending: PendingPairing | undefined): PendingPairing | undefined {
    if (!pending) return undefined;
    // Expiry is checked on read rather than swept: a code nobody asks about
    // costs nothing, and a sweep is a second place for the deadline to live.
    return pending.expiresAt > this.#now() ? pending : undefined;
  }

  put(pending: PendingPairing): Promise<void> {
    this.#byDevice.set(pending.deviceCode, pending);
    return Promise.resolve();
  }

  byDeviceCode(deviceCode: string): Promise<PendingPairing | undefined> {
    return Promise.resolve(this.#live(this.#byDevice.get(deviceCode)));
  }

  byUserCode(userCode: string): Promise<PendingPairing | undefined> {
    const wanted = userCode.trim().toUpperCase();
    for (const pending of this.#byDevice.values()) {
      if (pending.userCode === wanted)
        return Promise.resolve(this.#live(pending));
    }
    return Promise.resolve(undefined);
  }

  drop(deviceCode: string): Promise<void> {
    this.#byDevice.delete(deviceCode);
    return Promise.resolve();
  }
}

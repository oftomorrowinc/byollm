import {
  ERROR_STATUS,
  MAX_CLOCK_SKEW_MS,
  MAX_ENVELOPE_BYTES,
} from "@byollm/protocol";
import type { PlaneResult } from "./daemon-plane.js";

/**
 * The clock-skew refusal, in one place — cloud_008 §1.4, finding 17.
 *
 * Both planes verify a signature and both can fail it for a reason that is not
 * the key: a timestamp too far from ours to judge freshness. Only the daemon
 * plane said so. The site plane collapsed every `SignatureFailure` into
 * "signature check failed", so a site whose clock had drifted was told its
 * signature was wrong and sent to look at its keys — while `verifySiteRequest`
 * had already distinguished `stale` and thrown the distinction away.
 *
 * The remedy is the whole reason this is a separate code. "Your key is wrong"
 * and "your clock is wrong" are different problems with different fixes, and
 * only the server can tell them apart, because only the server holds the other
 * clock.
 *
 * One builder rather than one per plane, because two copies of a refusal is
 * how this one came to exist: the daemon plane's was written first and the
 * site plane's was written to a different standard three files away.
 */
export function clockSkewRefusal(now: number): PlaneResult {
  return {
    status: ERROR_STATUS["clock-skew"],
    body: {
      error: "clock-skew",
      message:
        "this request's timestamp is too far from the server's clock; " +
        "check the machine's time and try again",
      // So the far side can say *how far off* rather than *that something is
      // wrong*. Not a disclosure: the heartbeat response returns the same
      // value, and so does every `Date` header.
      serverTime: now,
      maxSkewMs: MAX_CLOCK_SKEW_MS,
    },
  };
}

/**
 * The envelope is larger than the relay will hold — ratified 2026-08-28.
 *
 * A **relay-memory safety rail**, the same ceiling on every tier, and the same
 * refusal in both directions: a site attaching a payload and a device
 * returning a result reach it by different routes and hit one limit.
 *
 * ## Refused before acceptance, and nothing is written down
 *
 * That is the whole implementation, and it is why the cap needed no schema.
 * The size is known for the length of this check and is then gone — recording
 * a size in order to enforce a limit against it would be exactly the per-job
 * byte figure the metering ruling exists to not keep.
 *
 * ## `bad-request`, not a code of its own
 *
 * 413 is the semantically tidy status and a new `WireErrorCode` member is the
 * tidy code, and neither is worth what it costs here. Error codes are a
 * published enumeration that daemons and sites parse; a member added today
 * reaches a client shipped last month as an unrecognised value, and the
 * refusal it renders would be worse than the plain one. An over-size request
 * *is* a bad request, callers act on the code rather than the status, and the
 * right behaviour on both — do not retry, make it smaller — is the same.
 *
 * The message carries the limit and the remedy, because a ceiling somebody
 * cannot see the height of is a ceiling they hit twice.
 */
export function tooLargeRefusal(bytes: number): PlaneResult {
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return {
    status: ERROR_STATUS["bad-request"],
    body: {
      error: "bad-request",
      message:
        `this message is ${mb(bytes)} and the limit is ` +
        `${mb(MAX_ENVELOPE_BYTES)} — every plan has the same ceiling, and it ` +
        "is a limit on one message rather than on how many you send. Split " +
        "the work into smaller jobs and send them separately.",
    },
  };
}

import { ERROR_STATUS, MAX_CLOCK_SKEW_MS } from "@byollm/protocol";
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

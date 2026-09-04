import type { BackendErrorCode } from "./backends/types.js";

/**
 * What a site is told when a backend fails, and why it is never the text.
 *
 * The owner gets the CLI's own words — on Your Devices, in `byollm status`,
 * in the daemon's output and in `ingress.log`. The site gets a class and one
 * fixed sentence per class. Two reasons, and the second is the larger.
 *
 * **The text carries the owner's machine in it.** CLI errors quote paths,
 * usernames, config locations and account emails. A stranger's page is not
 * where those go, and `firstLine(stderr)` was sending them there.
 *
 * **And the message names the service.** "the claude CLI is not signed in"
 * tells the site which model answered — the one thing the disclosure fence
 * exists to prevent, arriving through the error path because nobody was
 * looking at the error path. Every message here named its backend, so every
 * failure leaked what every success is careful to hide.
 *
 * So no backend message reaches a site. The class says what a site can act
 * on — is it worth retrying, is it the job or the device — and the sentence
 * says the rest in words that are the same for everybody.
 */

/** The one sentence a site sees when somebody's device could not answer. */
export const SERVICE_UNAVAILABLE =
  "a device service is unavailable — its owner has been told";

/**
 * The class and sentence for each way a backend can fail.
 *
 * `timeout` and `output-too-large` keep their own class because they are
 * facts about the *job* — a site can shorten a prompt or try again, and
 * neither says anything about the person's setup. Everything else is a fact
 * about somebody's machine and arrives as one class, because telling them
 * apart would be telling the site which machine.
 */
const FOR_SITE: Readonly<
  Record<
    BackendErrorCode,
    { code: string; message: string; retryable: boolean }
  >
> = Object.freeze({
  "backend-unreachable": {
    code: "service_unavailable",
    message: SERVICE_UNAVAILABLE,
    retryable: true,
  },
  "backend-error": {
    code: "service_unavailable",
    message: SERVICE_UNAVAILABLE,
    retryable: true,
  },
  "model-not-found": {
    code: "service_unavailable",
    message: SERVICE_UNAVAILABLE,
    retryable: true,
  },
  "quota-exhausted": {
    code: "service_unavailable",
    message: SERVICE_UNAVAILABLE,
    retryable: true,
  },
  unauthorized: {
    code: "service_unavailable",
    message: SERVICE_UNAVAILABLE,
    retryable: true,
  },
  timeout: {
    code: "timeout",
    message: "the device did not answer in time",
    retryable: true,
  },
  "output-too-large": {
    code: "output-too-large",
    message: "the answer was too large to return",
    retryable: false,
  },
  canceled: {
    code: "canceled",
    message: "the job was canceled",
    retryable: false,
  },
});

/**
 * What a site is told, retry decision included — ruled 2026-09-04 (CW).
 *
 * `retryable` used to travel from the backend result, on the reasoning that
 * whether to try again is the site's decision and says nothing about whose
 * machine it was. That held while the flag did not distinguish anything: both
 * failures that reached `service_unavailable` reported `false`.
 *
 * `quota-exhausted` broke it by arriving `true`. Within one site-facing class
 * exactly one path produced that value, so the pair
 * `(service_unavailable, retryable: true)` read as **"his account is
 * rate-limited"** — the inference the fence exists to prevent, arriving on the
 * job-failure surface rather than the enqueue one nobody was watching. The two
 * adapters also disagreed: the same block reported `true` from Codex and
 * `false` from Claude.
 *
 * So the flag is a property of the **class**, decided here, and no longer of
 * the individual failure. Two failures a site cannot tell apart by code and
 * message cannot be told apart by this either, which is a shape rather than a
 * promise. The person-or-time question lives at enqueue, in the slot-level
 * wait-bit, and nowhere else.
 *
 * ## And the class value is `true` — corrected 2026-09-04
 *
 * The first version of this flattened to `false` and its comment claimed
 * nothing changed for a site except the leak. **That was wrong, and the
 * review caught it:** the HTTP backend already reported `true` for
 * `backend-unreachable` and for a 5xx `backend-error`, so the class was
 * split three ways and the flatten broke transient retries — a site with
 * retry-on-retryable would stop re-enqueueing after a 503 from somebody's
 * local model server.
 *
 * `true` is also the honest value. `service_unavailable` says nobody can
 * answer *right now*, and right now implies possibly-later. A site that
 * retries a quota block simply meets the fast enqueue refusal, which is the
 * cheap path 019 exists to provide.
 */
/**
 * Every code that reaches a site as one class, derived rather than listed.
 *
 * The fence test used to name its five siblings by hand, so the claim "these
 * are indistinguishable" held by convention: a sixth code added to the table
 * would be a sixth thing a site could tell apart, and no test would notice.
 * Membership comes off the table now, so a new sibling joins the assertion
 * the moment it exists.
 */
export function siblingsOf(siteCode: string): BackendErrorCode[] {
  return Object.entries(FOR_SITE)
    .filter(([, forSite]) => forSite.code === siteCode)
    .map(([code]) => code as BackendErrorCode);
}

export function outcomeForSite(code: BackendErrorCode): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  return FOR_SITE[code];
}

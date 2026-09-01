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
  Record<BackendErrorCode, { code: string; message: string }>
> = Object.freeze({
  "backend-unreachable": {
    code: "service_unavailable",
    message: SERVICE_UNAVAILABLE,
  },
  "backend-error": {
    code: "service_unavailable",
    message: SERVICE_UNAVAILABLE,
  },
  "model-not-found": {
    code: "service_unavailable",
    message: SERVICE_UNAVAILABLE,
  },
  unauthorized: {
    code: "service_unavailable",
    message: SERVICE_UNAVAILABLE,
  },
  timeout: {
    code: "timeout",
    message: "the device did not answer in time",
  },
  "output-too-large": {
    code: "output-too-large",
    message: "the answer was too large to return",
  },
  canceled: { code: "canceled", message: "the job was canceled" },
});

export function outcomeForSite(code: BackendErrorCode): {
  readonly code: string;
  readonly message: string;
} {
  return FOR_SITE[code];
}

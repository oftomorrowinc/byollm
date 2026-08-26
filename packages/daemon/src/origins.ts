/**
 * One spelling of one server.
 *
 * An origin is this daemon's primary key for a paired relay and for every
 * site under it. Two spellings of the same server must produce the same key
 * and two different servers must never produce the same one — and the
 * function that used to do this job did neither.
 *
 * It was `new URL(input).origin` with the raw string as a fallback, and it
 * cost us a stop-ship on 2026-08-26. `byollm allow hub.byollm.cloud …`
 * normalized to `hub.byollm.cloud`; the pairing had been stored as
 * `https://hub.byollm.cloud`; the lookup missed, and the guard that should
 * have refused read the miss as "no control plane here" and ran the flow it
 * was written to prevent. Nothing warned, because a fallback that returns its
 * input cannot tell a caller it failed.
 *
 * The collision was worse than the miss. `new URL()` accepts far more than
 * URLs, and `.origin` serializes anything it cannot place as the **string**
 * `"null"` — so `localhost:8080`, `example.com:8443`, `javascript:alert(1)`
 * and `data:text/html,x` all normalized to one identity. Four unrelated
 * inputs sharing a primary key is not a near miss; on the old allowlist it
 * was one entry granting four things.
 *
 * So: parse or refuse, and never guess quietly. The only guess left is the
 * scheme, it is made only when the input supplied none, and it is made the
 * way a person means it (see {@link normalizeOrigin}).
 */

/** Input that does not name a server this daemon could talk to. */
export class UnusableOrigin extends Error {
  /** What was offered. Origins are not secrets; this is safe to print. */
  readonly input: string;
  /** Why, in a form a person can act on. */
  readonly reason: string;

  constructor(input: string, reason: string) {
    super(`not a usable origin: ${reason}`);
    this.name = "UnusableOrigin";
    this.input = input;
    this.reason = reason;
  }
}

/**
 * Hosts where a scheme-less spelling means `http`.
 *
 * Everywhere else the guess is `https`, because everywhere else it is 2026.
 * Loopback is the exception because a development server on this machine is
 * overwhelmingly plain http, and the rule that matters — a scheme-less
 * spelling resolves to the same key as the schemed one a person would have
 * typed — is only satisfied by guessing the way they meant it. Somebody
 * running TLS on localhost writes the scheme, and is then believed.
 */
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * The origin — scheme, host and port — of a server named by `input`.
 *
 * Accepts a full URL (`https://app.test/anything`) or an authority on its own
 * (`app.test`, `app.test:8443`, `localhost:8080`). Idempotent: normalizing an
 * already-normalized origin returns it unchanged, which is what lets callers
 * normalize at the door and compare with `===` afterwards.
 *
 * @throws {UnusableOrigin} for anything else — including a scheme this daemon
 * does not speak. A refusal is the whole point: the previous fallback turned
 * unparseable input into a plausible-looking key and every caller downstream
 * believed it.
 */
export function normalizeOrigin(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") throw new UnusableOrigin(input, "it is empty");

  const direct = asHttpOrigin(trimmed);
  if (direct !== undefined) return direct;

  // Checked before the authority branch, so `ftp://x.test` refuses instead of
  // being read as a host called `ftp`. An input that named a scheme was not
  // trying to be a hostname, and treating it as one is exactly the silent
  // reinterpretation this module exists to stop.
  //
  // Split by remedy, because `http://` and `ftp://x.test` both land here and
  // want opposite advice: one supplied a scheme we speak and no host, the
  // other a host and a scheme we do not. A single message would have told
  // somebody typing `http://` to use http.
  const schemed = trimmed.indexOf("://");
  if (schemed !== -1) {
    const scheme = trimmed.slice(0, schemed).toLowerCase();
    throw new UnusableOrigin(
      input,
      scheme === "http" || scheme === "https"
        ? "it names a scheme but no host"
        : "it names a scheme this daemon does not speak — use http or https",
    );
  }

  const secure = asHttpOrigin(`https://${trimmed}`);
  if (secure === undefined) {
    throw new UnusableOrigin(input, "it does not name a host and port");
  }
  // Re-read the host from the parse that succeeded rather than the raw text:
  // `HUB.Test:8443` and `[::1]:8080` are both hosts, and only the parser
  // knows where each one ends.
  const host = new URL(`https://${trimmed}`).hostname;
  if (LOOPBACK.test(host)) {
    const local = asHttpOrigin(`http://${trimmed}`);
    if (local !== undefined) return local;
  }
  return secure;
}

/**
 * `candidate`'s origin, if it is an http(s) URL.
 *
 * There is no host check here, and its absence is load-bearing rather than an
 * oversight. `http` and `https` are WHATWG *special schemes*: the parser
 * requires a host for them and throws without one, so a URL that reaches the
 * return has a host by construction. A first draft of this function guarded
 * `hostname === ""` anyway, with a comment asserting `new URL("http://")`
 * parses to the origin `"http:"`. It does not — it throws — and the guard
 * could never fire. A mutation run found it in the only way an unreachable
 * branch is ever found: by surviving.
 *
 * The invariant it pretended to enforce is real and is now tested instead of
 * guarded, over generated input — see "every accepted origin names a server"
 * in origins.test.ts. A property that holds is worth more than a branch that
 * cannot run, and it cannot rot into a false comment.
 */
function asHttpOrigin(candidate: string): string | undefined {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return url.origin;
}

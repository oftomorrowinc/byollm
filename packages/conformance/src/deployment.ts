import { generateKeys, signRequest, signSiteRequest } from "@byollm/protocol";

/**
 * The deployment posture audit — what an outsider can do to a running relay.
 *
 * ## Why this exists as a separate surface
 *
 * `certify` drives a real daemon against a {@link ConformanceTarget}, and a
 * target may be an in-process handler or an HTTP server: "deliberately
 * transport-agnostic", which is the right call for certifying a *protocol*.
 *
 * It is also a blind spot, and byollm_009's ninth finding lived in it. Eight
 * freeze-gate findings came from tests where the site reached the relay by
 * calling `handle()` on an object it held a reference to — and a harness that
 * invokes the system under test directly cannot see anything about how the
 * system is *reached*. The site plane had no authentication at all. Nothing
 * noticed, because nothing in the suite was ever a stranger.
 *
 * So this suite is a stranger. It holds no credential, no key the deployment
 * knows, and no reference to any object inside it. It has a URL, which is
 * exactly what an attacker has. Every check asks the question that form of
 * access makes available:
 *
 * - can I enqueue work into someone's machines?
 * - can I read who is online and what they are holding?
 * - can I make a signature that is *well-formed* and be believed?
 * - is anything served that should not be on the internet?
 * - can I reach a handler by dressing a path up to look like one?
 *
 * ## What this is not
 *
 * Not a penetration test, and not exhaustive — it cannot be, because the next
 * hole will be in whatever gets added next. It is the specific class that has
 * already bitten, turned into something that runs. That is the same move as
 * every other check in this kit: a finding becomes a check so its *shape*
 * cannot recur silently.
 *
 * It is also deliberately **safe to run against production**: nothing here
 * writes, nothing floods, and every request is one an ordinary scanner would
 * make. A posture audit you are nervous about running is one nobody runs.
 */

/** One thing a stranger tried. */
export interface PostureCheck {
  /** Stable id, cited in output. */
  readonly id: string;
  /** What a person should understand from a failure. */
  readonly title: string;
  /** MUSTs this exercises, where one applies. Empty is honest, not a gap. */
  readonly cites: readonly string[];
  run(context: PostureContext): Promise<PostureOutcome>;
}

export interface PostureContext {
  /** The origin, as an outsider would type it. */
  readonly origin: string;
  /** Where the daemon plane is mounted. */
  readonly basePath: string;
  /** Injectable, so a test can drive this without a network. */
  readonly fetch: typeof fetch;
}

export interface PostureOutcome {
  readonly passed: boolean;
  /** What actually happened, in a sentence someone can act on. */
  readonly detail: string;
}

export interface PostureResult extends PostureOutcome {
  readonly id: string;
  readonly title: string;
  readonly cites: readonly string[];
}

export interface PostureReport {
  readonly origin: string;
  readonly passed: boolean;
  readonly results: readonly PostureResult[];
}

const STUB = {
  id: "posture-probe",
  kind: "llm.generate",
  owner: "nobody",
  audience: "self",
  sizeClass: "small",
  streaming: false,
  // Far enough out that a deployment cannot pass by calling it expired.
  deadlineAt: 4_102_444_800_000,
};

/** Refused, for any reason a server is entitled to refuse a stranger. */
const REFUSED = new Set([401, 403, 404]);

const outcome = (passed: boolean, detail: string): PostureOutcome => ({
  passed,
  detail,
});

export const POSTURE_CHECKS: readonly PostureCheck[] = Object.freeze([
  {
    id: "D001_SITE_ENQUEUE_REFUSES_UNSIGNED",
    title: "an anonymous caller cannot enqueue work in a site's name",
    cites: ["REQUESTS_SIGNED_NOT_BEARER"],
    async run({ origin, fetch: f }) {
      const response = await f(`${origin}/relay/site/enqueue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ siteId: "any-site", stub: STUB }),
      });
      // The finding, exactly: a relay that accepts this routes unsolicited
      // work to consenting users' private hardware. The payload that follows
      // is sealed by the real site or not at all, so nothing forged *runs* —
      // and dispatch to someone's machine is a breach whatever the
      // ciphertext does.
      return outcome(
        REFUSED.has(response.status),
        `POST /relay/site/enqueue answered ${String(response.status)}`,
      );
    },
  },
  {
    id: "D002_SITE_READS_REFUSE_UNSIGNED",
    title: "an anonymous caller cannot read who is online",
    cites: ["REQUESTS_SIGNED_NOT_BEARER"],
    async run({ origin, fetch: f }) {
      const paths = ["pending", "results"];
      const statuses: number[] = [];
      for (const path of paths) {
        const response = await f(
          `${origin}/relay/site/${path}?siteId=any-site`,
        );
        statuses.push(response.status);
      }
      // Reads matter as much as writes here. A blind relay's whole claim is
      // that it holds routing metadata and nothing else — which makes that
      // metadata the entire prize, and "who is online right now, on which
      // device, holding which lease" is the shape of it.
      return outcome(
        statuses.every((status) => REFUSED.has(status)),
        `pending/results answered ${statuses.map(String).join("/")}`,
      );
    },
  },
  {
    id: "D003_DAEMON_PLANE_REFUSES_UNSIGNED",
    title: "an anonymous caller cannot claim work",
    cites: ["REQUESTS_SIGNED_NOT_BEARER", "CLAIM_REQUIRES_CAPABILITY"],
    async run({ origin, basePath, fetch: f }) {
      const response = await f(`${origin}${basePath}/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: "0",
          runnerId: "nobody",
          max: 1,
          capabilities: [{ kind: "llm.generate", models: ["any"] }],
        }),
      });
      return outcome(
        REFUSED.has(response.status),
        `POST ${basePath}/claim answered ${String(response.status)}`,
      );
    },
  },
  {
    id: "D004_REFUSES_A_STRANGER_S_VALID_SIGNATURE",
    title: "a well-formed signature from an unknown key is not enough",
    cites: ["REQUESTS_SIGNED_NOT_BEARER", "KEYS_EXCHANGED_AT_CONSENT"],
    async run({ origin, basePath, fetch: f }) {
      // The check `D001`–`D003` cannot make: everything about these requests
      // is correct except whose key signed them. A deployment that verified
      // signatures without checking *whose* would pass the three above and
      // fail here, and that is a real implementation mistake rather than a
      // hypothetical one — verifying a signature and identifying a signer are
      // two steps, and the second is the one that gets skipped.
      const stranger = generateKeys(Date.now());
      const now = Date.now();

      const siteBody = JSON.stringify({ siteId: "any-site", stub: STUB });
      const siteSignature = signSiteRequest(stranger, {
        endpoint: "enqueue",
        siteId: "any-site",
        issuedAt: now,
        body: siteBody,
      });
      const site = await f(`${origin}/relay/site/enqueue`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-byollm-site": "any-site",
          "x-byollm-issued-at": String(siteSignature.issuedAt),
          "x-byollm-signature": siteSignature.signature,
        },
        body: siteBody,
      });

      const daemonBody = JSON.stringify({
        protocolVersion: "0",
        runnerId: "nobody",
        max: 1,
        capabilities: [{ kind: "llm.generate", models: ["any"] }],
      });
      const daemonSignature = signRequest(stranger, {
        endpoint: "claim",
        runnerId: "nobody",
        issuedAt: now,
        body: daemonBody,
      });
      const daemon = await f(`${origin}${basePath}/claim`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-byollm-runner": "nobody",
          "x-byollm-issued-at": String(daemonSignature.issuedAt),
          "x-byollm-signature": daemonSignature.signature,
        },
        body: daemonBody,
      });

      return outcome(
        REFUSED.has(site.status) && REFUSED.has(daemon.status),
        `signed-by-a-stranger answered ${String(site.status)} (site) and ${String(daemon.status)} (daemon)`,
      );
    },
  },
  {
    id: "D005_NO_DEBUG_SURFACE",
    title: "the debug page is not on the internet",
    cites: [],
    async run({ origin, basePath, fetch: f }) {
      // Finding eleven. The relay's debug page shows no prompt or result text
      // — it does not have them — and it does show every routed job, who
      // claimed it, and every lease in flight. Closing the site plane while
      // leaving this open protects the data from one door and not the other.
      const paths = ["/debug", `${basePath}/debug`];
      const statuses: number[] = [];
      for (const path of paths) {
        const response = await f(`${origin}${path}`);
        statuses.push(response.status);
      }
      return outcome(
        statuses.every((status) => status !== 200),
        `debug paths answered ${statuses.map(String).join("/")}`,
      );
    },
  },
  {
    id: "D006_NO_PATH_DISPATCH",
    title: "a handler cannot be reached by dressing a path up to look like it",
    cites: ["REQUESTS_SIGNED_NOT_BEARER"],
    async run({ origin, fetch: f }) {
      // A router that dispatched on the last path segment would serve
      // `/literally/anything/claim`. Worth checking from outside because it
      // is invisible from inside: an in-process harness calls the handler by
      // name and never constructs a URL that could be misread.
      const response = await f(`${origin}/literally/anything/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocolVersion: "0", max: 1 }),
      });
      return outcome(
        response.status === 404,
        `POST /literally/anything/claim answered ${String(response.status)}`,
      );
    },
  },
  {
    id: "D007_TLS_ONLY",
    title: "the deployment is reached over TLS, and plaintext is not served",
    cites: [],
    async run({ origin, fetch: f }) {
      if (!origin.startsWith("https://")) {
        // Not a failure when auditing a local hub on purpose, but never
        // silent: an audit that reports "posture good" against an http origin
        // has certified the one thing that matters least.
        return outcome(false, `origin is ${origin} — this audit saw no TLS`);
      }
      // Payloads are sealed end to end and would survive plaintext transport.
      // Request signatures would not: on the wire they are replayable by
      // anyone on the path for the length of the freshness window, and every
      // site-plane and daemon-plane call carries one.
      const plain = origin.replace("https://", "http://");
      const response = await f(`${plain}/healthz`, { redirect: "manual" });
      const redirected =
        response.status >= 300 &&
        response.status < 400 &&
        (response.headers.get("location") ?? "").startsWith("https://");
      return outcome(
        redirected || REFUSED.has(response.status),
        `plaintext answered ${String(response.status)}${
          redirected ? " and redirects to https" : ""
        }`,
      );
    },
  },
]);

/**
 * Audit a running deployment. Holds nothing it was not given a URL for.
 *
 * Every check runs even after one fails, because a posture report's job is to
 * be a complete picture rather than the first thing that went wrong.
 */
export async function auditDeployment(options: {
  url: string;
  basePath?: string;
  fetch?: typeof fetch;
  onProgress?: (result: PostureResult) => void;
}): Promise<PostureReport> {
  const origin = options.url.replace(/\/+$/, "");
  const context: PostureContext = {
    origin,
    basePath: (options.basePath ?? "/byollm").replace(/\/+$/, ""),
    fetch: options.fetch ?? globalThis.fetch,
  };

  const results: PostureResult[] = [];
  for (const check of POSTURE_CHECKS) {
    let result: PostureResult;
    try {
      result = { ...(await check.run(context)), ...describe(check) };
    } catch (error) {
      // A check that cannot complete is a failure, not a skip. An audit that
      // silently drops a probe it could not run reports a posture nobody
      // measured — which is worse than reporting none at all.
      result = {
        ...describe(check),
        passed: false,
        detail: `the probe failed: ${error instanceof Error ? error.message : "unknown"}`,
      };
    }
    results.push(result);
    options.onProgress?.(result);
  }

  return {
    origin,
    passed: results.every((result) => result.passed),
    results,
  };
}

const describe = (check: PostureCheck) => ({
  id: check.id,
  title: check.title,
  cites: check.cites,
});

export function formatPostureReport(report: PostureReport): string {
  const lines = [`deployment posture — ${report.origin}`, ""];
  for (const result of report.results) {
    lines.push(`  ${result.passed ? "ok  " : "FAIL"}  ${result.id}`);
    lines.push(`        ${result.title}`);
    lines.push(`        ${result.detail}`);
    if (result.cites.length > 0) {
      lines.push(`        cites ${result.cites.join(", ")}`);
    }
  }
  const passed = report.results.filter((result) => result.passed).length;
  lines.push(
    "",
    report.passed
      ? `${String(passed)}/${String(report.results.length)} — a stranger got nowhere.`
      : `${String(passed)}/${String(report.results.length)} — a stranger got somewhere. See FAIL above.`,
    "",
  );
  return lines.join("\n");
}

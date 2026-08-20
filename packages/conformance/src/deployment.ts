import { connect as tlsConnect } from "node:tls";
import { request as httpsRequest } from "node:https";
import {
  PROTOCOL_VERSION,
  generateKeys,
  signRequest,
  signSiteRequest,
} from "@byollm/protocol";

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
  /**
   * The origin's own address, behind whatever edge fronts it — `D008`.
   *
   * Optional because most deployments have no separate origin, and a check
   * that guessed one would report a posture it never tested.
   */
  readonly originAddress?: string;
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

/**
 * Refused **by a byollm relay**, rather than by nothing being there.
 *
 * The distinction is the whole difference between a posture audit and a
 * connectivity check, and this suite shipped without it for an hour. Running
 * against `hub.byollm.cloud` before its Ingress had a matching host rule, the
 * load balancer answered 404 to everything from its own error page — and the
 * audit reported 6/7, because 404 is a refusal and every probe got one.
 *
 * A completely dead deployment scored better than a working one. That is the
 * assertion-that-cannot-fail wearing its most convincing disguise: not a check
 * that never fails, but one that passes for a reason unrelated to the property
 * it claims.
 *
 * So a refusal has to be *byollm's* refusal: the protocol answers errors as
 * JSON with an `error` field, and Google's `backend NotFound` page does not.
 */
async function refusedByByollm(
  response: Response,
): Promise<{ ok: boolean; why: string }> {
  if (!REFUSED.has(response.status)) {
    return { ok: false, why: `answered ${String(response.status)}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      why:
        `answered ${String(response.status)} but not as byollm — ` +
        `something else is serving this path`,
    };
  }
  const shaped =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { error?: unknown }).error === "string";
  return shaped
    ? { ok: true, why: `answered ${String(response.status)}` }
    : {
        ok: false,
        why:
          `answered ${String(response.status)} with a body byollm would not ` +
          `send — something else is serving this path`,
      };
}

const outcome = (passed: boolean, detail: string): PostureOutcome => ({
  passed,
  detail,
});

/**
 * The certificate the **origin** serves, read off the connection.
 *
 * Connects to the origin's own address with the pinned hostname in SNI, which
 * is what an edge does when it validates. Certificate verification is off for
 * `D008`'s reason: the question is what this address presents, not whether to
 * trust it.
 *
 * **It must be the origin, not the hostname.** Written first as a plain
 * connection to `hub.byollm.cloud`, which goes *through* Cloudflare and
 * returns Cloudflare's own edge certificate — one that names the host by
 * construction and auto-renews on a ninety-day cycle. `D009` passed on it
 * while the origin's certificate named nothing relevant, which is the exact
 * condition finding 45 describes; `D010` then failed with "84 days" and
 * revealed that both were measuring the edge.
 *
 * Two certificates, two purposes: the edge one protects visitors and
 * Cloudflare renews it, and the origin one is what the edge validates and
 * nobody renews automatically. Only the second is this audit's business.
 */
async function servedCertificate(
  address: string,
  host: string,
): Promise<{ names: readonly string[]; validTo: string } | undefined> {
  return new Promise((resolve) => {
    const socket = tlsConnect(
      {
        host: address,
        servername: host,
        port: 443,
        timeout: 15_000,
        rejectUnauthorized: false,
      },
      () => {
        const peer = socket.getPeerCertificate();
        const alt = (peer.subjectaltname ?? "")
          .split(",")
          .map((entry) => entry.trim().replace(/^DNS:/, ""))
          .filter((entry) => entry.length > 0);
        const cn: unknown = peer.subject.CN;
        socket.end();
        resolve({
          names: alt.length > 0 ? alt : [typeof cn === "string" ? cn : ""],
          validTo: peer.valid_to,
        });
      },
    );
    socket.on("error", () => {
      resolve(undefined);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(undefined);
    });
  });
}

export const POSTURE_CHECKS: readonly PostureCheck[] = Object.freeze([
  {
    id: "D001_SITE_ENQUEUE_REFUSES_UNSIGNED",
    title: "an anonymous caller cannot enqueue work in a site's name",
    cites: ["REQUESTS_SIGNED_NOT_BEARER"],
    async run({ origin, fetch: f }) {
      const response = await f(`${origin}/relay/site/enqueue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The version, because the auditor is a site-plane client like any
        // other (§B.4). Without it the relay refuses on the handshake and
        // this check would report "refused" for a reason that has nothing to
        // do with signatures — success for an unrelated reason, which is the
        // failure this whole file was written against.
        body: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          siteId: "any-site",
          stub: STUB,
        }),
      });
      // The finding, exactly: a relay that accepts this routes unsolicited
      // work to consenting users' private hardware. The payload that follows
      // is sealed by the real site or not at all, so nothing forged *runs* —
      // and dispatch to someone's machine is a breach whatever the
      // ciphertext does.
      const refusal = await refusedByByollm(response);
      return outcome(refusal.ok, `POST /relay/site/enqueue ${refusal.why}`);
    },
  },
  {
    id: "D002_SITE_READS_REFUSE_UNSIGNED",
    title: "an anonymous caller cannot read who is online",
    cites: ["REQUESTS_SIGNED_NOT_BEARER"],
    async run({ origin, fetch: f }) {
      // Reads matter as much as writes here. A blind relay's whole claim is
      // that it holds routing metadata and nothing else — which makes that
      // metadata the entire prize, and "who is online right now, on which
      // device, holding which lease" is the shape of it.
      const why: string[] = [];
      let ok = true;
      for (const path of ["pending", "results"]) {
        const response = await f(
          `${origin}/relay/site/${path}?siteId=any-site&protocolVersion=${PROTOCOL_VERSION}`,
        );
        const refusal = await refusedByByollm(response);
        ok &&= refusal.ok;
        why.push(`${path} ${refusal.why}`);
      }
      return outcome(ok, why.join("; "));
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
      const refusal = await refusedByByollm(response);
      return outcome(refusal.ok, `POST ${basePath}/claim ${refusal.why}`);
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

      const siteBody = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        siteId: "any-site",
        stub: STUB,
      });
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

      const siteRefusal = await refusedByByollm(site);
      const daemonRefusal = await refusedByByollm(daemon);
      return outcome(
        siteRefusal.ok && daemonRefusal.ok,
        `signed by a stranger: site ${siteRefusal.why}, daemon ${daemonRefusal.why}`,
      );
    },
  },
  {
    id: "D011_VERSION_NAMED_ON_BOTH_PLANES",
    title: "an unknown protocol version is refused by name, not by accident",
    cites: ["VERSION_HANDSHAKE_REQUIRED"],
    async run({ origin, fetch: f }) {
      // byollm_009 §B.4. A mismatch that arrives as a generic `bad-request`
      // leaves a daemon and a server to discover they disagree by failing,
      // with nothing in the answer naming the disagreement or the fix — which
      // is what this relay did on every endpoint until the handshake landed.
      //
      // **Both planes, because the gap was a whole plane.** The daemon plane
      // had version literals in its schemas and the site plane had none, so a
      // check that probed one would have reported a handshake the other did
      // not have.
      const probes: { where: string; response: Response }[] = [
        {
          where: "daemon",
          response: await f(`${origin}/byollm/claim`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ protocolVersion: "99", max: 1 }),
          }),
        },
        {
          where: "site",
          response: await f(`${origin}/relay/site/enqueue`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              protocolVersion: "99",
              siteId: "any-site",
              stub: STUB,
            }),
          }),
        },
      ];

      const wrong: string[] = [];
      for (const probe of probes) {
        let body: { error?: string; supported?: unknown } = {};
        try {
          body = (await probe.response.json()) as typeof body;
        } catch {
          wrong.push(
            `${probe.where}: answered ${String(probe.response.status)} and not as byollm`,
          );
          continue;
        }
        if (body.error !== "unsupported-protocol-version") {
          wrong.push(
            `${probe.where}: answered ${String(probe.response.status)} ${String(body.error)}`,
          );
          continue;
        }
        // Named, not merely refused: the field a client acts on.
        if (!Array.isArray(body.supported)) {
          wrong.push(`${probe.where}: refused without naming what it speaks`);
        }
      }

      return outcome(
        wrong.length === 0,
        wrong.length === 0
          ? "both planes name the version they speak"
          : wrong.join("; "),
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
        // **Not merely "not 200"** — cloud_009 §3 made the page per-site, so
        // an enabled one answers a probe with no site id `400` rather than
        // rendering. A check that accepted anything but 200 would pass
        // against a deployment whose debug page is one query parameter away,
        // which is finding eleven with a shorter walk.
        //
        // `404` is the only answer that means the route does not exist. The
        // reference relay says exactly that when its debug page is off, and
        // says `400` when it is on and the caller named no site.
        statuses.every((status) => status === 404),
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
      const refusal = await refusedByByollm(response);
      return outcome(
        refusal.ok && response.status === 404,
        `POST /literally/anything/claim ${refusal.why}`,
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

  {
    id: "D008_ORIGIN_NOT_PUBLIC",
    title: "the origin answers the edge, and nobody else",
    cites: [],
    async run({ origin, originAddress }) {
      // cloud_008 findings 44/45. A load balancer has a public address, and
      // an edge in front of it is a convention rather than a boundary until
      // the origin refuses everything else: anyone who resolves the address
      // reaches the hub past every WAF rule, rate limit and bot check the
      // zone applies, and appears in no edge log doing it.
      //
      // Bounded, and not nothing. Requests are signed and payloads sealed, so
      // a stranger cannot forge a claim or read a job — but they can reach
      // `/byollm/pair` and every plane endpoint at whatever rate the origin
      // serves, which is exactly the surface the edge exists to absorb.
      //
      // Skipped rather than failed when no address is supplied: an auditor
      // who does not know where the origin lives cannot ask this, and
      // guessing would be a check that passes for not looking.
      if (originAddress === undefined) {
        // **Fails, not skips.** This file's own rule, and the suite already
        // had a test for it: an audit that drops a check it could not run
        // reports a posture nobody measured, which reads identically to one
        // measured and found good.
        //
        // Written as a pass first, on the reasoning that most deployments
        // have no separate origin — and that test failed it immediately. The
        // reasoning was wrong in the way this whole audit exists to catch:
        // "probably fine" and "verified" must not print the same.
        return outcome(
          false,
          "no origin address given — this posture was not measured " +
            "(pass the origin's address as the third argument)",
        );
      }

      // Asked the way an attacker would, which `fetch` cannot.
      //
      // The first version of this check used `fetch` and passed for the wrong
      // reason: TLS fails against a bare IP because the certificate does not
      // name it, the request never reaches the load balancer's backend, and a
      // connection error read as "refused". It would have reported a green
      // origin with no policy attached at all.
      //
      // Plain HTTP does not work either — the frontend answers `301` before
      // any backend is chosen, so the policy is never consulted.
      //
      // So: HTTPS to the address, with the real host in SNI, and certificate
      // verification **off**. That is not a lapse. The property under test is
      // whether an address answers a stranger, not who the answer comes from,
      // and refusing to look because the certificate does not match the IP is
      // how the first version passed while proving nothing. Nothing else in
      // this kit may copy it.
      const host = new URL(origin).host;
      const status = await new Promise<number | "refused">((resolve) => {
        const request = httpsRequest(
          {
            host: originAddress,
            servername: host,
            headers: { host },
            path: "/readyz",
            method: "GET",
            rejectUnauthorized: false,
            timeout: 15_000,
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        request.on("error", () => {
          resolve("refused");
        });
        request.on("timeout", () => {
          request.destroy();
          resolve("refused");
        });
        request.end();
      });

      if (status === "refused") {
        // Nothing answered at all, which is the strongest form of this.
        return outcome(true, "the origin address refused the connection");
      }
      return outcome(
        status === 403,
        `the origin answered ${String(status)} to a direct request`,
      );
    },
  },

  {
    id: "D009_CERT_NAMES_THE_PINNED_HOST",
    title: "the certificate names the hostname daemons pin",
    cites: [],
    async run({ origin, originAddress }) {
      // cloud_008 finding 45. The load balancer held one certificate, for the
      // *origin* hostname, and `hub.byollm.cloud` — the name every daemon
      // pins and the edge validates — was not on it. Cloudflare cannot verify
      // a certificate that does not name what it asked for, so the zone sat
      // on plain Full: encrypted to the origin, not checking who the origin
      // is, while every daemon's pinned site keys arrive through it.
      //
      // Nothing said so. "There is a certificate" and "there is a certificate
      // for the name being validated" printed identically, which is why this
      // check exists rather than a note in a runbook.
      //
      // Asked over TLS with the real SNI and read from the peer, so it is the
      // certificate actually served rather than one somebody configured.
      const host = new URL(origin).host;
      if (originAddress === undefined) {
        return outcome(
          false,
          "no origin address given — this posture was not measured. " +
            "Asking the hostname reads the edge's certificate, which names it " +
            "by construction and proves nothing about the origin",
        );
      }
      const served = await servedCertificate(originAddress, host);
      const names = served?.names;

      if (names === undefined) {
        return outcome(
          false,
          `could not read a certificate from ${originAddress}`,
        );
      }
      const covered = names.some(
        (name) =>
          name === host ||
          (name.startsWith("*.") && host.endsWith(name.slice(1))),
      );
      return outcome(
        covered,
        covered
          ? `served a certificate naming ${host}`
          : `the certificate names ${names.join(", ")} — not ${host}`,
      );
    },
  },

  {
    id: "D010_CERT_HAS_LIFE_LEFT",
    title: "the certificate is not about to expire",
    cites: [],
    async run({ origin, originAddress }) {
      // A long-lived certificate is the kind whose expiry gets written in a
      // note and never looked at again. The one this deployment now depends
      // on runs to 2041, which makes it *more* likely to be forgotten, not
      // less — and it is load-bearing: it is what the edge validates before
      // it will carry a daemon's traffic at all.
      //
      // Measured from the artefact rather than from the note. A date somebody
      // owns has to mean a date something checks.
      //
      // Ninety days: long enough that a renewal is scheduled rather than
      // scrambled, short enough that the warning is still about something
      // real.
      const host = new URL(origin).host;
      if (originAddress === undefined) {
        return outcome(
          false,
          "no origin address given — this posture was not measured " +
            "(the edge's certificate is Cloudflare's to renew, not ours)",
        );
      }
      const served = await servedCertificate(originAddress, host);
      if (served === undefined) {
        return outcome(
          false,
          `could not read a certificate from ${originAddress}`,
        );
      }
      const days = Math.round(
        (Date.parse(served.validTo) - Date.now()) / 86_400_000,
      );
      return outcome(
        days > 90,
        `the certificate expires ${served.validTo} (${String(days)} days)`,
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
  /** The origin behind the edge, for `D008`. */
  originAddress?: string;
  fetch?: typeof fetch;
  onProgress?: (result: PostureResult) => void;
}): Promise<PostureReport> {
  const origin = options.url.replace(/\/+$/, "");
  const context: PostureContext = {
    origin,
    basePath: (options.basePath ?? "/byollm").replace(/\/+$/, ""),
    ...(options.originAddress === undefined
      ? {}
      : { originAddress: options.originAddress }),
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

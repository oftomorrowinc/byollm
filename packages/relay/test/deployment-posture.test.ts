import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cryptoReady, generateKeys, publicIdentityOf } from "@byollm/protocol";
import { auditDeployment, POSTURE_CHECKS } from "@byollm/conformance";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Relay } from "../src/index.js";
import { SITE_ID, fixtureFor } from "./harness.js";

/**
 * The deployment posture audit, against a relay served over HTTP.
 *
 * Two things are under test here, and the second is the point.
 *
 * The first is that the reference relay refuses every stranger — and that,
 * served naked, it still fails two checks: it is plain HTTP, and it serves its
 * own debug page. Both are right for a library and wrong for a deployment,
 * and the audit is where somebody running this finds that out.
 *
 * The second is that **the audit can fail**. Every check below is also run
 * against a deliberately-broken server that answers the way a careless
 * deployment would, because a posture suite that passes against everything is
 * the assertion-that-cannot-fail in its most dangerous form: it would have
 * reported "posture good" against the relay as it stood before alpha.8, which
 * is the exact state it exists to catch.
 */

let servers: Server[] = [];
afterEach(() => {
  for (const server of servers) server.close();
  servers = [];
});

/** Serve a handler on an ephemeral port and return its origin. */
async function serve(
  handler: (request: Request) => Promise<Response>,
): Promise<string> {
  const server = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      const method = req.method ?? "GET";
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const response = await handler(
        new Request(new URL(req.url ?? "/", "http://127.0.0.1"), {
          method,
          headers,
          ...(method === "GET" || method === "HEAD" ? {} : { body }),
        }),
      );
      const text = await response.text();
      res.writeHead(response.status, {
        "content-type":
          response.headers.get("content-type") ?? "application/json",
      });
      res.end(text);
    };
    handle().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

describe("the deployment posture audit", () => {
  beforeAll(async () => {
    await cryptoReady();
  });

  it("refuses every stranger, and still fails the two checks a bare relay must", async () => {
    const site = publicIdentityOf(generateKeys(Date.now()));
    const relay = new Relay({ siteId: SITE_ID, fixture: fixtureFor(site) });
    const origin = await serve((request) => relay.handle(request));

    const report = await auditDeployment({ url: origin });
    const failed = report.results.filter((result) => !result.passed);

    // Two failures, and both are the audit being honest about what serving
    // this package naked would mean:
    //
    //   * `D007` — plain HTTP on a loopback port. A check that quietly
    //     accepted an http:// origin would certify nothing about the property
    //     that matters most.
    //   * `D005` — **the reference relay serves its own debug page**, which
    //     is right for a library and wrong for a deployment. The hub refuses
    //     the route before the relay sees it; anyone else running this has to
    //     do the same, and this is where they find that out.
    //
    // Written as an exact list rather than a count, so a check that starts
    // failing for a new reason shows up as a changed list instead of the same
    // number.
    expect(failed.map((result) => result.id).sort()).toEqual(
      [
        "D005_NO_DEBUG_SURFACE",
        "D007_TLS_ONLY",
        // Added with `D008` and `D009`: an in-process relay has no origin
        // behind an edge and serves no certificate, and the audit says so
        // rather than passing. A posture nobody measured must not read like
        // one that was — the same rule `D009` enforces about certificates.
        "D008_ORIGIN_NOT_PUBLIC",
        "D009_CERT_NAMES_THE_PINNED_HOST",
      ].sort(),
    );

    // Everything a stranger could actually *do*, refused.
    const auth = report.results.filter((result) =>
      result.cites.includes("REQUESTS_SIGNED_NOT_BEARER"),
    );
    expect(auth.length).toBeGreaterThanOrEqual(4);
    expect(auth.every((result) => result.passed)).toBe(true);
  });

  it("does not serve the debug page as 200 through a gateway that hides it", async () => {
    const site = publicIdentityOf(generateKeys(Date.now()));
    const relay = new Relay({ siteId: SITE_ID, fixture: fixtureFor(site) });
    // What the hub does: refuse the route before the relay sees it.
    const origin = await serve(async (request) => {
      if (new URL(request.url).pathname.endsWith("/debug")) {
        return new Response(JSON.stringify({ error: "not-found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return relay.handle(request);
    });

    const report = await auditDeployment({ url: origin });
    const debug = report.results.find(
      (result) => result.id === "D005_NO_DEBUG_SURFACE",
    );
    expect(debug?.passed).toBe(true);
  });

  it("fails against a deployment that trusts whoever asks", async () => {
    // The relay as it stood before alpha.8, reproduced: every endpoint
    // answers, and the caller is whoever the body says. Not a strawman — a
    // published package behaved this way, and this suite exists because
    // nothing in the kit was ever a stranger to notice.
    const origin = await serve((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/debug")) {
        return Promise.resolve(
          new Response("<html>every routed job</html>", {
            headers: { "content-type": "text/html" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ jobs: [], accepted: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    const report = await auditDeployment({ url: origin });
    expect(report.passed).toBe(false);

    // Named individually rather than counted: a count would still pass if the
    // suite failed everything for one shared reason, and the claim being made
    // is that each check catches its own thing.
    const failed = new Set(
      report.results.filter((r) => !r.passed).map((r) => r.id),
    );
    expect(failed).toContain("D001_SITE_ENQUEUE_REFUSES_UNSIGNED");
    expect(failed).toContain("D002_SITE_READS_REFUSE_UNSIGNED");
    expect(failed).toContain("D003_DAEMON_PLANE_REFUSES_UNSIGNED");
    expect(failed).toContain("D004_REFUSES_A_STRANGER_S_VALID_SIGNATURE");
    expect(failed).toContain("D005_NO_DEBUG_SURFACE");
    expect(failed).toContain("D006_NO_PATH_DISPATCH");
  });

  it("fails against a deployment that is not there at all", async () => {
    // The hole this suite shipped with, for about an hour.
    //
    // Run against `hub.byollm.cloud` before its Ingress had a matching host
    // rule, the load balancer answered 404 to everything from Google's own
    // error page — and the audit reported 6/7. A completely unrouted
    // deployment scored better than a working one, because 404 is a refusal
    // and every probe got one.
    //
    // That is the assertion-that-cannot-fail in its most convincing disguise:
    // not a check that never fails, but one that passes for a reason
    // unrelated to the property it claims. So a refusal now has to be
    // *byollm's* refusal, and this is a gateway that refuses everything while
    // knowing nothing about byollm.
    const origin = await serve(() =>
      Promise.resolve(
        new Response(
          "<html><h2>Error: Not Found</h2><p>backend NotFound</p></html>",
          { status: 404, headers: { "content-type": "text/html" } },
        ),
      ),
    );

    const report = await auditDeployment({ url: origin });
    expect(report.passed).toBe(false);

    const failed = new Set(
      report.results.filter((r) => !r.passed).map((r) => r.id),
    );
    // Everything that claims to have observed a refusal must fail here,
    // because none of these refusals came from byollm.
    expect(failed).toContain("D001_SITE_ENQUEUE_REFUSES_UNSIGNED");
    expect(failed).toContain("D002_SITE_READS_REFUSE_UNSIGNED");
    expect(failed).toContain("D003_DAEMON_PLANE_REFUSES_UNSIGNED");
    expect(failed).toContain("D004_REFUSES_A_STRANGER_S_VALID_SIGNATURE");
    expect(failed).toContain("D006_NO_PATH_DISPATCH");

    // `D005` still passes, and correctly: no debug page is being served. It
    // is the one check whose question a dead deployment genuinely answers.
    const debug = report.results.find(
      (result) => result.id === "D005_NO_DEBUG_SURFACE",
    );
    expect(debug?.passed).toBe(true);
  });

  it("fails against a gateway that refuses in JSON of its own", async () => {
    // The HTML case above does not exercise the whole check: an HTML body
    // fails to parse, so the shape test is never reached, and a mutation that
    // accepted *any* JSON survived. Plenty of gateways answer errors in JSON.
    //
    // So: 404, valid JSON, and not byollm's — a body with `message` where the
    // protocol sends `error`. Close enough to look right in a log, which is
    // exactly why the check reads the field rather than the content type.
    const origin = await serve(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "no route matched" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const report = await auditDeployment({ url: origin });
    const failed = new Set(
      report.results.filter((r) => !r.passed).map((r) => r.id),
    );
    expect(failed).toContain("D001_SITE_ENQUEUE_REFUSES_UNSIGNED");
    expect(failed).toContain("D003_DAEMON_PLANE_REFUSES_UNSIGNED");
    expect(failed).toContain("D006_NO_PATH_DISPATCH");
  });

  it("fails a probe it cannot complete rather than skipping it", async () => {
    // An audit that silently drops a check it could not run reports a posture
    // nobody measured, which reads identically to one that was measured and
    // found good.
    const report = await auditDeployment({
      url: "http://127.0.0.1:1",
      fetch: () => Promise.reject(new Error("connection refused")),
    });
    expect(report.passed).toBe(false);
    expect(report.results.every((result) => !result.passed)).toBe(true);
    expect(report.results[0]?.detail).toContain("the probe failed");
  });

  it("cites a MUST wherever one applies", () => {
    // Not every posture question is a protocol MUST — "the debug page is not
    // public" is a deployment property of this relay, and claiming a MUST for
    // it would launder a local decision as a protocol requirement. But a
    // check that exercises one should say so, or the audit and the registry
    // drift into two unrelated documents.
    const authChecks = POSTURE_CHECKS.filter(
      (check) => check.id.includes("REFUSES") || check.id.includes("UNSIGNED"),
    );
    expect(authChecks.length).toBeGreaterThan(0);
    for (const check of authChecks) {
      expect(check.cites).toContain("REQUESTS_SIGNED_NOT_BEARER");
    }
  });
});

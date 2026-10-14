// A stand-in for signals' GET /api/log (job #944), ported from
// of-tomorrow-website's tests/fixtures/log-feed.mjs: newest first, ?scope (a
// prefix; 404 for a scope that is not public), ?since, ?limit, ?live=1, CORS *.
// The live lines are fenced by scope, as the real feed's are. RSS is left
// out: byo-llm.com does not read it.
//
// Imported, `serve()` starts one on a free port. Run as a script it serves
// on $PORT (default 4398) for a browser walk; LIVE=0 serves nothing claimed.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const fixture = JSON.parse(
  readFileSync(new URL("./log-feed.json", import.meta.url), "utf8"),
);

const inScope = (scope) => (x) =>
  x.scope === scope || x.scope.startsWith(`${scope}.`);

/** The feed's answer to a URL: { status, headers, body }. */
export function answer(href, { live = true } = {}) {
  const url = new URL(href, "http://fixture");
  const headers = {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "application/json",
  };
  const fail = (status, message) => ({
    status,
    headers,
    body: JSON.stringify({ error: { code: "not_found", message } }),
  });
  if (url.pathname !== "/api/log") return fail(404, "no such route");
  const scope = url.searchParams.get("scope") || "ot";
  if (!fixture.scopes.includes(scope))
    return fail(404, `no public log for '${scope}'`);
  const since = url.searchParams.has("since")
    ? Number(url.searchParams.get("since"))
    : null;
  const limit = Math.min(
    200,
    Math.max(1, Number(url.searchParams.get("limit") ?? 50)),
  );
  let entries = fixture.entries
    .filter(inScope(scope))
    .filter((e) => since === null || e.seq > since)
    .sort((a, b) => b.seq - a.seq);
  entries = since === null ? entries.slice(0, limit) : entries.slice(-limit);
  const wantsLive = ["1", "true"].includes(url.searchParams.get("live") ?? "");
  return {
    status: 200,
    headers,
    body: JSON.stringify({
      scope,
      person: null,
      entries,
      next_since: entries.reduce((m, e) => Math.max(m, e.seq), since ?? 0),
      ...(wantsLive
        ? { live: live ? fixture.live.filter(inScope(scope)) : [] }
        : {}),
    }),
  };
}

/** A fixture feed on `port` (0: a free one). Resolves to { url, close }. */
export function serve({ port = 0, live = true } = {}) {
  const server = createServer((req, res) => {
    const { status, headers, body } = answer(req.url, { live });
    res.writeHead(status, headers);
    res.end(body);
  });
  return new Promise((done) =>
    server.listen(port, "127.0.0.1", () =>
      done({
        url: `http://127.0.0.1:${server.address().port}/api/log`,
        close: () => new Promise((closed) => server.close(closed)),
      }),
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serve({
    port: Number(process.env.PORT ?? 4398),
    live: process.env.LIVE !== "0",
  });
  process.stdout.write(`log fixture feed at ${url}\n`);
}

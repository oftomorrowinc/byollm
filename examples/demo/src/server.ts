/**
 * A complete BYOLLM app in one file.
 *
 * ```bash
 * pnpm --filter @byollm/example-demo start
 * # then, in another terminal, with Ollama running:
 * BYOLLM_HOME=/tmp/byollm-demo npx byollm@alpha connect http://127.0.0.1:8787
 * ```
 *
 * It serves three things: the protocol endpoints a daemon talks to, a pairing
 * page where you approve your own machine, and a page that enqueues a job and
 * renders the answer. That is the whole integration — one mount, one store,
 * one `enqueue`.
 *
 * Auth here is a cookie containing a username, because a demo that also
 * implemented sign-in would bury the part worth reading. A real app uses its
 * own session; the only thing BYOLLM requires is that **the owner comes from
 * your session and never from the daemon**.
 */
import { createServer, type IncomingMessage } from "node:http";
import {
  ByollmApp,
  MemoryStore,
  createFetchHandler,
  normalizeUserCode,
} from "@byollm/server";

const PORT = Number(process.env["PORT"] ?? 8787);
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;

const store = new MemoryStore();
const app = new ByollmApp({ store });
const protocol = createFetchHandler({
  store,
  verificationUrl: `${ORIGIN}/pair`,
});

/** The signed-in user, such as it is. */
function currentUser(request: Request): string {
  const cookie = request.headers.get("cookie") ?? "";
  const match = /byollm_demo_user=([^;]+)/.exec(cookie);
  return match?.[1] === undefined ? "demo-user" : decodeURIComponent(match[1]);
}

const html = (body: string): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>BYOLLM demo</title>
     <style>
       body{font:16px/1.6 ui-sans-serif,system-ui;max-width:44rem;margin:3rem auto;padding:0 1rem;
            background:#0b0d10;color:#e6e8eb}
       code,pre{background:#15181d;padding:.15rem .35rem;border-radius:4px}
       pre{padding:1rem;overflow-x:auto;white-space:pre-wrap}
       input,textarea,button{font:inherit;padding:.5rem;border-radius:6px;
            border:1px solid #2a2f37;background:#15181d;color:inherit}
       button{background:#1f6feb;border-color:#1f6feb;cursor:pointer}
       .warn{border-left:3px solid #d29922;padding-left:1rem;color:#d29922}
       a{color:#58a6ff}
     </style>${body}`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

const server = createServer((req, res) => {
  (async () => {
    const request = new Request(`${ORIGIN}${req.url ?? "/"}`, {
      method: req.method ?? "GET",
      headers: req.headers as Record<string, string>,
      ...(req.method === "POST" || req.method === "PUT"
        ? { body: await readBody(req), duplex: "half" }
        : {}),
    });

    const response = await route(request);
    res.writeHead(
      response.status,
      Object.fromEntries(response.headers.entries()),
    );
    res.end(Buffer.from(await response.arrayBuffer()));
  })().catch((error: unknown) => {
    // A handler that throws must answer, not take the process down with it.
    process.stderr.write(`request failed: ${String(error)}\n`);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("internal error");
  });
});

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // 1. The protocol surface. One mount; nothing else to wire.
  if (url.pathname.startsWith("/byollm/")) return protocol(request);

  const user = currentUser(request);

  // 2. The pairing page — where a daemon's code becomes a runner.
  if (url.pathname === "/pair" && request.method === "POST") {
    // `request.formData()` is deprecated server-side; these forms are plain
    // urlencoded, so parsing them directly is both simpler and supported.
    const form = new URLSearchParams(await request.text());
    const code = normalizeUserCode(form.get("code") ?? "");
    try {
      // The owner comes from OUR session. This is the load-bearing line.
      const runner = await app.approvePairing({ userCode: code, owner: user });
      return html(
        `<h1>Paired</h1><p><code>${escapeHtml(runner.label)}</code> is now
         running jobs for <b>${escapeHtml(user)}</b>.</p>
         <p><a href="/">Try a job →</a></p>`,
      );
    } catch (error) {
      return html(
        `<h1>Could not pair</h1>
         <p class="warn">${escapeHtml(error instanceof Error ? error.message : "unknown error")}</p>
         <p><a href="/pair">Try again</a></p>`,
      );
    }
  }

  if (url.pathname === "/pair") {
    const pending = url.searchParams.get("code");
    const info = pending === null ? null : await app.pendingPairing(pending);
    return html(
      `<h1>Connect a machine</h1>
       <p>Signed in as <b>${escapeHtml(user)}</b>.</p>
       <p>Run <code>npx byollm@alpha connect ${ORIGIN}</code> and enter the code it shows.</p>
       ${
         info === null
           ? ""
           : `<p>That code is from <code>${escapeHtml(info.label)}</code>
              (${escapeHtml(info.platform)}), offering
              ${info.capabilities.map((c) => `<code>${escapeHtml(c.model)}</code>`).join(", ")}.</p>`
       }
       <form method="post"><input name="code" placeholder="KRTZ-9F2Q" autofocus>
       <button>Approve</button></form>`,
    );
  }

  // 3. Enqueue a job and render the answer.
  if (url.pathname === "/" && request.method === "POST") {
    const form = new URLSearchParams(await request.text());
    const prompt = (form.get("prompt") ?? "").trim();
    if (prompt === "") return Response.redirect(`${ORIGIN}/`, 303);

    const job = await app.enqueue({
      kind: "llm.generate",
      audience: "self",
      owner: user,
      payload: { prompt },
    });

    try {
      const result = await job.result({
        timeoutMs: 120_000,
        // Never a promise that hangs forever: if nothing is online to run
        // this, we find out and can say something useful.
        onNoRunner: () => undefined,
      });

      const text =
        result.outcome?.outcome === "ok"
          ? result.outcome.text
          : `(${result.state})`;

      // A community result is someone else's text. This demo only enqueues
      // `self` jobs, so it is never untrusted here — but the check is what a
      // real app must do, so it is written out rather than assumed away.
      const untrusted = result.provenance?.untrusted === true;

      return html(
        `<h1>Answer</h1>
         ${
           untrusted
             ? `<p class="warn">This came from a volunteer's machine
           (${escapeHtml(result.provenance?.runnerOwner ?? "unknown")}) and is
           not this app's own output.</p>`
             : ""
         }
         <pre>${escapeHtml(text)}</pre>
         <p><small>ran on <code>${escapeHtml(result.provenance?.model ?? "?")}</code>
         via ${escapeHtml(result.provenance?.backendClass ?? "?")}</small></p>
         <p><a href="/">Ask something else</a></p>`,
      );
    } catch (error) {
      return html(
        `<h1>No runner</h1>
         <p class="warn">${escapeHtml(error instanceof Error ? error.message : "unknown error")}</p>
         <p>Start one: <code>npx byollm@alpha connect ${ORIGIN}</code>,
         then <a href="/pair">approve it</a>.</p>`,
      );
    }
  }

  const availability = await app.runnerAvailability({
    kind: "llm.generate",
    owner: user,
  });
  const runners = await app.runners(user);

  return html(
    `<h1>BYOLLM demo</h1>
     <p>Signed in as <b>${escapeHtml(user)}</b>.
     ${
       availability.available
         ? `<b>${String(availability.candidates)}</b> runner online.`
         : `No runner online (<code>${escapeHtml(availability.reason ?? "")}</code>) —
            <a href="/pair">connect one</a>.`
     }</p>
     ${
       runners.length === 0
         ? ""
         : `<p><small>your machines: ${runners
             .map((r) => escapeHtml(r.label))
             .join(", ")}</small></p>`
     }
     <form method="post">
       <p><textarea name="prompt" rows="4" cols="60" autofocus
          placeholder="Ask your own model something…"></textarea></p>
       <button>Run on my machine</button>
     </form>`,
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(
    `\nBYOLLM demo on ${ORIGIN}\n\n` +
      `  1. open ${ORIGIN}\n` +
      `  2. npx byollm@alpha connect ${ORIGIN}\n` +
      `  3. approve the code at ${ORIGIN}/pair\n\n`,
  );
});

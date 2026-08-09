import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenAiHttpBackend } from "../../src/backends/openai-http.js";
import { HTTP_CORPUS } from "./corpus.js";

/**
 * byollm_004 §5 / Rev 1 — the HTTP-class corpus.
 *
 * This class spawns nothing, so the argv and environment rows do not apply.
 * What must be proven instead is about the **destination and the request**:
 * nothing in a payload may change where the request goes, what model serves
 * it, or what headers it carries.
 *
 * A failure here blocks publish.
 */

const MODEL = "gemma4:26b";

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody: string;
}

let server: Server;
let baseUrl: string;
let captured: Captured[];
/** Overrides the next response, for the cap and redirect rows. */
let respond:
  | ((req: IncomingMessage) => {
      status: number;
      body: string;
      headers?: Record<string, string>;
    })
  | null;

beforeEach(async () => {
  captured = [];
  respond = null;
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: raw === "" ? null : safeJson(raw),
        rawBody: raw,
      });

      const override = respond?.(req);
      if (override) {
        res.writeHead(override.status, {
          "content-type": "application/json",
          ...override.headers,
        });
        res.end(override.body);
        return;
      }

      if (req.url?.endsWith("/models") === true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: MODEL }] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" } }],
        }),
      );
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(port)}/v1`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function backend(): OpenAiHttpBackend {
  return new OpenAiHttpBackend({ baseUrl });
}

async function run(prompt: string, maxOutputBytes = 4 * 1024 * 1024) {
  return backend().execute({
    prompt,
    model: MODEL,
    timeoutMs: 10_000,
    maxOutputBytes,
    signal: new AbortController().signal,
  });
}

describe("HTTP-class corpus [HTTP_BASE_URL_SAFE, NO_PAYLOAD_ROUTING]", () => {
  for (const hostile of HTTP_CORPUS) {
    it(`${hostile.id}: ${hostile.threat} — reaches the model verbatim, changes nothing`, async () => {
      const result = await run(hostile.prompt);
      expect(result.ok).toBe(true);

      const request = captured.at(-1);
      expect(request).toBeDefined();
      if (!request) return;

      // 1. The request went to the owner's configured endpoint, and nowhere
      //    else — no absolute URL or traversal in the payload moved it.
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.method).toBe("POST");

      // 2. The payload arrived as a JSON string field, byte for byte.
      const body = request.body as {
        model: string;
        messages: { role: string; content: string }[];
        stream: boolean;
      };
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]?.content).toBe(hostile.prompt);
      expect(body.messages[0]?.role).toBe("user");

      // 3. The model is the owner's, whatever the payload said.
      expect(body.model).toBe(MODEL);

      // 4. No extra fields were smuggled in by breaking out of the JSON
      //    string — the JSON_BREAKOUT row is precisely this.
      expect(Object.keys(body).sort()).toEqual(["messages", "model", "stream"]);

      // 5. No header was injected by CRLF in the payload.
      expect(request.headers["x-injected"]).toBeUndefined();
      expect(request.headers["authorization"]).toBeUndefined();
    });
  }
});

describe("HTTP-class ceilings and refusals", () => {
  it("refuses to follow a redirect off the configured origin", async () => {
    // A permitted base URL must not be able to become a forbidden one in
    // flight — otherwise the base-URL check is decorative.
    respond = () => ({
      status: 302,
      body: "",
      headers: { location: "http://169.254.169.254/latest/meta-data/" },
    });
    const result = await run("hello");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("backend-unreachable");
  });

  it("stops reading a response that exceeds the output cap", async () => {
    respond = () => ({
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: "x".repeat(200_000) } }],
      }),
    });
    const result = await run("hello", 1_024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("output-too-large");
  });

  it("reports a model the server does not have, rather than guessing", async () => {
    respond = () => ({ status: 404, body: JSON.stringify({ error: "no" }) });
    const result = await run("hello");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("model-not-found");
  });

  it("distinguishes a credentials failure from an outage", async () => {
    respond = () => ({ status: 401, body: JSON.stringify({ error: "no" }) });
    const result = await run("hello");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unauthorized");
  });

  it("reports a response that is not chat-completion shaped", async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ nope: true }) });
    const result = await run("hello");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("backend-error");
  });

  it("refuses at construction to point at a metadata endpoint", () => {
    expect(
      () => new OpenAiHttpBackend({ baseUrl: "http://169.254.169.254/v1" }),
    ).toThrow(/metadata/);
  });

  it("only advertises a model the server actually reports", async () => {
    const health = await backend().health();
    expect(health.healthy).toBe(true);
    expect(health.models).toContain(MODEL);
  });
});

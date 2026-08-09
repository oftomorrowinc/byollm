import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ByollmApp, MemoryStore, createFetchHandler } from "@byollm/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";

/**
 * `npx byollm connect …` against a real HTTP server, end to end.
 *
 * byollm_002's "Done when" is a stranger going from `connect` to a completed
 * job in under five minutes. This is that path, minus the stranger: a real
 * socket, the real pairing exchange, the real polling loop, and a real job
 * coming back — with only the model at the far end substituted.
 */

let server: Server;
let origin: string;
let app: ByollmApp;
let home: string;
let paths: DaemonPaths;
let out: string;

beforeEach(async () => {
  const store = new MemoryStore();
  app = new ByollmApp({ store });

  const protocol = createFetchHandler({
    store,
    verificationUrl: "http://127.0.0.1/pair",
    leaseMs: 5_000,
  });

  server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const response = await protocol(
        new Request(`${origin}${req.url ?? "/"}`, {
          method: req.method ?? "GET",
          headers: req.headers as Record<string, string>,
          body:
            chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : null,
        }),
      );
      res.writeHead(
        response.status,
        Object.fromEntries(response.headers.entries()),
      );
      res.end(Buffer.from(await response.arrayBuffer()));
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  home = await mkdtemp(join(tmpdir(), "byollm-connect-"));
  paths = daemonPaths(home);
  out = "";

  // A model server that is definitely not running would advertise nothing, so
  // point at one we can answer for.
  await writeFile(
    paths.config,
    JSON.stringify({
      backends: {
        local: { backend: "openai-http", baseUrl: `${origin}/model/v1` },
      },
      routes: { "llm.generate": { backend: "local", model: "echo-model" } },
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await rm(home, { recursive: true, force: true });
});

/** Serve the model endpoints alongside the protocol ones. */
function withModelServer(): void {
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw =
        chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "";

      if (req.url?.startsWith("/model/") === true) {
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url.endsWith("/models")) {
          res.end(JSON.stringify({ data: [{ id: "echo-model" }] }));
          return;
        }
        const body = JSON.parse(raw) as {
          messages: { content: string }[];
        };
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: `echo: ${body.messages[0]?.content ?? ""}`,
                },
              },
            ],
          }),
        );
        return;
      }

      const store = protocolHandler;
      const response = await store(
        new Request(`${origin}${req.url ?? "/"}`, {
          method: req.method ?? "GET",
          headers: req.headers as Record<string, string>,
          body: raw === "" ? null : raw,
        }),
      );
      res.writeHead(
        response.status,
        Object.fromEntries(response.headers.entries()),
      );
      res.end(Buffer.from(await response.arrayBuffer()));
    })();
  });
}

let protocolHandler: (request: Request) => Promise<Response>;

const io = (): Partial<CliIo> => ({
  out: (text) => {
    out += text;
  },
  err: (text) => {
    out += text;
  },
  confirm: () => Promise.resolve(false),
});

describe("byollm connect — the whole path", () => {
  it("pairs, claims, runs a job on the local model, and reports the result", async () => {
    const store = new MemoryStore();
    app = new ByollmApp({ store });
    protocolHandler = createFetchHandler({
      store,
      verificationUrl: `${origin}/pair`,
      leaseMs: 5_000,
    });
    withModelServer();

    const controller = new AbortController();
    const cli = runCli(["connect", origin], {
      paths,
      io: io(),
      signal: controller.signal,
    });

    // Approve as a signed-in user would, as soon as the code appears.
    const code = await waitForCode();
    await app.approvePairing({ userCode: code, owner: "alice" });

    // The daemon should now be running; give it a job.
    const job = await waitForJob();
    expect(job.outcome).toMatchObject({
      outcome: "ok",
      text: "echo: summarise this",
    });
    // A `self` job's result is this app's own output, not a volunteer's.
    expect(job.provenance?.untrusted).toBe(false);
    expect(job.provenance?.model).toBe("echo-model");

    controller.abort();
    await cli;

    expect(out).toContain("Code:");
    expect(out).toContain("paired as alice");
  });

  async function waitForCode(): Promise<string> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const match = /Code:\s+([A-Z0-9-]{9})/.exec(out);
      if (match?.[1] !== undefined) return match[1];
      if (Date.now() >= deadline)
        throw new Error(`no pairing code in:\n${out}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function waitForJob() {
    // Wait until the daemon has paired and heartbeated at least once.
    const deadline = Date.now() + 20_000;
    let jobId: string | undefined;
    for (;;) {
      const availability = await app.runnerAvailability({
        kind: "llm.generate",
        owner: "alice",
      });
      if (availability.available && jobId === undefined) {
        const handle = await app.enqueue({
          kind: "llm.generate",
          payload: { prompt: "summarise this" },
          owner: "alice",
        });
        jobId = handle.id;
      }
      if (jobId !== undefined) {
        const result = await app.result(jobId);
        if (result?.state === "ok") return result;
      }
      if (Date.now() >= deadline) {
        throw new Error(`job never completed; output was:\n${out}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

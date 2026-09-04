import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ByollmApp,
  MemoryStore,
  createFetchHandler,
  generateSiteKeys,
} from "@byollm/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonPaths, runCli, type CliIo, type DaemonPaths } from "byollm";
import type { ServerResponse } from "node:http";

/**
 * Answer 500 when a fixture handler throws.
 *
 * Without this the rejection escapes and kills the vitest worker, which
 * surfaces as an unrelated crash somewhere else in the run — the failure gets
 * attributed to whatever test was unlucky enough to be next. A 500 makes the
 * fixture fail where the fixture broke.
 */
const fail500 =
  (res: ServerResponse) =>
  (error: unknown): void => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(error));
  };

/**
 * `npx byollm connect …` against a real HTTP server, end to end.
 *
 * It lives in the conformance package because it exercises the daemon and the
 * server together — which is what this package is for — and because that lets
 * the `byollm` package ship without depending on the server it talks to.
 *
 * byollm_002's "Done when" is a stranger going from `connect` to a completed
 * job in under five minutes. This is that path, minus the stranger: a real
 * socket, the real pairing exchange, the real polling loop, and a real job
 * coming back — with only the model at the far end substituted.
 */

let server: Server;
let origin: string;
let app: ByollmApp;
const SITE_KEYS = generateSiteKeys();

let home: string;
let paths: DaemonPaths;
let out: string;

beforeEach(async () => {
  const store = new MemoryStore();
  app = new ByollmApp({ store, siteKeys: SITE_KEYS });

  const protocol = createFetchHandler({
    siteKeys: SITE_KEYS,
    store,
    verificationUrl: "http://127.0.0.1/pair",
    leaseMs: 5_000,
  });

  server = createServer((req, res) => {
    (async () => {
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
    })().catch(fail500(res));
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
      services: {
        local: {
          model: "echo-model",
          kinds: ["llm.generate"],
          type: "openai-http",
          baseUrl: `${origin}/model/v1`,
        },
      },
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
    (async () => {
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
    })().catch(fail500(res));
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
    app = new ByollmApp({ store, siteKeys: SITE_KEYS });
    protocolHandler = createFetchHandler({
      siteKeys: SITE_KEYS,
      store,
      verificationUrl: `${origin}/pair`,
      leaseMs: 5_000,
    });
    withModelServer();

    /**
     * Two commands, because pairing stopped being a service — 2026-09-01.
     *
     * This ran `connect` and then waited for a job, which worked because
     * `connect` ended by calling the run loop. It does not any more: pairing
     * is a ceremony that finishes, and running is `run`'s job and
     * `install`'s. A device paired in a terminal somebody then closed used to
     * look identical to a healthy install.
     *
     * So the path this proves is the real one now — pair, then run — and it
     * proves something it could not before: that the pairing `connect` wrote
     * is still there for a *separate process* to pick up. The old shape kept
     * everything in one long-lived call, so a pairing that only existed in
     * memory would have passed.
     */
    const pairing = new AbortController();
    const pairCli = runCli(["connect", origin], {
      paths,
      io: io(),
      signal: pairing.signal,
    });

    // Approve as a signed-in user would, as soon as the code appears.
    const code = await waitForCode();
    await app.approvePairing({ userCode: code, owner: "alice" });

    // It ends by itself. Awaited rather than aborted: that it *returns* is
    // the ruling, and a test that killed it would pass either way.
    expect(await pairCli).toBe(0);
    expect(out).toContain("Paired.");

    const controller = new AbortController();
    /* No url — `run` serves every pairing now (byollm_020), and this
       device has exactly the one it just paired with. */
    const cli = runCli(["run"], {
      paths,
      io: io(),
      signal: controller.signal,
    });

    // Now the daemon is running; give it a job.
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

    // What the operator was actually told, in the words they were told it —
    // this is the one place the pairing prompt's wording is asserted, and it
    // is worth asserting because somebody watched their own code expire while
    // the terminal looked like it was working on something.
    expect(out).toContain("Your steps:");
    expect(out).toContain("Enter code:");
    expect(out).toContain("expires in");
    // **Both sides of the comparison.** The approval screen tells somebody to
    // check the fingerprint against what this printed, and for one release it
    // printed no fingerprint at all — so the check the trust model rests on
    // was a formality nobody could perform.
    //
    // Asserted **inside the steps block**, not anywhere in the output. The
    // first version of this matched the whole transcript and passed happily
    // with the fingerprint removed: the *site* keys are printed after
    // approval, and they are the same shape. An assertion that cannot tell
    // which fingerprint it found is not an assertion about this one.
    const steps = out.slice(
      out.indexOf("Your steps:"),
      out.indexOf("waiting for approval"),
    );
    expect(steps).toMatch(/BYOLLM(-[0-9A-HJKMNP-TV-Z]{4}){6}/);
    expect(out).toContain("paired as alice");
  });

  async function waitForCode(): Promise<string> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      // Matched on the code's shape rather than on the label beside it —
      // the wording moved from "Code:" to numbered steps and this broke, which
      // is a test asserting a sentence while claiming to assert a flow.
      const match = /\b([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})\b/.exec(
        out,
      );
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

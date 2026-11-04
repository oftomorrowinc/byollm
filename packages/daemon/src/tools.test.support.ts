import { ChildProcess } from "node:child_process";
import { Socket as DgramSocket } from "node:dgram";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { Socket, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaimRequest,
  ClaimResponse,
  FetchRequest,
  FetchResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  ReleaseRequest,
  ReleaseResponse,
  ResultRequest,
  ResultResponse,
  SealedOutcome,
  TOOL_LIMITS,
  ToolCall,
  ToolCallRequest,
  ToolCallResponse,
  ToolResult,
  ToolResultsRequest,
  ToolResultsResponse,
  ToolsSealedOutcome,
  WireError,
  consentOfPayload,
  generateKeys,
  keyId,
  open,
  publicIdentityOf,
  seal,
  signRequest,
  toolsDigest,
  type SealedEnvelope,
  type ToolDeclaration,
  type ToolLimits,
  type ToolsPayload,
} from "@byollm/protocol";
import { Budgets } from "./budgets.js";
import { ProtocolClient } from "./client.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import { IngressLog, type IngressEntry } from "./ingress.js";
import { Runner, type RunnerEvent } from "./runner.js";
import { SpendLedger } from "./spend.js";
import { removeTemp, testControlPlane } from "./test-support.js";

/**
 * A daemon with a site's tools on, against an upstream that plays the site —
 * the harness for byollm_012's daemon checks (C033–C046, #7055).
 *
 * Real wherever the daemon is: the shipped {@link Runner}, the shipped
 * {@link ProtocolClient} (signing every request), the shipped `openai-http`
 * backend speaking real HTTP to a model server on loopback, real envelopes
 * sealed and opened with real keys. Two things are played:
 *
 * - **the model**, a `node:http` server answering `/v1/chat/completions` from
 *   a script — so the backend's function-calling wire format is exercised,
 *   not assumed;
 * - **the upstream**, an in-process `fetch` that holds the SITE's keys and
 *   answers the daemon plane, including the two tool endpoints: it opens each
 *   call as the site would, and seals each answer back.
 *
 * The upstream holds the site's keys because the reference server cannot yet
 * (its tool endpoints are card 2's, #7054), and a check that says a call
 * "opens only with the site's key" needs a party that has it.
 */

const SITE_KEYS = generateKeys(1_800_000_000_000);
export const SITE_ID = keyId(publicIdentityOf(SITE_KEYS).identity);
export const DEVICE_KEYS = generateKeys(1_800_000_000_000);
const DEVICE_ID = keyId(publicIdentityOf(DEVICE_KEYS).identity);
const SIGNER_KEYS = generateKeys(1_800_000_000_000);

/** The one tool most checks declare. */
export const LOOKUP: ToolDeclaration = {
  name: "lookup",
  description: "Look a term up in the site's own index.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", maxLength: 64 } },
    required: ["query"],
  },
};

export const DEFAULT_LIMITS: ToolLimits = {
  maxToolCalls: 8,
  maxToolResultChars: 32_000,
};

// -- the model ---------------------------------------------------------------

/** One chat-completions request the model server received. */
export interface ModelRequest {
  readonly messages: readonly {
    role: string;
    content?: unknown;
    tool_call_id?: string;
  }[];
  readonly tools?: readonly { function: { name: string } }[];
}

/** What the scripted model answers: text, or calls. */
export type ModelTurn =
  | { readonly text: string }
  | { readonly calls: readonly { name: string; arguments: string }[] };

/**
 * A model server on loopback that answers from a script.
 *
 * The probe (`echo_number`) is answered by the server itself, correctly,
 * unless `probe: "refuses"` — so every check that is not about the probe gets
 * a service that advertises `llm.tools` the honest way, by passing it.
 */
export async function fakeModel(
  script: (request: ModelRequest, turn: number) => ModelTurn,
  options: { probe?: "answers" | "refuses" } = {},
): Promise<{
  baseUrl: string;
  /** Every job request (not the probe's), in order. */
  requests: ModelRequest[];
  /** How many requests the probe made. */
  probes: () => number;
  close: () => Promise<void>;
}> {
  const requests: ModelRequest[] = [];
  let probes = 0;
  const server: Server = createServer((req, res) => {
    readBody(req).then(
      (raw): void => {
        res.setHeader("content-type", "application/json");
        if (req.url?.endsWith("/models")) {
          res.end(JSON.stringify({ data: [{ id: "m" }] }));
          return;
        }
        const request = JSON.parse(raw) as ModelRequest;
        const probing =
          request.tools?.some((t) => t.function.name === "echo_number") ===
            true ||
          request.messages.some(
            (m) =>
              typeof m.content === "string" &&
              m.content.includes("echo_number"),
          );
        let turn: ModelTurn;
        if (probing) {
          probes += 1;
          const answered = request.messages.some((m) => m.role === "tool");
          turn =
            options.probe === "refuses"
              ? { text: "I cannot call functions." }
              : answered
                ? {
                    text:
                      /4091/.exec(
                        JSON.stringify(request.messages.at(-1)?.content),
                      )?.[0] ?? "",
                  }
                : { calls: [{ name: "echo_number", arguments: '{"n":7}' }] };
        } else {
          requests.push(request);
          turn = script(request, requests.length);
        }
        res.end(JSON.stringify(completion(turn)));
      },
      () => {
        res.statusCode = 500;
        res.end();
      },
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    requests,
    probes: () => probes,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

function completion(turn: ModelTurn): unknown {
  if ("text" in turn) {
    return {
      choices: [
        {
          message: { role: "assistant", content: turn.text },
          finish_reason: "stop",
        },
      ],
    };
  }
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: turn.calls.map((call, index) => ({
            id: `call_${String(index)}_${String(Math.random()).slice(2, 8)}`,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The tool turns a request carried, as the model was shown them. */
export function toolTurns(request: ModelRequest): string[] {
  return request.messages
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content));
}

// -- the site ----------------------------------------------------------------

/** What the played site does with a call it opened. */
export type SiteAnswer =
  { readonly content: string } | { readonly error: string } | "silent";

/** A result the upstream hands the daemon on its next poll. */
export interface Delivery {
  readonly jobId: string;
  readonly leaseId: string;
  readonly callId: string;
  readonly envelope: SealedEnvelope;
}

/** Seal `plaintext` as the site, for `jobId`, in `direction`. */
export async function sealAsSite(
  jobId: string,
  plaintext: string,
  direction: "tool-result" | "payload" = "tool-result",
): Promise<SealedEnvelope> {
  return seal({
    plaintext,
    senderKeys: SITE_KEYS,
    recipientEncryptionPublic: DEVICE_KEYS.encryptionPublic,
    context: {
      jobId,
      senderKeyId: SITE_ID,
      recipientKeyId: DEVICE_ID,
      deadlineAt: Date.now() + 3_600_000,
      direction,
    },
  });
}

export interface ToolsJobOptions {
  readonly id?: string;
  readonly tools?: readonly ToolDeclaration[];
  readonly limits?: ToolLimits;
  readonly maxToolCalls?: number;
  readonly kind?: "llm.tools" | "llm.chat";
  /** The consent the grant's digest is over, when it is not the payload's. */
  readonly consented?: {
    tools: readonly ToolDeclaration[];
    limits: ToolLimits;
  };
  readonly deadlineMs?: number;
}

export interface ToolDaemon {
  readonly runner: Runner;
  /** The daemon's own state directory — the one place it may write. */
  readonly home: string;
  readonly ingress: IngressLog;
  readonly model: Awaited<ReturnType<typeof fakeModel>>;
  /** Calls the site received, opened and verified as the site would. */
  readonly calls: ToolCall[];
  /** For each call: whether its ingress line existed when it arrived (C042). */
  readonly loggedFirst: boolean[];
  /** The envelopes as they arrived, for the checks about the seal itself. */
  readonly envelopes: SealedEnvelope[];
  /** Hostile deliveries a check adds to the next poll. */
  readonly inject: Delivery[];
  /** Every `activeLeases` the heartbeat carried, with the clock it was sent at. */
  readonly beats: { at: number; leases: string[] }[];
  readonly events: RunnerEvent[];
  /** The fake clock, which only waits move. */
  readonly clock: { now: number };
  /** Claim the job and run it to its end; the opened outcome, or the refusal. */
  run(): Promise<
    | {
        kind: "result";
        outcome:
          | ReturnType<typeof ToolsSealedOutcome.parse>
          | ReturnType<typeof SealedOutcome.parse>;
      }
    | { kind: "refused"; reason: string }
  >;
  entries(): Promise<IngressEntry[]>;
  dispose(): Promise<void>;
}

/**
 * A daemon with one `openai-http` service listing `llm.tools`, paired with the
 * played site, holding one job.
 */
export async function toolDaemon(options: {
  readonly job?: ToolsJobOptions;
  readonly script: (request: ModelRequest, turn: number) => ModelTurn;
  readonly site?: (call: ToolCall) => SiteAnswer;
  readonly kinds?: readonly string[];
  readonly probe?: "answers" | "refuses";
  /** Run on every poll before the queue is read — the hostile cases. */
  readonly onPoll?: (
    inject: Delivery[],
    calls: readonly ToolCall[],
  ) => Promise<void>;
}): Promise<ToolDaemon> {
  const dir = await mkdtemp(join(tmpdir(), "byollm-tools-"));
  const model = await fakeModel(options.script, {
    probe: options.probe ?? "answers",
  });
  const clock = { now: Date.now() };
  const plane = testControlPlane(clock.now);
  const jobOptions = options.job ?? {};
  const jobId = jobOptions.id ?? "job_t1";
  const kind = jobOptions.kind ?? "llm.tools";
  const tools = jobOptions.tools ?? [LOOKUP];
  const limits = jobOptions.limits ?? DEFAULT_LIMITS;
  const payload:
    ToolsPayload | { messages: { role: "user"; content: string }[] } =
    kind === "llm.tools"
      ? {
          messages: [{ role: "user", content: "What does the index say?" }],
          tools: [...tools],
          purposeLimits: limits,
          ...(jobOptions.maxToolCalls === undefined
            ? {}
            : { maxToolCalls: jobOptions.maxToolCalls }),
        }
      : { messages: [{ role: "user", content: "Just chat." }] };
  const consented = jobOptions.consented ?? { tools, limits };
  const grant = plane.sign({
    jobId,
    user: "me",
    site: SITE_ID,
    service: "primary",
    kind,
    ...(kind === "llm.tools"
      ? {
          toolsDigest: toolsDigest(
            consentOfPayload({
              tools: consented.tools,
              purposeLimits: consented.limits,
            }),
          ),
        }
      : {}),
  });
  const stub = {
    id: jobId,
    kind,
    audience: "private",
    owner: "me",
    site: SITE_ID,
    sizeClass: "large",
    streaming: false,
    deadlineAt: clock.now + (jobOptions.deadlineMs ?? 300_000),
    lease: {
      id: `lease_${jobId}`,
      runnerId: "runner_1",
      expiresAt: clock.now + 60_000,
    },
    grant,
  };

  const loaded = resolveConfig(
    DaemonConfig.parse({
      services: {
        primary: {
          model: "m",
          kinds: options.kinds ?? ["llm.chat", "llm.tools"],
          type: "openai-http",
          baseUrl: model.baseUrl,
        },
      },
    }),
  );
  const budgets = new Budgets(join(dir, "b.json"), loaded.config.community);
  await budgets.load(clock.now);
  const spend = new SpendLedger(join(dir, "spend.json"));
  await spend.load(clock.now);
  const ingress = new IngressLog({
    path: join(dir, "ingress.log"),
    communityPromptDays: 7,
    keepSelfPrompts: true,
  });

  const calls: ToolCall[] = [];
  const loggedFirst: boolean[] = [];
  const envelopes: SealedEnvelope[] = [];
  const inject: Delivery[] = [];
  const queue: Delivery[] = [];
  const beats: { at: number; leases: string[] }[] = [];
  const events: RunnerEvent[] = [];
  let claimed = false;
  let settle:
    ((value: Awaited<ReturnType<ToolDaemon["run"]>>) => void) | undefined;

  /* Every response is built and then PARSED by the protocol's own schema,
     and every request is parsed by its schema before it is read — Owl,
     #55956 point 1. A fixture that agreed with the daemon by hand-writing
     the same objects would pass while the wire was wrong. */
  const json = (schema: { parse: (v: unknown) => unknown }, body: unknown) =>
    new Response(JSON.stringify(schema.parse(body)), {
      headers: { "content-type": "application/json" },
    });
  const refuse = (status: number, error: string, message: string) =>
    new Response(JSON.stringify(WireError.parse({ error, message })), {
      status,
      headers: { "content-type": "application/json" },
    });

  const upstream = async (url: string, raw: unknown) => {
    const endpoint = url.slice(url.lastIndexOf("/") + 1);
    switch (endpoint) {
      case "heartbeat": {
        const body = HeartbeatRequest.parse(raw);
        beats.push({
          at: clock.now,
          leases: body.activeLeases.map((l) => l.leaseId),
        });
        return json(HeartbeatResponse, {
          sites: { [SITE_ID]: publicIdentityOf(SITE_KEYS) },
          awaitingConsent: [],
          cancel: [],
          lost: [],
          serverTime: clock.now,
        });
      }
      case "claim": {
        ClaimRequest.parse(raw);
        const jobs = claimed ? [] : [stub];
        claimed = true;
        return json(ClaimResponse, { jobs, leaseMs: 60_000 });
      }
      case "fetch":
        FetchRequest.parse(raw);
        return json(FetchResponse, {
          envelope: await sealAsSite(jobId, JSON.stringify(payload), "payload"),
        });
      case "tool-call": {
        const body = ToolCallRequest.parse(raw);
        if (body.jobId !== jobId || body.leaseId !== stub.lease.id) {
          return refuse(403, "forbidden", "not this lease's holder");
        }
        const envelope = body.envelope;
        envelopes.push(envelope);
        /* C042: the ingress line exists when the call arrives. */
        const lines = await ingress.read();
        loggedFirst.push(
          lines.some((e) => e.type === "tool-call" && e.callId === body.callId),
        );
        const opened = await open({
          envelope,
          recipientKeys: SITE_KEYS,
          senderIdentityPublic: publicIdentityOf(DEVICE_KEYS).identity,
          expected: {
            jobId,
            senderKeyId: DEVICE_ID,
            recipientKeyId: SITE_ID,
            direction: "tool-call",
          },
        });
        if (!opened.ok) return refuse(400, "bad-request", "did not open");
        const call = ToolCall.parse(JSON.parse(opened.plaintext));
        if (call.callId !== body.callId) {
          return refuse(
            400,
            "bad-request",
            "callId differs from the sealed one",
          );
        }
        calls.push(call);
        const answer = options.site?.(call) ?? {
          content: `found ${call.name}`,
        };
        if (answer !== "silent") {
          const result = ToolResult.parse(
            "content" in answer
              ? {
                  callId: call.callId,
                  seq: call.seq,
                  ok: true,
                  content: answer.content,
                }
              : {
                  callId: call.callId,
                  seq: call.seq,
                  ok: false,
                  error: answer.error,
                },
          );
          queue.push({
            jobId,
            leaseId: stub.lease.id,
            callId: call.callId,
            envelope: await sealAsSite(jobId, JSON.stringify(result)),
          });
        }
        return json(ToolCallResponse, {
          callId: call.callId,
          expiresAt: clock.now + TOOL_LIMITS.callTimeoutMs,
        });
      }
      case "tool-results": {
        const body = ToolResultsRequest.parse(raw);
        await options.onPoll?.(inject, calls);
        /* The honest half answers only the calls named; the hostile half is
           whatever a check injected, which is the point of it. */
        const named = new Set(body.calls.map((c) => c.callId));
        const honest = queue.filter((d) => named.has(d.callId));
        for (const d of honest) queue.splice(queue.indexOf(d), 1);
        return json(ToolResultsResponse, {
          results: [...inject.splice(0), ...honest],
        });
      }
      case "result": {
        const body = ResultRequest.parse(raw);
        const opened = await open({
          envelope: body.envelope,
          recipientKeys: SITE_KEYS,
          senderIdentityPublic: publicIdentityOf(DEVICE_KEYS).identity,
          expected: {
            jobId,
            senderKeyId: DEVICE_ID,
            recipientKeyId: SITE_ID,
            direction: "result",
          },
        });
        if (!opened.ok)
          throw new Error(`result did not open: ${opened.reason}`);
        const sealed: unknown = JSON.parse(opened.plaintext);
        settle?.({
          kind: "result",
          /* Parsed as the site would, per kind: a chat result carries no
             tool counts, and a tool result must. */
          outcome:
            kind === "llm.tools"
              ? ToolsSealedOutcome.parse(sealed)
              : SealedOutcome.parse(sealed),
        });
        return json(ResultResponse, {
          accepted: true,
          duplicate: false,
          state: "ok",
        });
      }
      case "release":
        return json(ReleaseResponse, {
          released: ReleaseRequest.parse(raw).leases.map((l) => l.leaseId),
        });
      default:
        return refuse(404, "not-found", endpoint);
    }
  };

  const runner: Runner = new Runner({
    client: new ProtocolClient({
      origin: "https://site.test",
      identity: {
        runnerId: "runner_1",
        sign: (input) => signRequest(SIGNER_KEYS, input).signature,
      },
      fetch: async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        const raw = typeof init?.body === "string" ? init.body : "{}";
        return upstream(url, JSON.parse(raw) as unknown);
      },
    }),
    runnerId: "runner_1",
    identity: {
      keys: () => Promise.resolve(DEVICE_KEYS),
      sites: new Map([[SITE_ID, publicIdentityOf(SITE_KEYS)]]),
    },
    owner: "me",
    daemonVersion: "0.0.0",
    controlPlanePublic: plane.controlPlanePublic,
    loaded,
    budgets,
    spend,
    ingress,
    now: () => clock.now,
    /* A second of waiting is a second of this clock, and the daemon's own
       loop ticks meanwhile — which is what renews the lease (C041). */
    toolWait: async (ms) => {
      clock.now += ms;
      await runner.tick();
    },
    onEvent: (event) => {
      events.push(event);
      if (event.type === "refused") {
        settle?.({ kind: "refused", reason: event.reason });
      }
    },
  });

  return {
    runner,
    home: dir,
    ingress,
    model,
    calls,
    loggedFirst,
    envelopes,
    inject,
    beats,
    events,
    clock,
    run: async () => {
      const done = new Promise<Awaited<ReturnType<ToolDaemon["run"]>>>(
        (resolve) => {
          settle = resolve;
        },
      );
      await runner.tick();
      return done;
    },
    entries: () => ingress.read(),
    dispose: async () => {
      runner.cancelAll();
      await model.close();
      await removeTemp(dir);
    },
  };
}

// -- the device -------------------------------------------------------------

/**
 * Every process the daemon tried to start, every socket it opened, every
 * datagram it sent and every file it wrote, while a check runs — C034, and
 * Owl's #55956 point 4: the red-team question gets spies that can fail.
 *
 * The prototypes are patched rather than modules mocked, so the daemon's own
 * imports are the ones watched: `undici` (under `fetch`) connects through
 * `net.Socket`, and every `child_process` entry point spawns through
 * `ChildProcess.prototype.spawn`. File writes go through `node:fs` and
 * `node:fs/promises`, synced into the ESM namespaces the daemon imported.
 */
export function watchTheDevice(): {
  spawned: string[];
  connected: string[];
  datagrams: string[];
  written: { path: string; data: string }[];
  stop: () => void;
} {
  const spawned: string[] = [];
  const connected: string[] = [];
  const datagrams: string[] = [];
  const written: { path: string; data: string }[] = [];
  type Fn = (this: unknown, ...args: unknown[]) => unknown;
  /* `spawn` is not in ChildProcess's public types, and it is the one every
     `child_process` entry point calls — which is why it is the one watched. */
  const child = ChildProcess.prototype as unknown as { spawn: Fn };
  const net = Socket.prototype as unknown as { connect: Fn };
  const dgram = DgramSocket.prototype as unknown as { send: Fn };
  const spawn = child.spawn;
  const connect = net.connect;
  const send = dgram.send;
  const promises = { ...fs.promises };
  const sync = {
    writeFileSync: fs.writeFileSync,
    appendFileSync: fs.appendFileSync,
    createWriteStream: fs.createWriteStream,
  };
  child.spawn = function (options: unknown) {
    spawned.push(JSON.stringify(options));
    throw new Error("the daemon tried to start a process");
  };
  net.connect = function (this: unknown, ...args: unknown[]) {
    connected.push(JSON.stringify(args[0]));
    return connect.apply(this, args);
  };
  dgram.send = function (...args: unknown[]) {
    datagrams.push(JSON.stringify(args.slice(1)));
    throw new Error("the daemon tried to send a datagram");
  };
  const note = (path: unknown, data: unknown) => {
    written.push({ path: String(path), data: String(data) });
  };
  fs.promises.writeFile = ((
    path: unknown,
    data: unknown,
    ...rest: unknown[]
  ) => {
    note(path, data);
    return (promises.writeFile as (...a: unknown[]) => Promise<void>)(
      path,
      data,
      ...rest,
    );
  }) as typeof fs.promises.writeFile;
  fs.promises.appendFile = ((
    path: unknown,
    data: unknown,
    ...rest: unknown[]
  ) => {
    note(path, data);
    return (promises.appendFile as (...a: unknown[]) => Promise<void>)(
      path,
      data,
      ...rest,
    );
  }) as typeof fs.promises.appendFile;
  fs.writeFileSync = (path: unknown, data: unknown, ...rest: unknown[]) => {
    note(path, data);
    (sync.writeFileSync as (...a: unknown[]) => void)(path, data, ...rest);
  };
  fs.appendFileSync = (path: unknown, data: unknown, ...rest: unknown[]) => {
    note(path, data);
    (sync.appendFileSync as (...a: unknown[]) => void)(path, data, ...rest);
  };
  fs.createWriteStream = (path: unknown, ...rest: unknown[]) => {
    note(path, "(stream)");
    return (sync.createWriteStream as (...a: unknown[]) => fs.WriteStream)(
      path,
      ...rest,
    );
  };
  syncBuiltinESMExports();
  return {
    spawned,
    connected,
    datagrams,
    written,
    stop: () => {
      child.spawn = spawn;
      net.connect = connect;
      dgram.send = send;
      fs.promises.writeFile = promises.writeFile;
      fs.promises.appendFile = promises.appendFile;
      fs.writeFileSync = sync.writeFileSync;
      fs.appendFileSync = sync.appendFileSync;
      fs.createWriteStream = sync.createWriteStream;
      syncBuiltinESMExports();
    },
  };
}

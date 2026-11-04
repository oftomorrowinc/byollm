import { AsyncLocalStorage } from "node:async_hooks";
import { ChildProcess } from "node:child_process";
import { Socket as DgramSocket } from "node:dgram";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Socket } from "node:net";
import {
  ClaimResponse,
  HeartbeatRequest,
  ResultRequest,
  SealedOutcome,
  SiteToolCalls,
  TOOL_LIMITS,
  ToolCall,
  ToolCallRequest,
  ToolResult,
  ToolResultsResponse,
  ToolsSealedOutcome,
  keyId,
  open,
  publicIdentityOf,
  seal,
  type ClaimedStub,
  type SealedEnvelope,
  type StoredKeys,
  type ToolDeclaration,
  type ToolLimits,
} from "@byollm/protocol";
import type { IngressEntry, RunnerEvent } from "byollm";
import { pairDaemon, sleep, waitFor, type HarnessDaemon } from "./harness.js";
import type { ConformanceTarget } from "./target.js";

/**
 * The kit plays the site for a tool job — byollm_012's checks C033–C038,
 * C041–C043 and C046, lifted from the daemon's own suites (#7055) into the
 * kit (#7116).
 *
 * Real wherever the pair is: the shipped `Runner`, paired with the target by
 * the shipped exchange, signing every request; the shipped `openai-http`
 * adapter speaking the real chat-completions function-calling wire; the
 * target's own daemon-plane endpoints (`tool-call`, `tool-results`) and its
 * own site plane (`ConformanceTarget.site`), with real envelopes sealed and
 * opened with real keys. Two things are played, and only two:
 *
 * - **the model.** A script answers `/v1/chat/completions` for the daemon's
 *   configured base URL **in-process**: `fetch` is intercepted for that one
 *   base URL while a check runs, and nothing else. No socket is opened and no
 *   process is started for it, so a socket or a process seen during C034 is
 *   the daemon's.
 * - **the site.** The kit holds the site's keys (`site.keys`), reads the calls
 *   waiting on it through the target's `calls`, opens each one verifying it
 *   against the device key **the kit itself paired** (never the `device` a
 *   target names), and posts each answer through the target's `tool-result`.
 *
 * And the kit stands at the target's door, as `observeArrivals` does: it
 * sees each `tool-call` as it arrives (C042's instant), each heartbeat (C041's
 * lease), each result (opened with the site's key, so the checks read the
 * `ran` a site reads), and it can add hostile deliveries to a `tool-results`
 * answer (C037's "the upstream returns…"). Every body is parsed with
 * `@byollm/protocol`'s own schemas before it is read (Owl, #55956 point 1).
 */

/**
 * The model's base URL. Port 9 (discard): if the interception were ever not
 * in place, the adapter's request would fail to connect rather than reach
 * whatever model server happens to run on the machine — and C034 would see
 * the attempt.
 */
const MODEL_BASE_URL = "http://127.0.0.1:9/v1";

/** The one tool most checks declare — #7055's `LOOKUP`. */
export const LOOKUP: ToolDeclaration = {
  name: "lookup",
  description: "Look a term up in the site's own index.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", maxLength: 64 } },
    required: ["query"],
  },
};

const DEFAULT_LIMITS: ToolLimits = {
  maxToolCalls: 8,
  maxToolResultChars: 32_000,
};

/** §8's closing turn, asked with no tools offered. */
export const CLOSING_TURN = "Answer from what you have.";

// -- the model ---------------------------------------------------------------

/** One chat-completions request the model received. */
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

export type ModelScript = (request: ModelRequest, turn: number) => ModelTurn;

/** The tool turns a request carried, as the model was shown them. */
export function toolTurns(request: ModelRequest | undefined): string[] {
  return (request?.messages ?? [])
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content));
}

export const call = (name: string, args: unknown): ModelTurn => ({
  calls: [
    { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  ],
});

/**
 * Answer the model's endpoints from a script. The probe (`echo_number`) is
 * answered correctly, so the service advertises `llm.tools` the honest way —
 * by passing it.
 */
class ScriptedModel {
  script: ModelScript = () => ({ text: "done" });
  /** Every job request (not the probe's), in order, for the current run. */
  requests: ModelRequest[] = [];

  async answer(request: Request): Promise<Response> {
    const headers = { "content-type": "application/json" };
    if (new URL(request.url).pathname.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "echo-model" }] }), {
        headers,
      });
    }
    const body = JSON.parse(await request.text()) as ModelRequest;
    const probing =
      body.tools?.some((t) => t.function.name === "echo_number") === true ||
      body.messages.some(
        (m) =>
          typeof m.content === "string" && m.content.includes("echo_number"),
      );
    let turn: ModelTurn;
    if (probing) {
      const answered = body.messages.some((m) => m.role === "tool");
      turn = answered
        ? {
            text:
              /4091/u.exec(
                JSON.stringify(body.messages.at(-1)?.content),
              )?.[0] ?? "",
          }
        : { calls: [{ name: "echo_number", arguments: '{"n":7}' }] };
    } else {
      this.requests.push(body);
      // A daemon whose budget is broken asks forever (C038's model "calls
      // forever"); past §8's protocol ceiling of turns the kit's model stops
      // calling, so the run ends and the check fails on what it asserts
      // instead of the run dying with the conversation.
      turn =
        this.requests.length > TOOL_LIMITS.maxToolCalls + 2
          ? { text: "the kit's model stopped: too many turns" }
          : this.script(body, this.requests.length);
    }
    return new Response(JSON.stringify(completion(turn)), { headers });
  }
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
          tool_calls: turn.calls.map((asked, index) => ({
            id: `call_${String(index)}_${String(Math.random()).slice(2, 8)}`,
            type: "function",
            function: { name: asked.name, arguments: asked.arguments },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

/**
 * Route `fetch` for `baseUrl` to `answer`, and everything else on.
 *
 * The URL is read without constructing a `Request`, so a request bound
 * elsewhere (a Supabase target's own traffic) passes through with its body
 * untouched.
 */
function interceptModel(
  baseUrl: string,
  answer: (request: Request) => Promise<Response>,
): () => void {
  const original = globalThis.fetch;
  const intercepting: typeof fetch = (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    return url.startsWith(baseUrl)
      ? answer(new Request(input, init))
      : original(input, init);
  };
  globalThis.fetch = intercepting;
  return () => {
    if (globalThis.fetch === intercepting) globalThis.fetch = original;
  };
}

// -- the device ---------------------------------------------------------------

/**
 * Work done on the target's behalf — its `fetch`, its site plane. A socket a
 * target opens to its own database (Supabase) is the upstream's, not the
 * daemon's; C034 tells the two apart by this context.
 */
const upstreamWork = new AsyncLocalStorage<true>();

/**
 * Every process the daemon tried to start, every socket it opened, every
 * datagram it sent and every file it wrote while a check runs — C034, as
 * #7055 wrote it (`watchTheDevice`), with one change for the kit: a socket is
 * marked when it was opened inside the target's own work, because a target
 * may run in this process and talk to its database.
 */
export function watchTheDevice(): {
  spawned: string[];
  connected: { to: string; upstream: boolean }[];
  datagrams: string[];
  written: { path: string; data: string }[];
  stop: () => void;
} {
  const spawned: string[] = [];
  const connected: { to: string; upstream: boolean }[] = [];
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
    connected.push({
      to: JSON.stringify(args[0]),
      upstream: upstreamWork.getStore() === true,
    });
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

// -- the site -----------------------------------------------------------------

/** What the played site does with a call it opened. */
type SiteAnswer =
  { readonly content: string } | { readonly error: string } | "silent";

/** A delivery the kit adds to a `tool-results` answer, as a hostile upstream. */
export interface Delivery {
  readonly jobId: string;
  readonly leaseId: string;
  readonly callId: string;
  readonly envelope: SealedEnvelope;
}

/** One job's run, as the kit saw it from the site and the door. */
export interface ToolRun {
  readonly jobId: string;
  /** The lease the daemon claimed it under, from the claim's answer. */
  readonly leaseId: string;
  /** The stub the target handed the daemon. */
  readonly stub: ClaimedStub;
  /** Calls the kit opened as the site, in order. */
  readonly calls: ToolCall[];
  /** Each call's envelope as the daemon posted it to the target. */
  readonly arrived: SealedEnvelope[];
  /** Each call's envelope as the target's `calls` served it to the site. */
  readonly served: SealedEnvelope[];
  /** For each call: whether its ingress line existed when it arrived (C042). */
  readonly loggedFirst: boolean[];
  /** The model's job requests, in order. */
  readonly requests: ModelRequest[];
  /** Every heartbeat during the run: the kit's clock and its leases. */
  readonly beats: { at: number; leases: string[] }[];
  /** The kit's clock when the job was handed to the daemon, and at its end. */
  readonly started: number;
  readonly ended: number;
  /** When the claim answered with the job, and when its result was posted. */
  readonly claimedAt: number;
  readonly resultAt: number;
  /** The sealed result, opened as the site, or the device's refusal. */
  readonly end:
    | {
        readonly kind: "result";
        readonly outcome: ToolsSealedOutcome | SealedOutcome;
        /** What the target answered the daemon's `result` with. */
        readonly status: number;
      }
    | { readonly kind: "refused"; readonly reason: string };
}

interface RunOptions {
  readonly kind?: "llm.tools" | "llm.chat";
  readonly tools?: readonly ToolDeclaration[];
  readonly limits?: ToolLimits;
  readonly maxToolCalls?: number;
  /** The user's message; defaults to a short question. */
  readonly prompt?: string;
  readonly script: ModelScript;
  readonly site?: (call: ToolCall) => SiteAnswer;
  /** Run on every `tool-results` poll before it is forwarded. */
  readonly onPoll?: (
    inject: Delivery[],
    calls: readonly ToolCall[],
    job: { readonly jobId: string; readonly leaseId: string },
  ) => Promise<void>;
}

export interface ToolStage {
  readonly daemon: HarnessDaemon;
  /** The kit's clock — the daemon's, and the target's when it can fake time. */
  now(): number;
  /** Enqueue one job, hand it to the daemon, and run it to its end. */
  run(options: RunOptions): Promise<ToolRun>;
  /** Seal `plaintext` as the site, to the paired device. */
  sealAsSite(
    jobId: string,
    plaintext: string,
    direction?: "tool-result" | "payload",
  ): Promise<SealedEnvelope>;
  /** The target's site plane, as the kit reaches it. */
  readonly site: NonNullable<ConformanceTarget["site"]>;
  entries(): Promise<IngressEntry[]>;
  dispose(): Promise<void>;
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Pair a tool-serving daemon with `target` and stand at the door as its site.
 */
export async function toolStage(target: ConformanceTarget): Promise<ToolStage> {
  const site =
    target.site ??
    fail(
      `"${target.name}" has no \`site\`, so the kit cannot play the site for a ` +
        "tool job: give the target its site plane (`calls`, `toolResult`) and " +
        "the site's keys — ConformanceTarget.site",
    );
  const siteKeys: StoredKeys = site.keys;
  const siteIdentity = publicIdentityOf(siteKeys);
  const siteId = keyId(siteIdentity.identity);

  let offset = 0;
  const now = (): number => Date.now() + offset;
  const model = new ScriptedModel();
  const restoreFetch = interceptModel(MODEL_BASE_URL, (request) =>
    model.answer(request),
  );

  // Per run. `current` is the job the door and the site attribute traffic to.
  let current:
    | {
        jobId: string;
        kind: "llm.tools" | "llm.chat";
        options: RunOptions;
        stub?: ClaimedStub;
        claimedAt?: number;
        resultAt?: number;
        calls: ToolCall[];
        arrived: SealedEnvelope[];
        served: SealedEnvelope[];
        loggedFirst: boolean[];
        beats: { at: number; leases: string[] }[];
        inject: Delivery[];
        handled: Set<string>;
        faults: string[];
        ended?: ToolRun["end"];
      }
    | undefined;

  let daemon: HarnessDaemon | undefined;
  const deviceKeys = (): StoredKeys =>
    daemon?.keys ?? fail("the site was asked to act before pairing finished");

  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  /** The door: the daemon's requests to the target, seen as they pass. */
  const door = async (request: Request): Promise<Response> => {
    const endpoint = new URL(request.url).pathname.replace(/^\/byollm\//u, "");
    const job = current;
    if (job === undefined) return target.fetch(request);
    const raw = async (): Promise<unknown> =>
      JSON.parse(await request.clone().text()) as unknown;
    switch (endpoint) {
      case "tool-call": {
        const body = ToolCallRequest.parse(await raw());
        if (body.jobId === job.jobId) {
          job.arrived.push(body.envelope);
          // C042: the instant the call reaches the upstream, before the
          // target has seen it or answered — the only moment "logged
          // before sending" differs from "after".
          const lines = await deviceIngress().read();
          job.loggedFirst.push(
            lines.some(
              (e) => e.type === "tool-call" && e.callId === body.callId,
            ),
          );
        }
        return target.fetch(request);
      }
      case "tool-results": {
        if (job.stub !== undefined) {
          await job.options.onPoll?.(job.inject, job.calls, {
            jobId: job.jobId,
            leaseId: job.stub.lease.id,
          });
        }
        const response = await target.fetch(request);
        if (job.inject.length === 0 || response.status !== 200) return response;
        const honest = ToolResultsResponse.parse(await response.json());
        return json(
          ToolResultsResponse.parse({
            results: [...job.inject.splice(0), ...honest.results],
          }),
          200,
        );
      }
      case "heartbeat": {
        const body = HeartbeatRequest.parse(await raw());
        job.beats.push({
          at: now(),
          leases: body.activeLeases.map((l) => l.leaseId),
        });
        return target.fetch(request);
      }
      case "claim": {
        const response = await target.fetch(request);
        if (response.status !== 200) return response;
        const answered = ClaimResponse.parse(await response.clone().json());
        const stub = answered.jobs.find((it) => it.id === job.jobId);
        if (stub !== undefined && job.stub === undefined) {
          job.stub = stub;
          job.claimedAt = now();
        }
        return response;
      }
      case "result": {
        const body = ResultRequest.parse(await raw());
        if (body.jobId === job.jobId) job.resultAt ??= now();
        const response = await target.fetch(request);
        if (body.jobId !== job.jobId) return response;
        // Opened as the site opens it: with the site's key, verifying the
        // device the kit paired, in the `result` direction.
        const device = publicIdentityOf(deviceKeys());
        const opened = await open({
          envelope: body.envelope,
          recipientKeys: siteKeys,
          senderIdentityPublic: device.identity,
          expected: {
            jobId: job.jobId,
            senderKeyId: keyId(device.identity),
            recipientKeyId: siteId,
            direction: "result",
          },
        });
        if (!opened.ok) {
          job.faults.push(`the job's result did not open: ${opened.reason}`);
          return response;
        }
        const sealed: unknown = JSON.parse(opened.plaintext);
        job.ended = {
          kind: "result",
          // Parsed as the site would, per kind: a chat result carries no tool
          // counts, and a tool result must.
          outcome:
            job.kind === "llm.tools"
              ? ToolsSealedOutcome.parse(sealed)
              : SealedOutcome.parse(sealed),
          status: response.status,
        };
        return response;
      }
      default:
        return target.fetch(request);
    }
  };

  // Everything the target does on the kit's behalf runs as upstream work.
  const asUpstream = <T>(work: () => Promise<T>): Promise<T> =>
    upstreamWork.run(true, work);
  const doorway: ConformanceTarget = new Proxy(target, {
    get(inner, property) {
      if (property === "fetch") {
        return (request: Request) => asUpstream(() => door(request));
      }
      const value: unknown = Reflect.get(inner, property, inner);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(inner)
        : value;
    },
  });
  const sitePlane: ToolStage["site"] = {
    keys: siteKeys,
    calls: () => asUpstream(() => site.calls()),
    toolResult: (input) => asUpstream(() => site.toolResult(input)),
  };

  const sealAsSite = async (
    jobId: string,
    plaintext: string,
    direction: "tool-result" | "payload" = "tool-result",
  ): Promise<SealedEnvelope> => {
    const device = publicIdentityOf(deviceKeys());
    return seal({
      plaintext,
      senderKeys: siteKeys,
      recipientEncryptionPublic: device.encryption,
      context: {
        jobId,
        senderKeyId: siteId,
        recipientKeyId: keyId(device.identity),
        deadlineAt: now() + 3_600_000,
        direction,
      },
    });
  };

  /**
   * The site's pump: read the calls waiting on it, open each as the site,
   * and answer it. A fault is recorded, not thrown — it would otherwise
   * surface inside the daemon's own wait as some other failure.
   */
  const pump = async (): Promise<void> => {
    const job = current;
    if (job === undefined) return;
    try {
      const listed = SiteToolCalls.parse(await sitePlane.calls());
      const device = publicIdentityOf(deviceKeys());
      for (const entry of listed.calls) {
        if (entry.jobId !== job.jobId || job.handled.has(entry.callId))
          continue;
        job.handled.add(entry.callId);
        if (entry.device.identity !== device.identity) {
          job.faults.push(
            "the site's `calls` named a device other than the one that paired",
          );
          continue;
        }
        const opened = await open({
          envelope: entry.envelope,
          recipientKeys: siteKeys,
          // The device the kit paired — never the `device` the target named.
          senderIdentityPublic: device.identity,
          expected: {
            jobId: job.jobId,
            senderKeyId: keyId(device.identity),
            recipientKeyId: siteId,
            direction: "tool-call",
          },
        });
        if (!opened.ok) {
          job.faults.push(
            `a call the site was served did not open as a tool-call from the ` +
              `paired device: ${opened.reason}`,
          );
          continue;
        }
        const asked = ToolCall.parse(JSON.parse(opened.plaintext));
        if (asked.callId !== entry.callId) {
          job.faults.push("a call's clear callId differs from its sealed one");
          continue;
        }
        job.calls.push(asked);
        job.served.push(entry.envelope);
        const answer = job.options.site?.(asked) ?? {
          content: `found ${asked.name}`,
        };
        if (answer === "silent") continue;
        const result = ToolResult.parse(
          "content" in answer
            ? {
                callId: asked.callId,
                seq: asked.seq,
                ok: true,
                content: answer.content,
              }
            : {
                callId: asked.callId,
                seq: asked.seq,
                ok: false,
                error: answer.error,
              },
        );
        const posted = await sitePlane.toolResult({
          jobId: entry.jobId,
          callId: entry.callId,
          envelope: await sealAsSite(entry.jobId, JSON.stringify(result)),
        });
        if (!("accepted" in posted)) {
          job.faults.push(
            `the target refused the site's answer to an outstanding call: ${posted.refused}`,
          );
        }
      }
    } catch (error) {
      job.faults.push(
        `the site could not read its calls: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const events: RunnerEvent[] = [];
  /**
   * A tool poll's wait: the kit's clock moves (the target's too, when it can
   * fake time; otherwise the wait is real), the target sweeps as a real one
   * would on its timer, the site's pump turns, and the daemon's own loop
   * ticks — which is what renews its lease (C041).
   */
  const toolWait = async (ms: number): Promise<void> => {
    if (target.advanceTime) {
      offset += ms;
      const advanceTime = target.advanceTime.bind(target);
      await asUpstream(() => advanceTime(ms));
    } else {
      await sleep(ms);
    }
    await asUpstream(() => target.sweep());
    await pump();
    await daemon?.runner.tick();
  };

  try {
    daemon = await pairDaemon(doorway, {
      owner: "alice",
      offer: "private",
      label: "daemon-tools",
      tools: {
        baseUrl: MODEL_BASE_URL,
        now,
        toolWait,
        onEvent: (event) => {
          events.push(event);
          const job = current;
          if (event.type === "refused" && job?.jobId === event.jobId) {
            job.ended ??= { kind: "refused", reason: event.reason };
          }
        },
      },
    });
  } catch (error) {
    restoreFetch();
    throw error;
  }
  const paired = daemon;
  function deviceIngress() {
    return paired.ingress;
  }

  if (keyId(paired.sitePinned.identity) !== siteId) {
    await paired.dispose();
    restoreFetch();
    fail(
      "the target's `site.keys` are not the site the daemon pinned at " +
        "pairing, so nothing the kit opened with them would be what the " +
        "daemon sealed",
    );
  }

  return {
    daemon: paired,
    now,
    site: sitePlane,
    sealAsSite,
    entries: () => paired.ingress.read(),
    async run(options: RunOptions): Promise<ToolRun> {
      const kind = options.kind ?? "llm.tools";
      const tools = options.tools ?? [LOOKUP];
      const limits = options.limits ?? DEFAULT_LIMITS;
      const messages = [
        {
          role: "user" as const,
          content: options.prompt ?? "What does the index say?",
        },
      ];
      const payload =
        kind === "llm.tools"
          ? {
              messages,
              tools: [...tools],
              purposeLimits: limits,
              ...(options.maxToolCalls === undefined
                ? {}
                : { maxToolCalls: options.maxToolCalls }),
            }
          : { messages };
      model.script = options.script;
      model.requests = [];
      const handle = await asUpstream(() =>
        target.enqueue({
          kind,
          payload,
          owner: "alice",
          audience: "private",
          // byollm_012 §5.3: the deadline bounds the whole loop. Five minutes,
          // C041's, so a call's timeout ends a wait before the deadline does.
          ttlMs: 5 * 60_000,
        }),
      );
      const job: NonNullable<typeof current> = {
        jobId: handle.id,
        kind,
        options,
        calls: [],
        arrived: [],
        served: [],
        loggedFirst: [],
        beats: [],
        inject: [],
        handled: new Set(),
        faults: [],
      };
      current = job;
      const started = now();
      try {
        await paired.runner.tick();
        await waitFor(() => job.ended !== undefined || job.faults.length > 0, {
          // A real-clock target waits a real second per poll, and C041 polls
          // for sixty of them.
          timeoutMs: target.advanceTime ? 30_000 : 150_000,
          what: `job ${job.jobId} to end`,
        });
      } finally {
        current = undefined;
      }
      if (job.faults.length > 0) throw new Error(job.faults.join("; "));
      const stub =
        job.stub ?? fail(`the daemon never claimed job ${job.jobId}`);
      const ended =
        job.ended ?? fail(`job ${job.jobId} ended with nothing to show`);
      return {
        jobId: job.jobId,
        leaseId: stub.lease.id,
        stub,
        calls: job.calls,
        arrived: job.arrived,
        served: job.served,
        loggedFirst: job.loggedFirst,
        requests: model.requests,
        beats: job.beats,
        started,
        ended: now(),
        claimedAt: job.claimedAt ?? started,
        resultAt: job.resultAt ?? now(),
        end: ended,
      };
    },
    async dispose() {
      try {
        await paired.dispose();
      } finally {
        restoreFetch();
      }
    },
  };
}

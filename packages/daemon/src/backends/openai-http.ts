import type { BackendClass, BackendId } from "@byollm/protocol";
import { checkBaseUrl } from "../ssrf.js";
import type {
  StopReason,
  StopReasonMapping,
  Backend,
  BackendHealth,
  BackendInit,
  BackendRequest,
  BackendResult,
  ConverseMessage,
  ConverseRequest,
  ConverseResult,
  ModelToolCall,
  ImageRequest,
  ImageResult,
  VisionRequest,
  VisionTurn,
} from "./types.js";

/**
 * The HTTP-class backend: any server speaking OpenAI-compatible
 * `/v1/chat/completions`.
 *
 * One implementation covers Ollama, `mlx_lm.server`, llama.cpp server and
 * vLLM (byollm_001 Rev 1 §A) — the collapse that puts MLX inference in v1.
 *
 * **Why this is the safest class.** It spawns nothing, so byollm_004 §2's
 * argv, stdin, environment and sandbox requirements do not apply *by
 * construction* rather than by discipline. The prompt travels as a JSON
 * string in a request body; there is no command line for it to escape into
 * because there is no command line.
 *
 * What remains is the destination, and that is nailed down: the base URL
 * comes from owner config, is validated once at load and again here, and
 * redirects are refused so a permitted URL cannot become a forbidden one in
 * flight ({@link MUSTS.HTTP_BASE_URL_SAFE}).
 */
/**
 * OpenAI's `finish_reason`, mapped — byollm_021.
 *
 * **Verified by running it**, per the `login.ts` precedent, against
 * ollama 0.x on this machine, both directions from the same model:
 *   · `max_tokens: 5`  -> `finish_reason: "length"`, content empty
 *   · room to finish   -> `finish_reason: "stop"`,   content complete
 *
 * `"stop"` maps to `"end"` and NOT to `"stop-sequence"`, which is the one
 * judgement here. OpenAI reports `stop` for a model finishing on its own AND
 * for a configured stop token being hit; the field cannot tell them apart, so
 * claiming `"stop-sequence"` would be inventing a distinction the wire does
 * not carry. `"end"` is what we can honestly say.
 *
 * `tool_calls` and `content_filter` are OpenAI's and unmapped here on
 * purpose: a turn that ends in tool calls is not an answer whose stop means
 * anything (the tool loop asks again, byollm_012 §7), and a filtered response
 * is a refusal rather than a stop reason. Anything unlisted resolves to `"unknown"`, which
 * is the honest answer rather than the flattering one.
 */
const FINISH_REASONS = Object.freeze({
  stop: "end",
  length: "length",
}) as Readonly<Record<string, StopReason>>;

export class OpenAiHttpBackend implements Backend {
  readonly stopReasons: StopReasonMapping = {
    kind: "declared",
    from: "choices[0].finish_reason",
    map: FINISH_REASONS,
  };

  readonly id: BackendId = "openai-http";
  readonly class: BackendClass = "http";
  readonly #baseUrl: URL;
  readonly #apiKeyEnv: string | undefined;

  constructor(init: BackendInit) {
    if (init.baseUrl === undefined) {
      throw new Error("openai-http backend requires a baseUrl");
    }
    const check = checkBaseUrl(init.baseUrl);
    if (!check.ok) {
      throw new Error(`refusing base URL: ${check.detail}`);
    }
    this.#baseUrl = check.url;
    this.#apiKeyEnv = init.apiKeyEnv;
  }

  /**
   * Build a URL under the configured base.
   *
   * The path is a hardcoded literal from this file — never anything derived
   * from a job — and the result is re-checked against the base's origin so a
   * surprising `baseUrl` (say, one with a `..` path) cannot walk elsewhere.
   */
  #endpoint(path: "chat/completions" | "models" | "images/generations"): URL {
    const base = this.#baseUrl.href.endsWith("/")
      ? this.#baseUrl.href
      : `${this.#baseUrl.href}/`;
    const url = new URL(path, base);
    if (url.origin !== this.#baseUrl.origin) {
      throw new Error("computed endpoint left the configured origin");
    }
    return url;
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.#apiKeyEnv !== undefined) {
      const key = process.env[this.#apiKeyEnv];
      if (key !== undefined && key !== "") {
        headers["authorization"] = `Bearer ${key}`;
      }
    }
    return headers;
  }

  async health(): Promise<BackendHealth> {
    try {
      const response = await fetch(this.#endpoint("models"), {
        method: "GET",
        headers: this.#headers(),
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        return {
          healthy: false,
          models: [],
          detail: `model list returned HTTP ${String(response.status)}`,
        };
      }
      const body: unknown = await response.json();
      return { healthy: true, models: extractModelIds(body) };
    } catch (error) {
      return {
        healthy: false,
        models: [],
        detail: describeFetchError(error, this.#baseUrl.origin),
      };
    }
  }

  async execute(request: BackendRequest): Promise<BackendResult> {
    const turn = await this.#complete(
      request,
      { messages: [{ role: "user", content: request.prompt }] },
      /* Every kind but llm.tools reads the response as main did: a
         `tool_calls` field it never asked for is ignored, malformed or not
         (C043, other kinds unchanged — Owl, #55998). */
      { readsCalls: false },
    );
    if (!turn.ok) return turn;
    if (turn.message.content === null) {
      return this.#fail(
        "backend-error",
        "the model server's response was not in OpenAI chat-completion shape",
        turn.started,
      );
    }
    return {
      ok: true,
      text: turn.message.content,
      durationMs: Date.now() - turn.started,
      stop: turn.message.stop,
    };
  }

  /**
   * One turn of a function-calling conversation — byollm_012 §7.
   *
   * The declarations go to the model as OpenAI `tools`; the calls it asks for
   * come back as text. Nothing here runs one, opens anything or reaches
   * anywhere but this service's own configured `chat/completions` — the tool
   * loop seals each call to the site that declared it.
   */
  async converse(request: ConverseRequest): Promise<ConverseResult> {
    const turn = await this.#complete(request, {
      messages: request.messages.map(wireMessage),
      ...(request.tools === undefined || request.tools.length === 0
        ? {}
        : {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }),
    });
    if (!turn.ok) return turn;
    const { content, toolCalls, stop } = turn.message;
    if (content === null && toolCalls.length === 0) {
      return this.#fail(
        "backend-error",
        "the model server's response was not in OpenAI chat-completion shape",
        turn.started,
      );
    }
    return {
      ok: true,
      text: content ?? "",
      toolCalls,
      stop,
      durationMs: Date.now() - turn.started,
    };
  }

  /**
   * `llm.vision` — the same `/v1/chat/completions`, with image parts as
   * `image_url` data URLs (byollm_021 §6: Ollama, llama.cpp with a projector,
   * vLLM, LM Studio, OpenAI and the compatible endpoints all take this shape).
   *
   * A data URL, never a link: the bytes are the request, so the model server
   * has nothing to fetch and neither does this daemon.
   */
  async readImages(request: VisionRequest): Promise<BackendResult> {
    const turn = await this.#complete(
      request,
      { messages: request.messages.map(toOpenAiTurn) },
      { readsCalls: false },
    );
    if (!turn.ok) return turn;
    if (turn.message.content === null) {
      return this.#fail(
        "backend-error",
        "the model server's response was not in OpenAI chat-completion shape",
        turn.started,
      );
    }
    return {
      ok: true,
      text: turn.message.content,
      durationMs: Date.now() - turn.started,
      stop: turn.message.stop,
    };
  }

  /**
   * `llm.image` — `/v1/images/generations`, asking for `b64_json`.
   *
   * **Bytes, never URLs** ({@link MUSTS.IMAGE_BYTES_NOT_URLS}, C056). A
   * backend that answers with `url` instead is an error, and the URL is not
   * fetched: fetching it would be this device fetching an address a backend
   * chose, which byollm_012 §11.1 holds back from v1.
   */
  async makeImages(request: ImageRequest): Promise<ImageResult> {
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
      return {
        ok: false,
        code: "backend-error",
        message: "no time limit was set for this call",
        durationMs: 0,
      };
    }
    const started = Date.now();
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(request.timeoutMs),
    ]);
    try {
      const response = await fetch(this.#endpoint("images/generations"), {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify({
          model: request.model,
          prompt: request.prompt,
          n: request.count,
          size: request.size,
          response_format: "b64_json",
        }),
        redirect: "error",
        signal,
      });
      const refused = this.#refusal(response, request.model, started);
      if (refused !== undefined) return refused;
      const text = await readCapped(response, request.maxOutputBytes, signal);
      if (text === null) {
        return this.#fail(
          "output-too-large",
          `the model produced more than ${String(request.maxOutputBytes)} bytes`,
          started,
        );
      }
      const answer = extractImages(text);
      if (answer.kind === "url") {
        return this.#fail(
          "backend-error",
          "the model server answered with a URL instead of image bytes; " +
            "byollm never fetches a URL a backend returns — set it to " +
            "return b64_json",
          started,
        );
      }
      if (answer.kind === "malformed") {
        return this.#fail(
          "backend-error",
          "the model server's response was not in OpenAI images shape",
          started,
        );
      }
      return {
        ok: true,
        images: answer.images,
        text: answer.revisedPrompt,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return this.#caught(error, request, started);
    }
  }

  /** The statuses every call here reads the same way. */
  #refusal(
    response: Response,
    model: string,
    started: number,
  ): (BackendResult & { ok: false }) | undefined {
    if (response.status === 401 || response.status === 403) {
      return this.#fail(
        "unauthorized",
        "the model server rejected our credentials",
        started,
      );
    }
    if (response.status === 404) {
      return this.#fail(
        "model-not-found",
        `the model server does not know "${model}"`,
        started,
      );
    }
    if (!response.ok) {
      return this.#fail(
        "backend-error",
        `the model server returned HTTP ${String(response.status)}`,
        started,
      );
    }
    return undefined;
  }

  #caught(
    error: unknown,
    request: { readonly signal: AbortSignal; readonly timeoutMs: number },
    started: number,
  ): BackendResult & { ok: false } {
    if (request.signal.aborted) {
      return this.#fail("canceled", "the job was canceled", started);
    }
    if (isAbort(error)) {
      return this.#fail(
        "timeout",
        `the model did not answer within ${String(request.timeoutMs)}ms`,
        started,
      );
    }
    return this.#fail(
      "backend-unreachable",
      describeFetchError(error, this.#baseUrl.origin),
      started,
    );
  }

  /**
   * POST one chat completion and read the first choice.
   *
   * The body is this adapter's own construction: `model` from owner config,
   * `stream: false`, and the conversation the caller assembled. Nothing in a
   * payload is parsed as configuration.
   */
  async #complete(
    request: Omit<BackendRequest, "prompt">,
    conversation: { messages: unknown[]; tools?: unknown[] },
    reading: { readsCalls: boolean } = { readsCalls: true },
  ): Promise<
    | { ok: true; started: number; message: CompletionMessage }
    | (BackendResult & { ok: false })
  > {
    // A call with no time limit is a caller bug, and running it unbounded is a
    // worse answer than refusing it. Guarded here rather than trusted to the
    // type: the message this replaces read "did not answer within undefinedms",
    // which names a number nobody set — and it fired instantly, so the run
    // looked like a timeout that had not happened.
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
      return {
        ok: false,
        code: "backend-error",
        message: "no time limit was set for this call",
        durationMs: 0,
      };
    }

    const started = Date.now();
    // One timeout governs the call whether it stalls before or during the
    // response body — a server that accepts and then dribbles forever must
    // not be able to wedge the machine.
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = AbortSignal.any([request.signal, timeout]);

    try {
      const response = await fetch(this.#endpoint("chat/completions"), {
        method: "POST",
        headers: this.#headers(),
        // The payload is a JSON string field. Nothing about it is parsed as
        // configuration, and `model` comes from owner config.
        body: JSON.stringify({
          model: request.model,
          ...conversation,
          stream: false,
        }),
        redirect: "error",
        signal,
      });

      if (response.status === 401 || response.status === 403) {
        return this.#fail(
          "unauthorized",
          "the model server rejected our credentials",
          started,
        );
      }
      if (response.status === 404) {
        return this.#fail(
          "model-not-found",
          `the model server does not know "${request.model}"`,
          started,
        );
      }
      if (!response.ok) {
        return this.#fail(
          "backend-error",
          `the model server returned HTTP ${String(response.status)}`,
          started,
        );
      }

      const text = await readCapped(response, request.maxOutputBytes, signal);
      if (text === null) {
        // A hostile or broken local model producing unbounded output must not
        // be able to exhaust memory — byollm_004 §5's zip-bomb row.
        return this.#fail(
          "output-too-large",
          `the model produced more than ${String(request.maxOutputBytes)} bytes`,
          started,
        );
      }

      const message = extractMessage(text, reading.readsCalls);
      if (message === null) {
        return this.#fail(
          "backend-error",
          "the model server's response was not in OpenAI chat-completion shape",
          started,
        );
      }
      return { ok: true, started, message };
    } catch (error) {
      if (request.signal.aborted) {
        return this.#fail("canceled", "the job was canceled", started);
      }
      if (isAbort(error)) {
        return this.#fail(
          "timeout",
          `the model did not answer within ${String(request.timeoutMs)}ms`,
          started,
        );
      }
      return this.#fail(
        "backend-unreachable",
        describeFetchError(error, this.#baseUrl.origin),
        started,
      );
    }
  }

  /*
   * No `retryable` argument any more — ruled 2026-09-04.
   *
   * This adapter used to decide it per failure, and it was the only one whose
   * rule was defensible: `true` for unreachable and for a 5xx. That is
   * exactly why removing it matters. The decision now lives once, in the
   * site-facing class table, and it was the *disagreement* between three
   * adapters that let a value only quota produced become readable as a fact
   * about somebody's account.
   */
  #fail(
    code: Exclude<BackendResult & { ok: false }, never>["code"],
    message: string,
    started: number,
  ): BackendResult & { ok: false } {
    return {
      ok: false,
      code,
      message,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Read a response body, refusing to buffer past `maxBytes`.
 *
 * `response.text()` would happily allocate whatever the server sends. Reading
 * the stream and stopping at the cap is what makes the ceiling real.
 *
 * @returns the text, or null if the cap was exceeded.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string | null> {
  const body = response.body;
  if (body === null) return "";

  // `getReader()` is typed as `any` chunks under this lib target; the stream
  // is bytes, and saying so is what lets the cap arithmetic below be checked.
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** The first choice's message, as far as this daemon reads it. */
interface CompletionMessage {
  /** `null` when the server sent none — a pure tool-call turn may not. */
  readonly content: string | null;
  readonly toolCalls: readonly ModelToolCall[];
  readonly stop: StopReason;
}

/** Pull the assistant turn out of an OpenAI chat-completion response. */
function extractMessage(
  raw: string,
  readsCalls: boolean,
): CompletionMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" && content !== null && content !== undefined)
    return null;
  const toolCalls = readsCalls
    ? extractToolCalls((message as { tool_calls?: unknown }).tool_calls)
    : [];
  if (toolCalls === null) return null;
  const finish = (choices[0] as { finish_reason?: unknown }).finish_reason;
  return {
    content: typeof content === "string" ? content : null,
    toolCalls,
    /* Absent, or a value we have not mapped, is `unknown` — never `end`. An
       adapter that cannot tell must not be able to claim completion. */
    stop:
      typeof finish === "string"
        ? (FINISH_REASONS[finish] ?? "unknown")
        : "unknown",
  };
}

/**
 * The calls a turn asked for, as text — or `null` when the field is there and
 * not in OpenAI's shape, which is a malformed response, not "no calls".
 */
function extractToolCalls(raw: unknown): ModelToolCall[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const calls: ModelToolCall[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null) return null;
    const fn = (entry as { function?: unknown }).function;
    if (typeof fn !== "object" || fn === null) return null;
    const name = (fn as { name?: unknown }).name;
    if (typeof name !== "string") return null;
    const args = (fn as { arguments?: unknown }).arguments;
    const id = (entry as { id?: unknown }).id;
    calls.push({
      /* Some local servers leave the id out. The tool turn has to name one,
         and the position is unique within the turn. */
      id: typeof id === "string" && id !== "" ? id : `call_${String(index)}`,
      name,
      /* OpenAI sends a JSON string; some local servers send the object. The
         loop parses either way, so the object is put back into text rather
         than trusted as already parsed. */
      arguments:
        typeof args === "string"
          ? args
          : args === undefined
            ? "{}"
            : JSON.stringify(args),
    });
  }
  return calls;
}

/** A conversation turn in OpenAI's shape. */
function wireMessage(message: ConverseMessage): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls === undefined || message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              })),
            }),
      };
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
  }
}

/** One vision turn in OpenAI's chat shape: image parts as data URLs. */
function toOpenAiTurn(turn: VisionTurn): unknown {
  if (typeof turn.content === "string") {
    return { role: turn.role, content: turn.content };
  }
  return {
    role: turn.role,
    content: turn.content.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : {
            type: "image_url",
            image_url: {
              url: `data:${part.mediaType};base64,${Buffer.from(part.bytes).toString("base64")}`,
            },
          },
    ),
  };
}

/**
 * The images in an OpenAI `/v1/images/generations` response.
 *
 * `url` is its own answer, not a malformed one, so the error can say what the
 * backend did — and so nothing downstream is ever handed the URL to follow.
 * A response mixing bytes and URLs is a URL response: one image fetched from
 * a backend's address is the whole of what is forbidden.
 */
function extractImages(
  raw: string,
):
  | { kind: "ok"; images: Uint8Array[]; revisedPrompt: string }
  | { kind: "url" }
  | { kind: "malformed" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null)
    return { kind: "malformed" };
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return { kind: "malformed" };
  const images: Uint8Array[] = [];
  let revisedPrompt = "";
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null)
      return { kind: "malformed" };
    const {
      b64_json: b64,
      url,
      revised_prompt: revised,
    } = entry as {
      b64_json?: unknown;
      url?: unknown;
      revised_prompt?: unknown;
    };
    if (typeof b64 !== "string" || b64 === "") {
      return typeof url === "string" ? { kind: "url" } : { kind: "malformed" };
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return { kind: "malformed" };
    images.push(new Uint8Array(Buffer.from(b64, "base64")));
    if (revisedPrompt === "" && typeof revised === "string") {
      revisedPrompt = revised;
    }
  }
  return { kind: "ok", images, revisedPrompt };
}

/** Model ids from an OpenAI `/v1/models` response. */
function extractModelIds(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) =>
      typeof entry === "object" && entry !== null
        ? (entry as { id?: unknown }).id
        : undefined,
    )
    .filter((id): id is string => typeof id === "string");
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/**
 * A reachability failure the owner can act on.
 *
 * Deliberately names the origin and not the underlying error text, which for
 * `fetch` is often a bare "fetch failed" that tells nobody anything.
 */
function describeFetchError(error: unknown, origin: string): string {
  const cause =
    error instanceof Error && "cause" in error && error.cause instanceof Error
      ? error.cause.message
      : error instanceof Error
        ? error.message
        : "unknown error";
  return `could not reach the model server at ${origin} (${cause})`;
}

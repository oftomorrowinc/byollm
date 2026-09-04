import type { BackendClass, BackendId } from "@byollm/protocol";
import { checkBaseUrl } from "../ssrf.js";
import type {
  Backend,
  BackendHealth,
  BackendInit,
  BackendRequest,
  BackendResult,
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
export class OpenAiHttpBackend implements Backend {
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
  #endpoint(path: "chat/completions" | "models"): URL {
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
          messages: [{ role: "user", content: request.prompt }],
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

      const content = extractContent(text);
      if (content === null) {
        return this.#fail(
          "backend-error",
          "the model server's response was not in OpenAI chat-completion shape",
          started,
        );
      }
      return { ok: true, text: content, durationMs: Date.now() - started };
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
  ): BackendResult {
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

/** Pull the assistant text out of an OpenAI chat-completion response. */
function extractContent(raw: string): string | null {
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
  return typeof content === "string" ? content : null;
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

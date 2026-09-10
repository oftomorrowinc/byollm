/**
 * Find local model servers by asking them — byollm_013, applied to onboarding.
 *
 * The obvious way is `ps`, and it is the wrong one. A process list tells you a
 * program is running, not that it will answer, not which port it took when its
 * default was busy, and not what it can serve. It is also three
 * implementations — `ps`, `tasklist`, and whatever BSD does — for a question
 * none of them actually answer.
 *
 * So this asks. One GET per well-known port; whatever replies to
 * `/v1/models` with a model list is a service the owner can use, and the reply
 * carries the model names too. That is the same rule detection already lives
 * under — *running the thing beats naming the thing* — and it is cross-platform
 * for free, because HTTP is.
 *
 * It cannot find a server on a port nobody guessed. That is a real limit and
 * the wizard says so rather than presenting the list as exhaustive: the
 * fallback is the same config file it was always going to be.
 */
import type { BackendId } from "@byollm/protocol";

/** Ports these servers take by default, with the name a person would know. */
const WELL_KNOWN: readonly { readonly port: number; readonly label: string }[] =
  Object.freeze([
    { port: 11434, label: "Ollama" },
    { port: 1234, label: "LM Studio" },
    { port: 8080, label: "llama.cpp or MLX" },
    { port: 8000, label: "vLLM" },
    { port: 5000, label: "LocalAI" },
    { port: 1337, label: "Jan" },
  ]);

export interface LocalServer {
  readonly label: string;
  readonly baseUrl: string;
  /** What it said it can serve. Empty is legal — some servers list nothing. */
  readonly models: readonly string[];
  /**
   * Which provider this actually is, when the server said so — B112.
   *
   * `label` is a guess from the port and always has been: it is what to print
   * beside an address, and printing is all it was ever asked to do. **Then it
   * became the only thing we knew**, so `pasteableService` and the picker
   * wrote `type: "openai-http"` for a server we had just identified — the one
   * config shape that cannot be started on demand, which is what B098 then
   * has to explain and offer to fix.
   *
   * `undefined` is not "unknown provider" in the vague sense. It is **we did
   * not verify one**, and the caller falls back to the generic transport,
   * which is exactly what it did before. A port map is a guess and a guess
   * must not decide what a service's type is; only an answer may.
   */
  readonly backendId?: BackendId;
}

/**
 * Every well-known port that answered, with what it offers.
 *
 * Probed in parallel with a short timeout: this runs while somebody is
 * watching a prompt, and six sequential connection refusals on a quiet machine
 * is a pause long enough to look broken.
 */
export async function probeLocalServers(
  timeoutMs = 1_500,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalServer[]> {
  const found = await Promise.all(
    WELL_KNOWN.map(({ port, label }) =>
      probeOne(
        `http://127.0.0.1:${String(port)}/v1`,
        label,
        timeoutMs,
        fetchImpl,
      ),
    ),
  );
  return found.filter((server): server is LocalServer => server !== undefined);
}

async function probeOne(
  baseUrl: string,
  label: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<LocalServer | undefined> {
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/models`, {
      signal: abort.signal,
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const identified = await identify(baseUrl, timeoutMs, fetchImpl);
    return {
      label: identified?.label ?? label,
      baseUrl,
      models: modelsFrom(body),
      ...(identified === undefined ? {} : { backendId: identified.id }),
    };
  } catch {
    // Refused, timed out, or answered something that is not JSON. All of them
    // mean the same thing to somebody setting up a laptop: nothing to offer
    // here. The detail belongs in `byollm services`, which is about a service
    // the owner has actually chosen.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Who this server actually is, asked rather than inferred — B112.
 *
 * **Ollama only, and that is a scope rather than an oversight.** The point of
 * knowing the provider is that `startCommandFor` can start it, and `ollama` is
 * the only id that has a start command today. Identifying LM Studio would
 * produce a more specific `type` and change nothing a person can act on, so
 * the other five stay port guesses until somebody has the machine to write
 * their start command on — the way the login commands were done, one at a
 * time, by running them.
 *
 * `/api/version` is Ollama's own API rather than the OpenAI compatibility
 * layer, so nothing else on a well-known port answers it. Verified by running
 * it against a live Ollama: `{"version":"0.30.8"}`, 200.
 *
 * **Asked at whatever address answered, not at the port we expected.** Ollama
 * on 8080 would otherwise be labelled "llama.cpp or MLX" by the port map and
 * typed `ollama` by this — a screen contradicting itself. The answer wins for
 * both, which is what makes the label verified where it can be.
 */
async function identify(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ readonly id: BackendId; readonly label: string } | undefined> {
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(new URL("/api/version", baseUrl), {
      signal: abort.signal,
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { version?: unknown }).version !== "string"
    ) {
      return undefined;
    }
    return { id: "ollama", label: "Ollama" };
  } catch {
    /* Not there, not Ollama, or not JSON. All of them mean the same thing: we
       did not learn a provider, so nobody may claim one. */
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Model ids out of an OpenAI-shaped `/v1/models` reply.
 *
 * Parsed defensively rather than cast: this is a response from a program
 * nobody here wrote, on a port anything could be listening to. A server that
 * answers 200 with a shape we did not expect is not an error worth failing
 * setup over — it is a server with no models to list, which is a legal answer.
 */
function modelsFrom(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((row) =>
      typeof row === "object" && row !== null
        ? (row as { id?: unknown }).id
        : undefined,
    )
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

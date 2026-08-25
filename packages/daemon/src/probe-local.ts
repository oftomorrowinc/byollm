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
    return { label, baseUrl, models: modelsFrom(body) };
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

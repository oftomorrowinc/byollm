import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Why a route is not healthy, in terms somebody can act on — cloud_002.
 *
 * `byollm backends` said "0 of 2 routes are healthy" and left the reader to
 * work out why. Todd hit it on a fresh install: the default config points at
 * Ollama's port, he does not run Ollama, and nothing on screen connected those
 * two facts. The ruling is **detection-first over auto-start** — the daemon
 * says which of three things is true rather than starting a server nobody
 * asked for:
 *
 * - **not installed** — the tool that usually listens there is not on PATH.
 * - **not running** — it is installed and nothing is listening.
 * - **wrong port** — something answered, but not as a model server.
 *
 * Each answer carries the command that fixes it. A diagnosis without a next
 * step is a more precise way of being stuck.
 *
 * ## Why this is a heuristic, and why that is honest
 *
 * A base URL does not say which server is behind it — `openai-http` at 11434
 * is *probably* Ollama because that is its default port and the daemon's own
 * default config, but somebody may have put anything there. So the wording is
 * "usually" rather than "is", and the port table is small and explicit rather
 * than clever. Being approximately right and saying so beats being silent.
 */

/** The tool that conventionally listens on a port, and how to get it going. */
interface Suspect {
  readonly name: string;
  /** Binary to look for on PATH. */
  readonly binary: string;
  /** What to run when it is installed but not listening. */
  readonly start: string;
  /** What to run when it is not installed at all. */
  readonly install: string;
}

const BY_PORT: Record<string, Suspect> = {
  "11434": {
    name: "Ollama",
    binary: "ollama",
    start: "ollama serve   # then: ollama pull llama3.2",
    install: "brew install ollama && ollama pull llama3.2",
  },
  "8080": {
    name: "MLX or llama.cpp",
    binary: "mlx_lm.server",
    start: "mlx_lm.server --model <model> --port 8080",
    install: "pip install mlx-lm",
  },
  "8000": {
    name: "vLLM",
    binary: "vllm",
    start: "vllm serve <model> --port 8000",
    install: "pip install vllm",
  },
  "1234": {
    name: "LM Studio",
    binary: "lms",
    start: "start LM Studio and turn on its local server",
    install: "install LM Studio from lmstudio.ai",
  },
};

/**
 * Is a binary on PATH? Never throws — an unknown answer is "cannot tell".
 *
 * Injectable, and that is not only for coverage: a test that shells out to
 * `which` asserts something about the machine it runs on, so the same suite
 * would print different advice on a laptop with Ollama installed than in CI
 * without it. The probe is the environment; the sentence is the unit.
 */
type PathProbe = (binary: string) => Promise<boolean | undefined>;

const whichProbe: PathProbe = async (binary) => {
  try {
    await run(process.platform === "win32" ? "where" : "which", [binary], {
      timeout: 2_000,
    });
    return true;
  } catch (error) {
    // `which` exits non-zero when not found, which is an answer. Anything
    // else — no shell, a timeout — is genuinely unknown, and saying "not
    // installed" then would be a confident lie.
    const code = (error as { code?: unknown }).code;
    return code === 1 || code === "ENOENT" ? false : undefined;
  }
};

/**
 * A sentence about one unhealthy route, or nothing when there is no better
 * guess than the health detail already printed.
 */
export async function diagnoseRoute(input: {
  baseUrl?: string | undefined;
  detail?: string | undefined;
  onPath?: PathProbe;
}): Promise<string | undefined> {
  const onPath = input.onPath ?? whichProbe;
  if (input.baseUrl === undefined) return undefined;

  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    return undefined;
  }

  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
    url.hostname,
  );
  if (!loopback) {
    // A remote server that is not answering is somebody else's outage, and
    // the daemon has nothing useful to add about their infrastructure.
    return undefined;
  }

  const refused =
    input.detail === undefined ||
    /ECONNREFUSED|fetch failed|could not reach/i.test(input.detail);
  const suspect = BY_PORT[url.port];

  if (!refused) {
    // Something is listening and answered wrongly — the one case where the
    // port is right and the server behind it is not what we assumed.
    return (
      `Something is listening on ${url.origin} but did not answer as a model ` +
      `server. Check that it speaks the OpenAI-compatible API, or point ` +
      `this route at the server that does.`
    );
  }

  if (suspect === undefined) {
    return (
      `Nothing is listening on ${url.origin}. Start the model server you ` +
      `meant, or change this route's baseUrl in ~/.byollm/config.json.`
    );
  }

  const installed = await onPath(suspect.binary);
  if (installed === false) {
    return (
      `Nothing is listening on ${url.origin}, and ${suspect.binary} is not ` +
      `on your PATH — ${suspect.name} usually serves that port.\n` +
      `      ${suspect.install}`
    );
  }
  return (
    `Nothing is listening on ${url.origin}. ${suspect.name} usually serves ` +
    `that port${installed === true ? " and is installed" : ""}.\n` +
    `      ${suspect.start}`
  );
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  BACKEND_IDS,
  backendDescriptor,
  backendName,
  type BackendId,
} from "@byollm/protocol";
import { startCommandFor } from "./local-server.js";

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

/**
 * What is actually on the port — asked, because nobody was passing the answer.
 *
 * This used to be inferred from a `detail` string: *"if the health message
 * matches /ECONNREFUSED|fetch failed/ then nothing is listening"*. **The only
 * caller in the repository never passed `detail`**, so every unhealthy route
 * took the `undefined` branch and every diagnosis began "Nothing is listening
 * on …" — including for a server that was up and simply did not have the
 * configured model, which is what `byollm services` shows when
 * `health.models` omits it.
 *
 * Found by running B098's new sentence on a live Ollama: it offered to change
 * a service's `type` so byollm could start a server that was already running.
 * **An instrument with no reader, and a claim resting on it.**
 *
 * So the port is asked. One GET, the same one `probeLocalServers` makes, on
 * the address the route already names — running the thing beats naming the
 * thing, and a diagnosis is exactly where a guess is least affordable.
 */
export type Reach = (
  baseUrl: string,
) => Promise<"answered" | "wrong" | "silent">;

const fetchProbe: Reach = async (baseUrl) => {
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
  }, 1_500);
  try {
    const response = await fetch(`${baseUrl}/models`, { signal: abort.signal });
    if (!response.ok) return "wrong";
    const body: unknown = await response.json();
    /* A 200 that is not a model list is something else on the port, which is
       a different problem from an empty catalogue — a server with no models
       is still a server, and `probeLocalServers` treats it as one. */
    return typeof body === "object" && body !== null ? "answered" : "wrong";
  } catch {
    /* Refused, timed out, or answered something that is not JSON at all.
       "Silent" is the honest word: this cannot tell a dead port from a
       hostile one, and the advice is the same either way. */
    return "silent";
  } finally {
    clearTimeout(timer);
  }
};

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
 * Which provider byollm could start at this address — B098, and it asks
 * rather than adding a third table.
 *
 * Two authorities, both already here: the protocol registry knows each
 * provider's default address, and `startCommandFor` knows which ones this
 * daemon can spawn. Writing `11434 -> ollama` into {@link BY_PORT} would have
 * been a third place naming that port and a promise to update it when the
 * start command list grows, which is the divergence instruction 9 is about.
 * **Delete `ollama serve` from `startCommandFor` and this offer disappears by
 * itself**, which is the property a hand-written table cannot have.
 */
function startableAt(origin: string): BackendId | undefined {
  for (const id of BACKEND_IDS) {
    if (startCommandFor(id) === undefined) continue;
    const address = backendDescriptor(id).defaultBaseUrl;
    if (address === undefined) continue;
    try {
      if (new URL(address).origin === origin) return id;
    } catch {
      /* A registry entry with an unparseable address is not this function's
         to complain about; it simply matches nothing. */
    }
  }
  return undefined;
}

/**
 * A sentence about one unhealthy route, or nothing when there is no better
 * guess than the health detail already printed.
 */
export async function diagnoseRoute(input: {
  baseUrl?: string | undefined;
  detail?: string | undefined;
  /**
   * What the owner's config says this service is — B098.
   *
   * The reason the sentence can change from *"start it yourself"* to *"byollm
   * would start this if your config named it"*. Without it the diagnosis
   * knows the address and not the service, and the whole finding is that
   * those two disagree.
   */
  backendId?: BackendId | undefined;
  onPath?: PathProbe;
  reach?: Reach;
}): Promise<string | undefined> {
  const onPath = input.onPath ?? whichProbe;
  const reach = input.reach ?? fetchProbe;
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

  const suspect = BY_PORT[url.port];
  const on = await reach(input.baseUrl);

  if (on === "answered") {
    /**
     * The server is up, and this route is unhealthy for a reason the port
     * cannot show — B098, found by running it.
     *
     * Almost always the model: `detectCapabilities` refuses to advertise a
     * model the server's own catalogue does not list, so a config naming
     * `glm-5.2` against a server serving `glm-5.2:cloud` is unhealthy while
     * the server answers perfectly. This branch used to be unreachable, and
     * the sentence it fell through to was "Nothing is listening" — the wrong
     * cause, and then an offer to fix it by changing a field.
     */
    return (
      `${url.origin} is answering, so the address is right and this ` +
      `service still is not usable.\n` +
      `      The usual reason is the model: this device will not advertise ` +
      `a model the server\n` +
      `      does not list. \`byollm services\` names what it is serving; ` +
      `\`byollm model <service> <name>\`\n      checks one and writes it.` +
      (input.detail === undefined ? "" : `\n      ${input.detail}`)
    );
  }

  if (on === "wrong") {
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

  const here = `Nothing is listening on ${url.origin}. ${suspect.name} usually serves that port${installed === true ? " and is installed" : ""}.`;
  const startable = startableAt(url.origin);

  /**
   * The offer, and the reason it is an offer — B098, ruled (c) by Todd 09-10.
   *
   * `startCommandFor` switches on the backend id, so only `type: "ollama"`
   * is ever started — and the config people actually write for Ollama is
   * `openai-http` pointed at `127.0.0.1:11434`, which is what Todd's own
   * machine had and what the old wizard produced. **The feature did not
   * reach its own common case, and said nothing about it.**
   *
   * Three options were on the table and the middle one is the interesting
   * rejection: keying startability on the ADDRESS would reach every such
   * config, and would mean byollm running `ollama serve` for a service whose
   * owner never named Ollama — if something else is listening on 11434, that
   * is software the owner did not ask for. **Per instruction 11, what would
   * change it:** a way to know what a STOPPED server would have been, which
   * is precisely what nobody can ask a port that is not answering.
   *
   * So the daemon neither decides on the owner's behalf nor stays silent. It
   * names the one field, which is the same shape as B056's advertising
   * ruling and B106's memory prompt: where the machine can infer a useful
   * action but not the intent, the surface asks.
   */
  if (startable !== undefined && input.backendId !== startable) {
    return (
      `${here}\n` +
      `      byollm could start it when a job needs one, and will not for ` +
      `this service:\n` +
      `      its type is "${input.backendId ?? "unset"}", so it never named a ` +
      `server to start.\n` +
      `      Set "type": "${startable}" on this service and byollm will start ` +
      `it for you.\n` +
      `      Or start it yourself: ${suspect.start}`
    );
  }

  /**
   * And when the config DOES name it, say what this build actually does.
   *
   * This sentence handed somebody `ollama serve` and nothing else, which was
   * the whole truth until 0.1.0-alpha.88 shipped on-demand start. Telling an
   * owner to start by hand a server the daemon is about to start for them is
   * advice that was true when it was written and is not now — the shape
   * instruction 7 exists for, found on the row that had to read this function
   * anyway.
   */
  if (startable !== undefined) {
    return (
      `${here}\n` +
      `      byollm starts ${backendName(startable)} itself when a job needs ` +
      `it, unless this device is\n` +
      `      below its memory floor — \`byollm status\` shows the guard.\n` +
      `      To use it from this shell now: ${suspect.start}`
    );
  }

  return `${here}\n      ${suspect.start}`;
}

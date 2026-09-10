import { resolveCost } from "@byollm/protocol";
import type { LocalServer } from "./probe-local.js";

/**
 * Models a server is offering that nothing on this device points at — B100b.
 *
 * Todd pulled `smollm2:135m`, `ollama list` showed five models, and `byollm
 * services` showed the two his config names. Nothing on any byollm surface
 * said the other three existed or how to reach one. For a product whose pitch
 * is "run the models you already have", the gap between having one and using
 * one was a JSON file nobody mentions.
 *
 * ## Display only, and the rule is not a formality
 *
 * `backends.ts` is explicit that cost is classified from the owner's
 * CONFIGURED value and that a server's catalogue "is not theirs to be
 * classified by". A discovery surface that became a routing input would let a
 * server's own list decide what this machine offers and what it costs, which
 * is the hole B097 had money on. So this returns names to print and nothing
 * else: no ids, no types, no cost, nothing a router could reach for.
 *
 * ## The catalogue is what is PULLED, not what will run
 *
 * `gemma4:26b` is 17 GB and appears in this list on a 36 GB laptop that
 * cannot comfortably serve it. Naming it is still right — B056's rule is that
 * the SERVER answers, not that a model is loaded — but the list is an
 * inventory, not a promise, and B106's prompt is what stands between somebody
 * picking one and a wedged machine.
 */
export interface UnusedModels {
  readonly label: string;
  readonly baseUrl: string;
  readonly models: readonly string[];
}

export function unusedModels(input: {
  readonly servers: readonly LocalServer[];
  /** Every (baseUrl, model) pair a configured service already points at. */
  readonly configured: readonly {
    baseUrl?: string | undefined;
    model?: string | undefined;
  }[];
}): UnusedModels[] {
  /**
   * Matched on the pair, not on the model name alone.
   *
   * The same model id can sit behind two servers — `qwen-2.5-14b` on MLX and
   * on Ollama — and a service pointing at one of them says nothing about the
   * other. Keying on the name would hide a genuinely unused model because its
   * namesake elsewhere was in use.
   */
  const taken = new Set(
    input.configured
      .filter(
        (entry) => entry.baseUrl !== undefined && entry.model !== undefined,
      )
      .map((entry) => `${normalise(entry.baseUrl ?? "")} ${entry.model ?? ""}`),
  );

  return input.servers
    .map((server) => ({
      label: server.label,
      baseUrl: server.baseUrl,
      models: server.models.filter(
        (model) => !taken.has(`${normalise(server.baseUrl)} ${model}`),
      ),
    }))
    .filter((server) => server.models.length > 0);
}

/**
 * The config block that would use one — the sanctioned fallback.
 *
 * byollm_023 split B100 and then ruled the split away: one interactive screen
 * rather than three verbs. That screen is not built, and this row is not
 * allowed to wait on it, because the spec named the fallback in advance —
 * *"if B100a slips, the note prints the exact config block to paste. Worse
 * product, true sentence, and it beats silence."*
 *
 * So this prints what somebody would otherwise have to work out: the exact
 * JSON, with their model and their address in it. It is worse than a picker
 * and it is honest about being a paste, which is the trade the spec already
 * accepted.
 *
 * `offer` is written out rather than left to a default, because a service
 * created without a visible scope is a consent decision made by a tool —
 * B100's second constraint, which applies to a printed block exactly as it
 * would to a wizard.
 */
export function pasteableService(input: {
  readonly model: string;
  readonly baseUrl: string;
}): string {
  return JSON.stringify(
    {
      [serviceNameFor(input.model)]: {
        type: "openai-http",
        baseUrl: input.baseUrl,
        model: input.model,
        kinds: ["llm.generate", "llm.chat"],
        offer: "private",
      },
    },
    null,
    2,
  );
}

/**
 * A service name from a model id, and it is a suggestion rather than a rule.
 *
 * The owner's word for a service is theirs — `byollm services` prints it as
 * the identifier a site passes to `enqueue({ service })` — so this only has
 * to produce something legal and recognisable in a block they are about to
 * edit anyway. The tag is dropped because `smollm2:135m` is a name somebody
 * would have to quote, and the part before the colon is the part they say out
 * loud.
 */
function serviceNameFor(model: string): string {
  const base = (model.split(":")[0] ?? model).split("/").pop() ?? model;
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "-");
  return cleaned.length > 0 ? cleaned : "my-model";
}

function normalise(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url.trim();
  }
}

/**
 * The whole section `byollm services` prints, or nothing at all — B100b.
 *
 * Lines rather than writes, the same shape `service-line.ts` uses: the
 * decisions here are which models to name, how to mark the ones that are not
 * local compute, and which one to hold up as the example — and every one of
 * those is worth a test. Presentation built inside a command is presentation
 * nothing can reach, which the coverage gate said out loud when this lived in
 * `cli.ts`.
 *
 * Empty when there is nothing to say. A machine whose every model is already
 * configured gets no paragraph, because a section that is always there is
 * furniture — the same reason the memory guard says nothing above the floor.
 */
export function unusedModelsReport(input: {
  readonly servers: readonly LocalServer[];
  readonly configured: readonly {
    baseUrl?: string | undefined;
    model?: string | undefined;
  }[];
}): string[] {
  const spare = unusedModels(input);
  if (spare.length === 0) return [];

  const lines = ["", "also on this machine, not used by any service"];
  for (const server of spare) {
    lines.push(`  ${server.label} (${server.baseUrl})`);
    for (const model of server.models) {
      /**
       * A `:cloud` tag is marked, because this list looks like local compute
       * and one of these is not.
       *
       * Found by running it: Todd's Ollama serves `kimi-k3:cloud` beside
       * three genuinely local models. Ollama proxies hosted models through
       * the same loopback port, so the address says local and the bill does
       * not — B097's whole subject, arriving on a new surface three rows
       * later. Printing it unmarked under "on this machine" would be the
       * page saying the friendlier half.
       *
       * Asked of {@link resolveCost} rather than decided here: cost has one
       * home, and a surface that classified for itself is the defect B085
       * arrived as.
       */
      const cost = costOf(server.baseUrl, model);
      lines.push(
        `    ${model}${cost === "free" ? "" : `  (${cost} — runs on your provider's account)`}`,
      );
    }
  }

  /**
   * One example, and a FREE one where there is one.
   *
   * The block is the same shape every time, so printing six would bury the
   * sentence explaining it — but taking the first model blindly would offer
   * somebody a paste that quietly creates a metered service. Local first, and
   * the mark above still tells the truth when every model here is hosted.
   */
  const example =
    spare
      .flatMap((server) => server.models.map((name) => ({ server, name })))
      .find(({ server, name }) => costOf(server.baseUrl, name) === "free") ??
    (spare[0]?.models[0] === undefined
      ? undefined
      : { server: spare[0], name: spare[0].models[0] });
  if (example === undefined) return lines;

  lines.push(
    "",
    "To use one, add it to the `services` block of ~/.byollm/config.json:",
    "",
    ...pasteableService({
      model: example.name,
      baseUrl: example.server.baseUrl,
    })
      .split("\n")
      .map((line) => `    ${line}`),
    "",
    "  `offer` is written out on purpose — a service created without a",
    "  visible scope is a decision made for you. `private` means only your",
    "  own work runs on it.",
  );
  return lines;
}

/**
 * What a model behind this address would cost, asked of the one classifier.
 *
 * `openai-http` because that is what the printed block declares, so the
 * answer describes the service somebody would actually create rather than a
 * hypothetical one.
 */
function costOf(baseUrl: string, model: string): string {
  return resolveCost("openai-http", baseUrl, model);
}

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

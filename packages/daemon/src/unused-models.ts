import { resolveCost, type BackendId } from "@byollm/protocol";
import type { LocalServer } from "./probe-local.js";
import { serviceBlockFor, serviceNameFor } from "./services-manage.js";

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
  /**
   * The provider the server named, carried through — B112.
   *
   * The rule above still holds and this does not weaken it: the CATALOGUE is
   * display-only and never reaches a router. Who the server *is* is a
   * different fact, and it is the one that decides whether the block printed
   * below can be started on demand. Optional because it is only ever set by
   * an answer.
   */
  readonly backendId?: BackendId;
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
      ...(server.backendId === undefined
        ? {}
        : { backendId: server.backendId }),
      models: server.models.filter(
        (model) => !taken.has(`${normalise(server.baseUrl)} ${model}`),
      ),
    }))
    .filter((server) => server.models.length > 0);
}

/**
 * The config block that would use one — one definition, two readers.
 *
 * byollm_023 split B100 and then ruled the split away: one interactive screen
 * rather than three verbs. That screen exists now — `byollm services manage`,
 * B100a — and this stays, because the screen needs a terminal and this
 * command does not. A machine reached over a pipe, a CI log, somebody who
 * would rather edit the file: all of them get the exact JSON with their model
 * and their address already in it.
 *
 * **It is the same block the picker writes**, because it asks the picker's
 * own {@link serviceBlockFor} rather than restating the shape. Two spellings
 * of "what a service for this model looks like" is exactly the divergence
 * instruction 9 exists for, and this file carried one of them until B100a.
 *
 * `offer` is written out rather than left to a default, because a service
 * created without a visible scope is a consent decision made by a tool —
 * B100's second constraint, which applies to a printed block exactly as it
 * would to a wizard.
 */
export function pasteableService(input: {
  readonly model: string;
  readonly baseUrl: string;
  readonly type?: BackendId | undefined;
}): string {
  return JSON.stringify(
    { [serviceNameFor(input.model)]: serviceBlockFor(input) },
    null,
    2,
  );
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
      const cost = costOf(server.baseUrl, model, server.backendId);
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
      .find(
        ({ server, name }) =>
          costOf(server.baseUrl, name, server.backendId) === "free",
      ) ??
    (spare[0]?.models[0] === undefined
      ? undefined
      : { server: spare[0], name: spare[0].models[0] });
  if (example === undefined) return lines;

  lines.push(
    "",
    "  `byollm services manage` turns one on, and asks nothing you have to",
    "  look up. Or add it to the `services` block of ~/.byollm/config.json:",
    "",
    ...pasteableService({
      model: example.name,
      baseUrl: example.server.baseUrl,
      type: example.server.backendId,
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
 * **The same type the printed block declares**, so the answer describes the
 * service somebody would actually create rather than a hypothetical one —
 * which is why this takes the argument rather than hard-coding a transport.
 * B112 made the block say `ollama` where the server said so, and a classifier
 * still asked about `openai-http` would have been answering about a different
 * config from the one on screen.
 *
 * It happens not to change any answer today: `classifyCost` reads the
 * `:cloud` tag before the declared cost, which is B097's fix, so both
 * spellings agree. **Passing it anyway is the point** — the one-definition
 * rule was breached last time through exactly this gap, an asker who supplied
 * two of three arguments.
 */
function costOf(
  baseUrl: string,
  model: string,
  type: BackendId | undefined,
): string {
  return resolveCost(type ?? "openai-http", baseUrl, model);
}

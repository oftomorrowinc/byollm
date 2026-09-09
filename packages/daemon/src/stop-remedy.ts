import { backendName, type BackendId } from "@byollm/protocol";
import type { StopReason } from "./backends/index.js";

/**
 * What an owner does about a truncated answer — B064 step 3.
 *
 * byollm_021: *"a truncation without a remedy turns 'raise the output
 * ceiling' into 'this model is bad,'"* and somebody then reaches for the fix
 * that always looks available — switching models, or turning the service off.
 * So the local surface says the fact AND the knob.
 *
 * ## Whose ceiling it is, which decides the whole sentence
 *
 * **Ours fails loudly and is not this.** `maxOutputBytes` is applied while
 * reading the response and produces `output-too-large`, a refusal with its
 * own code and message. A `length` result is therefore always the MODEL's own
 * ceiling — verified by reading the adapter, which never sends `max_tokens`
 * at all, so nothing byollm configures is capping generation.
 *
 * That is why the remedy names the model's parameter rather than anything in
 * `~/.byollm/config.json`. Pointing an owner at our config for their model's
 * limit would be the "this model is bad" outcome by a different route.
 *
 * ## Verified by running it, per the `startCommandFor` precedent
 *
 * Against the local Ollama on 2026-09-09, `smollm2:135m`, both directions
 * from the same server:
 *
 *   · `/v1/chat/completions` with `max_tokens: 8`  -> `finish_reason: length`
 *   · the same endpoint, a short answer, no cap    -> `finish_reason: stop`
 *   · `/api/generate` with `options.num_predict: 8` -> `done_reason: length`
 *
 * So `num_predict` is the knob, and the detection we shipped in .86 fires
 * against a real server rather than only against a fixture.
 */
export function stopRemedy(
  backendId: BackendId,
  stop: StopReason,
): string | undefined {
  if (stop !== "length") return undefined;

  /**
   * Only where there is a knob. byollm_021 is explicit: *"where a
   * subscription CLI has no owner-side knob, say so plainly rather than
   * invent one"* — and inventing one is worse than silence, because an
   * instruction that does nothing spends the owner's afternoon before it
   * spends their patience.
   */
  switch (backendId) {
    case "ollama":
      return "raise `num_predict` on the model's parameters";
    case "openai-http":
    case "vllm":
    case "lmstudio":
    case "jan":
    case "localai":
    case "mlx":
    case "llamacpp":
      return "raise the output ceiling on the server that served it";
    default:
      return undefined;
  }
}

/**
 * The one sentence an owner reads about a stopped answer.
 *
 * `undefined` where there is nothing worth saying: a model that finished, or
 * a stop token doing its job, is not news. **`unknown` IS news** — it means
 * this device cannot tell, and an owner comparing two services deserves to
 * know which of them can answer the question at all.
 */
export function stopLine(
  backendId: BackendId,
  stop: StopReason,
): string | undefined {
  if (stop === "end" || stop === "stop-sequence") return undefined;
  if (stop === "unknown") {
    /**
     * `backendName`, not `label` — and the codebase already made this
     * decision once. The registry's label does two jobs, naming a product
     * and classifying it: "Claude CLI (your subscription)". That is right in
     * a list, where the parenthetical is the only classification on screen,
     * and wrong in a sentence about something else — which this is. Seen by
     * running it: *"Claude CLI (your subscription) does not report why
     * generation stopped"* puts a billing fact in the middle of a sentence
     * about truncation.
     */
    return (
      `this answer may be incomplete — ${backendName(backendId)} does not ` +
      `report why generation stopped`
    );
  }
  const remedy = stopRemedy(backendId, stop);
  return (
    "the model stopped at its own output ceiling, so this answer is cut off" +
    (remedy === undefined ? "" : ` — ${remedy}`)
  );
}

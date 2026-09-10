import type { BackendId } from "@byollm/protocol";
import type { StopReason, StopReasonMapping } from "./backends/index.js";

/**
 * What an owner does about a truncated answer — B064 step 3, corrected by
 * B105.
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
 * own code. A `length` result is therefore always the MODEL's own ceiling —
 * verified by reading the adapter, which never sends `max_tokens` at all, so
 * nothing byollm configures is capping generation. Pointing an owner at our
 * config for their model's limit would be the "this model is bad" outcome by
 * a different route.
 *
 * ## Verified by running it, per the `startCommandFor` precedent
 *
 * Against the local Ollama on 2026-09-09, `smollm2:135m`, both directions
 * from the same server: `max_tokens: 8` gave `finish_reason: length`, a short
 * answer gave `stop`, and `/api/generate` with `options.num_predict: 8` gave
 * `done_reason: length`. So `num_predict` is the knob.
 */

/**
 * The knob, for every backend — B105.
 *
 * A `Record<BackendId, …>` rather than a `switch` with a `default`, and that
 * is the fix rather than a tidy-up. The switch enumerated eight of the
 * seventeen HTTP backends, so **nine vendor APIs fell to silence by omission
 * rather than by decision** — and a backend added next year would have
 * inherited that silence with nothing failing.
 *
 * Total, so the compiler is the check. The registry already makes
 * `adversarialCorpus` and `stopReasons` required for exactly this reason: a
 * new backend cannot arrive without answering, and this is the same
 * treatment one layer out.
 *
 * `null` means "no owner-side knob", which is a decision and reads as one.
 * byollm_021 is explicit that where there is none we say so plainly rather
 * than invent one — an instruction that does nothing spends the owner's
 * afternoon before it spends their patience.
 */
const REMEDIES: Readonly<Record<BackendId, string | null>> = Object.freeze({
  /* Local servers: the owner owns the model and its parameters. */
  ollama: "raise `num_predict` on the model's parameters",
  llamacpp: "raise the output ceiling on the server that served it",
  vllm: "raise the output ceiling on the server that served it",
  lmstudio: "raise the output ceiling on the server that served it",
  jan: "raise the output ceiling on the server that served it",
  localai: "raise the output ceiling on the server that served it",
  mlx: "raise the output ceiling on the server that served it",
  "openai-http": "raise the output ceiling on the server that served it",

  /**
   * Vendor APIs: no knob, and the reason is the same for all nine.
   *
   * The ceiling is the vendor's own default for that model, and byollm sends
   * no `max_tokens`, so there is nothing on this device to turn. Telling an
   * owner to raise a ceiling they do not control is the invented instruction
   * byollm_021 warns about — and it would be nine of the seventeen.
   */
  anthropic: null,
  openai: null,
  gemini: null,
  grok: null,
  groq: null,
  openrouter: null,
  together: null,
  deepseek: null,
  mistral: null,

  /* Subscription CLIs: no owner-side ceiling at all. */
  "claude-cli": null,
  "codex-cli": null,
});

export function stopRemedy(
  backendId: BackendId,
  stop: StopReason,
): string | undefined {
  if (stop !== "length") return undefined;
  return REMEDIES[backendId] ?? undefined;
}

/**
 * The one sentence an owner reads about a stopped answer — B105 rewrote it.
 *
 * ## `unknown` is two different facts, and saying one of them is false
 *
 * The first version printed *"does not report why generation stopped"* for
 * every `unknown`. Seen by running it, that is false for the common case:
 * `FINISH_REASONS` maps `stop` and `length` and nothing else, so a
 * **declared** adapter returning `content_filter`, `tool_calls`, or any
 * vendor extra resolves to `unknown` — and it did report, we did not
 * recognise the word.
 *
 * The daemon holds the distinguishing fact. `stopReasons.kind` is `declared`
 * when the adapter reads a real signal and `unavailable` when it cannot, so
 * the sentence branches on it rather than on the resolved value. This is the
 * same conflation B064's third mapping kind was introduced to fix, arriving
 * on the surface instead of in the declaration.
 *
 * ## No registry label as a sentence subject
 *
 * Second instance of the defect fixed one row earlier. `backendName` on the
 * generic backend is *"Any OpenAI-compatible server"*, a noun phrase written
 * for a list, and as a subject it reads *"Any OpenAI-compatible server does
 * not report why generation stopped"* — which sounds like a claim about the
 * category rather than about the service that just ran.
 *
 * So no name at all: the line is printed indented under an entry that already
 * says `ollama:smollm2:135m`, and repeating it there was what forced a
 * subject into the sentence in the first place.
 */
export function stopLine(
  backendId: BackendId,
  stop: StopReason,
  kind: StopReasonMapping["kind"] | undefined,
): string | undefined {
  if (stop === "end" || stop === "stop-sequence") return undefined;
  if (stop === "unknown") {
    /* Absent `kind` is an entry written before this was recorded. It cannot
       be resolved either way now, so it says the thing that is true of both:
       we do not know why. */
    if (kind === undefined) return "why this answer stopped was not recorded";
    return kind === "unavailable"
      ? "this answer may be incomplete — this service does not report why generation stopped"
      : "this answer may be incomplete — the service did not say why it stopped this time";
  }
  const remedy = stopRemedy(backendId, stop);
  return (
    "the model stopped at its own output ceiling, so this answer is cut off" +
    (remedy === undefined ? "" : ` — ${remedy}`)
  );
}

import type { Backend, ConverseTool } from "./backends/types.js";

/**
 * Whether a service's model can use a site's tools — byollm_012 §7.
 *
 * Detected, not declared ({@link MUSTS.CAPABILITY_IS_DETECTED}). The probe
 * offers one function, `echo_number`, and asks for 7. A service advertises
 * `llm.tools` only if the model calls `echo_number` with `7` **and then uses
 * the result in its answer** — a model that calls functions but ignores what
 * they return would read a site's search results and answer from memory.
 *
 * The result carries a code the model cannot guess, so "uses the result" is
 * checked rather than assumed: a model that answers "7" has echoed its own
 * question.
 *
 * Like the loop, the probe runs nothing: the "tool" is this file's own
 * constant answer.
 */
const ECHO_NUMBER: ConverseTool = Object.freeze({
  name: "echo_number",
  description:
    "Echoes the number it is given, with a confirmation code. Call it when " +
    "asked to.",
  parameters: Object.freeze({
    type: "object",
    properties: Object.freeze({
      n: Object.freeze({ type: "integer", description: "The number to echo." }),
    }),
    required: Object.freeze(["n"]),
    additionalProperties: false,
  }),
});

const ASK =
  "Call the echo_number tool with n set to 7. Then reply with the " +
  "confirmation code it returns, and nothing else.";

/** Not guessable from the question, so finding it in the answer is evidence. */
const CODE = "4091";

/**
 * - `calls-tools` — the model called it with 7 and used the answer.
 * - `cannot` — the model answered, and not like that. Held for the session:
 *   asking again will not change the model.
 * - `unanswered` — the service did not answer at all (down, timed out). Not
 *   held: the next detection pass asks again.
 */
export type ToolsProbe =
  | { readonly kind: "calls-tools" }
  | { readonly kind: "cannot"; readonly why: string }
  | { readonly kind: "unanswered"; readonly why: string };

const PROBE_TIMEOUT_MS = 60_000;
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

export async function probeTools(
  backend: Backend,
  model: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<ToolsProbe> {
  if (backend.converse === undefined) {
    return {
      kind: "cannot",
      why:
        `${backend.id} cannot carry a site's tools — llm.tools needs an ` +
        "HTTP service, such as Ollama, LM Studio or an OpenAI-compatible API",
    };
  }
  const base = {
    model,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
    signal,
    tools: [ECHO_NUMBER],
  };
  const first = await backend.converse({
    ...base,
    messages: [{ role: "user", content: ASK }],
  });
  if (!first.ok) return { kind: "unanswered", why: first.message };

  const call = first.toolCalls[0];
  if (call === undefined) {
    return {
      kind: "cannot",
      why: `${model} answered without calling echo_number, so it cannot use a site's tools`,
    };
  }
  let n: unknown;
  try {
    n = (JSON.parse(call.arguments) as { n?: unknown }).n;
  } catch {
    n = undefined;
  }
  if (call.name !== "echo_number" || n !== 7) {
    return {
      kind: "cannot",
      why: `${model} was asked to call echo_number with 7 and did not`,
    };
  }

  const second = await backend.converse({
    ...base,
    messages: [
      { role: "user", content: ASK },
      { role: "assistant", content: first.text, toolCalls: [call] },
      {
        role: "tool",
        toolCallId: call.id,
        content: `7 (confirmation code ${CODE})`,
      },
    ],
  });
  if (!second.ok) return { kind: "unanswered", why: second.message };
  if (!second.text.includes(CODE)) {
    return {
      kind: "cannot",
      why: `${model} called echo_number but did not use what it returned`,
    };
  }
  return { kind: "calls-tools" };
}

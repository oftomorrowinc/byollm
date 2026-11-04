import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiHttpBackend } from "./openai-http.js";

/**
 * C043, the response side — other kinds unchanged (#7055, Owl #55998).
 *
 * `execute` serves every kind but `llm.tools`, and before 0.1.5 it read only
 * `content` and `finish_reason`. A model server that adds a `tool_calls`
 * field it was never asked for — malformed or not — must not fail an
 * `llm.chat` job that main would have answered. Only `converse` reads calls.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

const MALFORMED = JSON.stringify({
  choices: [
    {
      message: { role: "assistant", content: "hello", tool_calls: "garbage" },
      finish_reason: "stop",
    },
  ],
});

function backendAnswering(body: string): OpenAiHttpBackend {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(body, { headers: { "content-type": "application/json" } }),
    ),
  );
  return new OpenAiHttpBackend({ baseUrl: "http://127.0.0.1:1/v1" });
}

const BOUNDS = {
  model: "m",
  timeoutMs: 5_000,
  maxOutputBytes: 1_000_000,
  signal: new AbortController().signal,
};

describe("C043 a stray tool_calls field on a non-tools kind", () => {
  it("is ignored by execute, as it was before llm.tools existed", async () => {
    const result = await backendAnswering(MALFORMED).execute({
      prompt: "hi",
      ...BOUNDS,
    });
    expect(result).toMatchObject({ ok: true, text: "hello", stop: "end" });
  });

  it("is still a malformed response to converse, which asked for calls", async () => {
    // The other half, from the same body: the distinction is the method,
    // not a parser that stopped looking.
    const result = await backendAnswering(MALFORMED).converse({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      ...BOUNDS,
    });
    expect(result.ok).toBe(false);
  });
});

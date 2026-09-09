import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiHttpBackend } from "./backends/openai-http.js";
import { stopReasonOf, type BackendResult } from "./backends/types.js";

/**
 * A result can say it stopped early — byollm_021.
 *
 * Kevin, against a local qwen: a model that hits its own `max_tokens` returns
 * an unfinished answer and byollm reported it as a finished one. He found the
 * wall at ~1,950 characters by trial and error, because trial and error was
 * the only instrument we gave anybody.
 *
 * An oversized payload fails loudly. A truncated response succeeded quietly:
 * the site received a plausible answer, an agent could act on half a thought,
 * and nothing anywhere said the model stopped early.
 *
 * ## The test this fix had to survive
 *
 * The spec names it, and it is the shape this week keeps teaching: **a test
 * that only asserts "length" is reported when a model truncates will pass
 * against an adapter that reports "length" for everything.** So the
 * completing case is in the same test, from the same adapter, on the same
 * code path — proving the two are distinguishable rather than proving a
 * constant.
 *
 * The fixtures are what ollama really answered on this machine, both
 * directions from one model: `max_tokens: 5` gave `finish_reason: "length"`
 * with empty content, and room to finish gave `"stop"` with the answer.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

function reply(finishReason: string | undefined, content: string): string {
  return JSON.stringify({
    choices: [
      {
        message: { role: "assistant", content },
        ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
      },
    ],
  });
}

async function runAgainst(body: string): Promise<BackendResult> {
  /* The global, because this backend takes no fetch seam — and the real
     `execute` path is what the spec asks these cases to exercise, not a
     parser lifted out of it. */
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(body, { headers: { "content-type": "application/json" } }),
    ),
  );
  const backend = new OpenAiHttpBackend({ baseUrl: "http://127.0.0.1:1/v1" });
  return backend.execute({
    prompt: "count to fifty",
    model: "m",
    timeoutMs: 5_000,
    maxOutputBytes: 1_000_000,
    signal: new AbortController().signal,
  });
}

describe("what an answer says about how it ended", () => {
  it("tells truncated and complete apart, from the same adapter", async () => {
    /* Both halves in one test on purpose. Two tests could each be satisfied
       by an adapter that returns a constant, and the constant is exactly the
       bug: reporting every answer as finished. */
    const truncated = await runAgainst(reply("length", "One\nTwo\nThree"));
    const complete = await runAgainst(reply("stop", "hello"));

    expect(stopReasonOf(truncated)).toBe("length");
    expect(stopReasonOf(complete)).toBe("end");
    expect(
      stopReasonOf(truncated),
      "if these are equal the adapter is reporting a constant",
    ).not.toBe(stopReasonOf(complete));
  });

  it("still returns the text it did get, because it is still an answer", async () => {
    /* A truncated answer is an answer. The site decides what to do with it —
       show it, discard it, ask again smaller — and throwing here would turn
       that judgement into ours. */
    const truncated = await runAgainst(reply("length", "One\nTwo\nThree"));
    expect(truncated.ok).toBe(true);
    if (truncated.ok) expect(truncated.text).toBe("One\nTwo\nThree");
  });

  it("says `unknown`, never `end`, when the field is absent", async () => {
    /**
     * The decision that makes this a fix rather than a field. An adapter
     * nobody has updated must not be able to claim completion by saying
     * nothing — if absence meant "end", every un-updated adapter would go on
     * telling exactly the lie this exists to fix.
     */
    const silent = await runAgainst(reply(undefined, "hello"));
    expect(stopReasonOf(silent)).toBe("unknown");
  });

  it("says `unknown` for a signal it has not mapped", async () => {
    /* `tool_calls` and `content_filter` are OpenAI's and unmapped here.
       Guessing at them would be inventing a distinction we have not checked. */
    const filtered = await runAgainst(reply("content_filter", ""));
    expect(stopReasonOf(filtered)).toBe("unknown");
  });

  it("says `unknown` for a result that carries no reason at all", () => {
    /**
     * The un-updated adapter, which is the case the default exists for — and
     * the one my first draft did not reach. Every case above goes through an
     * adapter that always sets the field, so `stopReasonOf`'s fallback never
     * ran and a mutation making it `"end"` survived all of them.
     *
     * This is the shape an adapter written before byollm_021 returns: ok,
     * text, duration, and nothing about stopping. It must not read as
     * completion.
     */
    const fromAnOlderAdapter: BackendResult = {
      ok: true,
      text: "half a thought",
      durationMs: 1,
    };
    expect(stopReasonOf(fromAnOlderAdapter)).toBe("unknown");
  });

  it("says `unknown` for a failure, which knows nothing about stopping", () => {
    const failed: BackendResult = {
      ok: false,
      code: "backend-error",
      message: "down",
      durationMs: 1,
    };
    expect(stopReasonOf(failed)).toBe("unknown");
  });

  it("maps `stop` to `end` rather than to `stop-sequence`", () => {
    /**
     * The one judgement in the mapping. OpenAI reports `stop` both for a
     * model finishing on its own and for a configured stop token being hit —
     * the field cannot tell them apart, so claiming `stop-sequence` would
     * invent a distinction the wire does not carry.
     */
    const backend = new OpenAiHttpBackend({ baseUrl: "http://127.0.0.1:1/v1" });
    const mapping = backend.stopReasons;
    expect(mapping.kind).toBe("declared");
    if (mapping.kind === "declared") {
      expect(mapping.map["stop"]).toBe("end");
      expect(mapping.map["length"]).toBe("length");
      expect(mapping.from).toContain("finish_reason");
    }
  });
});

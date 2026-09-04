import { describe, expect, it } from "vitest";
import { codexArgv, parseCodexOutput } from "./backends/codex-cli.js";

const stream = (...events: unknown[]): string =>
  events.map((event) => JSON.stringify(event)).join("\n");

describe("codex terminal outcomes", () => {
  it("asks Codex for machine-readable events", () => {
    expect(codexArgv("gpt-5")).toContain("--json");
  });

  it("returns agent messages only after turn.completed", () => {
    const outcome = parseCodexOutput(
      stream(
        { type: "thread.started", thread_id: "thread_1" },
        {
          type: "item.completed",
          item: { type: "agent_message", text: "first" },
        },
        {
          type: "item.completed",
          item: { type: "agent_message", text: "second" },
        },
        { type: "turn.completed", usage: { input_tokens: 12 } },
      ),
    );

    expect(outcome).toEqual({ ok: true, text: "first\nsecond" });
  });

  it("does not turn a zero-exit usage failure into a successful answer", () => {
    const outcome = parseCodexOutput(
      stream(
        {
          type: "error",
          message:
            "You've hit your usage limit. Try again at Sep 3rd, 2026 8:28 AM.",
        },
        {
          type: "turn.failed",
          error: { message: "You've hit your usage limit." },
        },
      ),
    );

    expect(outcome).toMatchObject({
      ok: false,
      code: "quota-exhausted",
      retryable: true,
    });
  });

  it("classifies a structured authentication failure", () => {
    expect(
      parseCodexOutput(
        stream({
          type: "turn.failed",
          error: { message: "Not logged in. Please log in to continue." },
        }),
      ),
    ).toMatchObject({ ok: false, code: "unauthorized", retryable: false });
  });

  it("keeps an ordinary provider failure generic", () => {
    expect(
      parseCodexOutput(
        stream({
          type: "turn.failed",
          error: { message: "the upstream connection closed" },
        }),
      ),
    ).toMatchObject({ ok: false, code: "backend-error", retryable: false });
  });

  it("recognizes the diagnostic somebody actually met", () => {
    /* The observed one, and the only one. This test used to run a table of
       three: "usage limit", met on a real machine, and two plausible English
       phrases nobody had seen. Ruled 2026-09-03 — the corpus admits observed
       strings only, and an empty corpus is legal, because a phrase we have
       not met changes nothing while a phrase we invented withdraws a service
       that works. The control characters are here because the diagnostic is
       sanitised before it is read. */
    expect(
      parseCodexOutput(
        stream({
          type: "error",
          message: "\u0000 You've hit your usage limit.\u007f",
        }),
      ),
    ).toMatchObject({
      ok: false,
      code: "quota-exhausted",
      retryable: true,
    });
  });

  it("ignores non-events and accepts the agent-message compatibility field", () => {
    expect(
      parseCodexOutput(
        stream(
          null,
          [],
          "notice",
          {
            type: "item.completed",
            item: { type: "agent_message", text: "" },
          },
          {
            type: "item.completed",
            item: { type: "agent_message", message: "answer" },
          },
          { type: "turn.completed" },
        ),
      ),
    ).toEqual({ ok: true, text: "answer" });
  });

  it("uses a bounded generic diagnostic when Codex omits one", () => {
    expect(parseCodexOutput(stream({ type: "error", error: [] }))).toEqual({
      ok: false,
      code: "backend-error",
      message: "the codex CLI failed: codex reported an error",
      retryable: false,
    });
  });

  it("requires a terminal event even when the process exited zero", () => {
    expect(
      parseCodexOutput(
        [
          "not json",
          JSON.stringify({ type: "thread.started", thread_id: "thread_1" }),
          JSON.stringify({ type: "item.completed", item: { type: "noise" } }),
        ].join("\n"),
      ),
    ).toEqual({
      ok: false,
      code: "backend-error",
      message: "the codex CLI ended without a terminal event",
      retryable: false,
    });
  });

  /* Observed, not imagined: codex-cli 0.149.1, asked for a model a ChatGPT
     account cannot use. Recorded verbatim because it is the only sample of
     the real failure shape we hold — the provider's HTTP error stringified
     whole into `message` — and because it must stay a plain backend error.
     It is a refusal of one model, not a statement about the subscription. */
  it("keeps an observed provider refusal out of the quota class", () => {
    const observed = JSON.stringify({
      type: "error",
      status: 400,
      error: {
        type: "invalid_request_error",
        message:
          "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
      },
    });

    expect(
      parseCodexOutput(
        stream(
          { type: "error", message: observed },
          { type: "turn.failed", error: { message: observed } },
        ),
      ),
    ).toMatchObject({ ok: false, code: "backend-error", retryable: false });
  });

  it("never classifies model prose as a provider failure", () => {
    expect(
      parseCodexOutput(
        stream(
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "A usage limit is a cap imposed by a provider.",
            },
          },
          { type: "turn.completed" },
        ),
      ),
    ).toEqual({
      ok: true,
      text: "A usage limit is a cap imposed by a provider.",
    });
  });
});

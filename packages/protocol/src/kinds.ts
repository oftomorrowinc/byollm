import { z } from "zod";

/**
 * Upper bounds on payload size, enforced at the schema so oversized input is
 * refused at parse time rather than somewhere deeper.
 *
 * byollm_004 §4 requires stricter limits for community (`named`/`public`)
 * jobs; those are applied on top of these by the daemon's budget check, which
 * knows the job's audience. These are the absolute ceilings for any job.
 */
export const PAYLOAD_LIMITS = Object.freeze({
  /** Max characters in any single text field. */
  maxTextChars: 1_000_000,
  /** Max messages in an `llm.chat` conversation. */
  maxMessages: 256,
  /** Max characters across the whole payload. */
  maxTotalChars: 4_000_000,
});

/**
 * A conversation turn. `role` is a closed enum — it is routing *within the
 * model call*, not routing of the call, so it cannot select a backend.
 */
export const ChatMessage = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().max(PAYLOAD_LIMITS.maxTextChars),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/**
 * Payload for `llm.generate`.
 *
 * @remarks
 * Text only, deliberately. byollm_004 §1 states the payload is "data handed
 * to a model, never configuration and never a command", so v0 carries no
 * sampling parameters, no model name, no base URL and no flags — those are
 * owner-side route config. A future `params` field with an explicit closed
 * allowlist and owner-set clamps is reserved; adding a field later is
 * non-breaking, removing one is not.
 */
export const GeneratePayload = z
  .object({
    prompt: z.string().min(1).max(PAYLOAD_LIMITS.maxTextChars),
    system: z.string().max(PAYLOAD_LIMITS.maxTextChars).optional(),
  })
  .strict();
export type GeneratePayload = z.infer<typeof GeneratePayload>;

/** Payload for `llm.chat`. Text only, for the same reason as {@link GeneratePayload}. */
export const ChatPayload = z
  .object({
    messages: z.array(ChatMessage).min(1).max(PAYLOAD_LIMITS.maxMessages),
    system: z.string().max(PAYLOAD_LIMITS.maxTextChars).optional(),
  })
  .strict();
export type ChatPayload = z.infer<typeof ChatPayload>;

/**
 * The job kinds a v1 daemon has handlers for.
 *
 * Kinds are resolved against handlers baked into the daemon
 * ({@link MUSTS.KIND_TYPED_ONLY}); an unknown kind is refused, never guessed.
 * Adding a kind is a protocol change with its own spec and threat review —
 * notably any kind that needs tools, which byollm_004 §2 forbids as a payload
 * flag.
 */
export const JobKind = z.enum(["llm.generate", "llm.chat"]);
export type JobKind = z.infer<typeof JobKind>;

/** All v1 job kinds. */
export const JOB_KINDS = Object.freeze(JobKind.options);

/** A payload discriminated by its kind. */
export const KindedPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("llm.generate"), payload: GeneratePayload }),
  z.object({ kind: z.literal("llm.chat"), payload: ChatPayload }),
]);
export type KindedPayload = z.infer<typeof KindedPayload>;

/** The payload type for a given kind. */
export type PayloadFor<K extends JobKind> = K extends "llm.generate"
  ? GeneratePayload
  : ChatPayload;

/** Narrow an arbitrary string to a known job kind. */
export function isJobKind(value: string): value is JobKind {
  return (JOB_KINDS as readonly string[]).includes(value);
}

/**
 * Total character weight of a payload, used by the daemon's community budget
 * check and by the server's payload-size limits.
 */
export function payloadTextLength(kinded: KindedPayload): number {
  if (kinded.kind === "llm.generate") {
    return kinded.payload.prompt.length + (kinded.payload.system?.length ?? 0);
  }
  const messages = kinded.payload.messages.reduce(
    (sum, m) => sum + m.content.length,
    0,
  );
  return messages + (kinded.payload.system?.length ?? 0);
}

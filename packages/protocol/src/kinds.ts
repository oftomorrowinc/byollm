import { z } from "zod";
import { BlobRef, MAX_IMAGES_IN, MAX_IMAGES_OUT } from "./media.js";
import { TOOL_LIMITS, ToolDeclaration, ToolLimits } from "./tools.js";

/**
 * Upper bounds on payload size, enforced at the schema so oversized input is
 * refused at parse time rather than somewhere deeper.
 *
 * All three are enforced — cloud_008 Tier 4, finding 30. `maxTotalChars` was
 * declared here and referenced nowhere, under this docstring's claim that the
 * schema enforces them, so a chat payload of 256 messages at a million
 * characters each parsed cleanly at sixty-four times the stated ceiling. The
 * per-field limits were real and the aggregate one was a number in a frozen
 * object.
 *
 * byollm_004 §4 requires stricter limits for community (`team`) jobs; those
 * are applied on top of these by the daemon's budget check, which knows the
 * job's audience. These are the absolute ceilings for any job.
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
export const ChatMessage = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().max(PAYLOAD_LIMITS.maxTextChars),
  })
  /**
   * Strict, like everything else on the wire — byollm-review 2026-08-27.
   *
   * This is the shape the law was written about. A site SDK user sends
   * `{role, content, tool_calls: [...]}` expecting tool use; zod's default
   * strips the unknown key, the job runs meaning something other than what
   * was sent, and nothing anywhere says so. "Unknown fields throw" exists
   * precisely so a version skew is an error rather than a silent difference
   * in what the model was asked.
   */
  .strict();
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
  .strict()
  .refine(
    (payload) =>
      payload.prompt.length + (payload.system?.length ?? 0) <=
      PAYLOAD_LIMITS.maxTotalChars,
    {
      message: `payload exceeds ${String(PAYLOAD_LIMITS.maxTotalChars)} characters`,
    },
  );
export type GeneratePayload = z.infer<typeof GeneratePayload>;

/** The aggregate for every payload with `messages`: the same ceiling as chat. */
const messagesWithinTotal = (payload: {
  messages: readonly { content: string }[];
  system?: string | undefined;
}): boolean =>
  payload.messages.reduce((sum, m) => sum + m.content.length, 0) +
    (payload.system?.length ?? 0) <=
  PAYLOAD_LIMITS.maxTotalChars;

/** Payload for `llm.chat`. Text only, for the same reason as {@link GeneratePayload}. */
export const ChatPayload = z
  .object({
    messages: z.array(ChatMessage).min(1).max(PAYLOAD_LIMITS.maxMessages),
    system: z.string().max(PAYLOAD_LIMITS.maxTextChars).optional(),
  })
  .strict()
  // The aggregate, which is the one that matters here: the per-message and
  // per-count limits multiply, and their product is far above the ceiling
  // this object states.
  .refine((payload) => messagesWithinTotal(payload), {
    message: `payload exceeds ${String(PAYLOAD_LIMITS.maxTotalChars)} characters`,
  });
export type ChatPayload = z.infer<typeof ChatPayload>;

/**
 * Payload for `llm.tools` — byollm_012 §3.
 *
 * `llm.chat`'s, with the same {@link PAYLOAD_LIMITS}, plus the site's tool
 * declarations and the purpose's limits they were built against.
 *
 * - `tools` — exactly the purpose's tools, 1 to 16, each name once. Whether
 *   they ARE the purpose's tools is not a parse question: the device compares
 *   their digest with the grant's at admission (`toolsConsentRefusal`), so a
 *   mismatch is `tools-not-consented` rather than a malformed payload.
 * - `maxToolCalls` — the payload may ask for fewer calls than the purpose
 *   allows, never more. "More" is refused at admission for the same reason.
 * - `purposeLimits` — the purpose's two limits as registered, inside the
 *   digest (§4).
 *
 * **What the site still cannot do** is hand the model a forged tool turn.
 * {@link ChatMessage} has no `tool` role and is strict, so a payload carrying
 * `tool_calls` or a tool turn is refused here. Tool turns exist only inside
 * the daemon's loop, and every one of them arrived as a sealed, signed
 * envelope for a call the daemon itself sent.
 */
export const ToolsPayload = z
  .object({
    messages: z.array(ChatMessage).min(1).max(PAYLOAD_LIMITS.maxMessages),
    system: z.string().max(PAYLOAD_LIMITS.maxTextChars).optional(),
    tools: z
      .array(ToolDeclaration)
      .min(1)
      .max(TOOL_LIMITS.maxTools)
      .refine(
        (tools) => new Set(tools.map((t) => t.name)).size === tools.length,
        { message: "a payload declares each tool once" },
      ),
    maxToolCalls: z
      .number()
      .int()
      .min(1)
      .max(TOOL_LIMITS.maxToolCalls)
      .optional(),
    purposeLimits: ToolLimits,
  })
  .strict()
  .refine(messagesWithinTotal, {
    message: `payload exceeds ${String(PAYLOAD_LIMITS.maxTotalChars)} characters`,
  });
export type ToolsPayload = z.infer<typeof ToolsPayload>;

/** A text part of an `llm.vision` user turn — byollm_021 §1. */
const TextPart = z
  .object({
    type: z.literal("text"),
    text: z.string().max(PAYLOAD_LIMITS.maxTextChars),
  })
  .strict();

/** An image part of an `llm.vision` user turn: a reference, never bytes (§1, §2). */
const ImagePart = z
  .object({ type: z.literal("image"), image: BlobRef })
  .strict();

export const VisionPart = z.discriminatedUnion("type", [TextPart, ImagePart]);
export type VisionPart = z.infer<typeof VisionPart>;

/**
 * A turn of an `llm.vision` conversation — byollm_021 §1.
 *
 * {@link ChatMessage}'s, except that a `user` turn's `content` may be a list
 * of parts. Only a `user` turn: a site-authored `assistant` or `system` turn
 * carrying an image would be the site putting words and pictures in the
 * model's mouth, and §1 allows images only in `user` turns.
 */
export const VisionMessage = z.union([
  ChatMessage,
  z
    .object({
      role: z.literal("user"),
      content: z.array(VisionPart).min(1).max(PAYLOAD_LIMITS.maxMessages),
    })
    .strict(),
]);
export type VisionMessage = z.infer<typeof VisionMessage>;

/** Characters of text in a vision turn, whichever form its content takes. */
const visionTextChars = (message: VisionMessage): number =>
  typeof message.content === "string"
    ? message.content.length
    : message.content.reduce(
        (sum, part) => sum + (part.type === "text" ? part.text.length : 0),
        0,
      );

/** Image references in a vision payload, in order. */
export function visionImages(payload: {
  readonly messages: readonly VisionMessage[];
}): BlobRef[] {
  return payload.messages.flatMap((message) =>
    typeof message.content === "string"
      ? []
      : message.content.flatMap((part) =>
          part.type === "image" ? [part.image] : [],
        ),
  );
}

/**
 * Payload for `llm.vision` — byollm_021 §1: chat with image parts.
 *
 * 1 to {@link MAX_IMAGES_IN} images a job. A vision payload with no image is
 * a chat job, and belongs on the kind every daemon already serves. The text
 * is held to chat's aggregate; image bytes are bounded by the media caps, not
 * by {@link PAYLOAD_LIMITS} (§3).
 */
export const VisionPayload = z
  .object({
    messages: z.array(VisionMessage).min(1).max(PAYLOAD_LIMITS.maxMessages),
    system: z.string().max(PAYLOAD_LIMITS.maxTextChars).optional(),
  })
  .strict()
  .refine(
    (payload) => {
      const images = visionImages(payload).length;
      return images >= 1 && images <= MAX_IMAGES_IN;
    },
    {
      message: `an llm.vision job carries 1 to ${String(MAX_IMAGES_IN)} images`,
    },
  )
  .refine(
    (payload) =>
      payload.messages.reduce((sum, m) => sum + visionTextChars(m), 0) +
        (payload.system?.length ?? 0) <=
      PAYLOAD_LIMITS.maxTotalChars,
    {
      message: `payload exceeds ${String(PAYLOAD_LIMITS.maxTotalChars)} characters`,
    },
  );
export type VisionPayload = z.infer<typeof VisionPayload>;

/**
 * The shape an `llm.image` job asks for — byollm_021 §1.
 *
 * A closed enum, like {@link ChatMessage.role}: it works inside the model
 * call and never routes it. The owner's service entry maps each value to
 * that backend's pixel size, so a job never names a size.
 */
export const ImageAspect = z.enum(["square", "portrait", "landscape"]);
export type ImageAspect = z.infer<typeof ImageAspect>;

/**
 * Payload for `llm.image` — byollm_021 §1.
 *
 * `aspect` and `count` are argued for in §1, since byollm_004 §1 keeps
 * parameters off payloads: they are closed, they never name a size, a model
 * or a step count, and `count` is clamped by the owner's `maxImagesPerJob`.
 */
export const ImagePayload = z
  .object({
    prompt: z.string().min(1).max(PAYLOAD_LIMITS.maxTextChars),
    aspect: ImageAspect.optional(),
    count: z.number().int().min(1).max(MAX_IMAGES_OUT).optional(),
  })
  .strict();
export type ImagePayload = z.infer<typeof ImagePayload>;

/**
 * The job kinds a v1 daemon has handlers for.
 *
 * Kinds are resolved against handlers baked into the daemon
 * ({@link MUSTS.KIND_TYPED_ONLY}); an unknown kind is refused, never guessed.
 * Adding a kind is a protocol change with its own spec and threat review.
 *
 * `llm.tools` is byollm_012's, and `llm.vision` and `llm.image` are
 * byollm_021's — the kind owns the payload shape, so a daemon that cannot
 * serve one never advertises it and is never offered it
 * ({@link MUSTS.CLAIM_REQUIRES_CAPABILITY}). That is what keeps them from a
 * 0.1.4 daemon: it parses a `llm.chat` payload strictly, and would refuse an
 * image part after claiming the job.
 *
 * **No English here.** The user-facing labels ("Using the site's tools",
 * "Reading images", "Making images") live in the one kind-label table, which
 * byollm_016 ("Kind labels' home", 2026-08-26) put in the web lib: protocol
 * carries ids, surfaces carry words, and that table is an exhaustive record
 * over this enum so a new kind breaks the web build until it is worded.
 */
export const JobKind = z.enum([
  "llm.generate",
  "llm.chat",
  "llm.tools",
  "llm.vision",
  "llm.image",
]);
export type JobKind = z.infer<typeof JobKind>;

/** All v1 job kinds. */
export const JOB_KINDS = Object.freeze(JobKind.options);

/** A payload discriminated by its kind. */
export const KindedPayload = z.discriminatedUnion("kind", [
  // Strict on the wrappers too. A union member that strips is a door beside
  // the one that is locked: the payloads inside are strict, and an extra key
  // on the envelope vanished just as quietly.
  z
    .object({ kind: z.literal("llm.generate"), payload: GeneratePayload })
    .strict(),
  z.object({ kind: z.literal("llm.chat"), payload: ChatPayload }).strict(),
  z.object({ kind: z.literal("llm.tools"), payload: ToolsPayload }).strict(),
  z.object({ kind: z.literal("llm.vision"), payload: VisionPayload }).strict(),
  z.object({ kind: z.literal("llm.image"), payload: ImagePayload }).strict(),
]);
export type KindedPayload = z.infer<typeof KindedPayload>;

/** The payload type for a given kind. */
export type PayloadFor<K extends JobKind> = Extract<
  KindedPayload,
  { kind: K }
>["payload"];

/** Narrow an arbitrary string to a known job kind. */
export function isJobKind(value: string): value is JobKind {
  return (JOB_KINDS as readonly string[]).includes(value);
}

/**
 * Total character weight of a payload, used by the daemon's community budget
 * check and by the server's payload-size limits.
 *
 * Characters of text, for every kind (byollm_021 §3): image bytes are bounded
 * by the media caps and never squeezed into this number.
 *
 * **`llm.tools` counts what the model may read, not only what was sent**
 * (byollm_012 §8, the context cap). Tool results arrive after admission, so
 * the job's size is its own characters plus `purposeLimits.maxToolResultChars`
 * — the most result text it may read. The site classes the job from this, and
 * a teammate's device whose `community.maxPayloadChars` is below it refuses
 * the job before it runs, which is the only moment the owner's limit can see
 * text that has not arrived yet.
 */
export function payloadTextLength(kinded: KindedPayload): number {
  switch (kinded.kind) {
    case "llm.generate":
      return (
        kinded.payload.prompt.length + (kinded.payload.system?.length ?? 0)
      );
    case "llm.chat":
      return chatTextLength(kinded.payload);
    case "llm.tools":
      return (
        chatTextLength(kinded.payload) +
        kinded.payload.purposeLimits.maxToolResultChars
      );
    case "llm.vision":
      return (
        kinded.payload.messages.reduce(
          (sum, m) => sum + visionTextChars(m),
          0,
        ) + (kinded.payload.system?.length ?? 0)
      );
    case "llm.image":
      return kinded.payload.prompt.length;
  }
}

function chatTextLength(payload: {
  messages: readonly ChatMessage[];
  system?: string | undefined;
}): number {
  const messages = payload.messages.reduce(
    (sum, m) => sum + m.content.length,
    0,
  );
  return messages + (payload.system?.length ?? 0);
}

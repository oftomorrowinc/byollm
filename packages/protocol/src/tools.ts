import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./jcs.js";
import { renderable } from "./renderable.js";

/**
 * Site-executed tools — byollm_012 v1, ruled on #6933 (2026-11-03).
 *
 * A site declares its tools in its manifest, against a purpose. The model on
 * the person's device may call them. **The device never runs a tool**
 * ({@link MUSTS.TOOLS_RUN_AT_SITE}): each call is sealed to the site, the site
 * runs it on its own infrastructure, and seals the result back. Everything in
 * this file is the shape of that exchange; nothing in it executes anything.
 *
 * The kind is `llm.tools` (`kinds.ts`). The manifest fields are on `Purpose`
 * (`manifest.ts`). The grant's digest is on `SignedGrant` (`grant.ts`). The
 * two envelope directions are on `EnvelopeDirection` (`envelope.ts`).
 */

/**
 * The numbers byollm_012 §3, §4, §5 and §8 fix, in one place.
 *
 * Protocol ceilings, not defaults: a purpose, a payload and a device owner
 * may each set a lower number, and none of them may set a higher one.
 */
export const TOOL_LIMITS = Object.freeze({
  /** Tools one purpose, and so one payload, may declare (§3, §4). */
  maxTools: 16,
  /** Tool calls in one job: the protocol ceiling (§8). */
  maxToolCalls: 20,
  /** A purpose's call budget when its manifest says nothing (§4). */
  defaultMaxToolCalls: 8,
  /** Tool-result text one job may read, summed — the context cap (§8). */
  maxToolResultChars: 256_000,
  /** The context cap when a purpose's manifest says nothing (§4, §8). */
  defaultMaxToolResultChars: 32_000,
  /** One declaration, serialised (§3). */
  maxDeclarationBytes: 8 * 1024,
  /** Properties in one declaration's `parameters` (§3). */
  maxParameters: 16,
  /** A string parameter's `maxLength` ceiling (§3). */
  maxStringLength: 4096,
  /** An array parameter's `maxItems` ceiling (§3). */
  maxArrayItems: 32,
  /** One call's `arguments`, serialised, measured on the plaintext (§5.1). */
  maxArgumentBytes: 64 * 1024,
  /** One result's `content`, measured on the plaintext (§5.1). */
  maxContentBytes: 256 * 1024,
  /** One result's `error`, measured on the plaintext (§5.1). */
  maxErrorBytes: 1024,
  /** How long the daemon waits on one call before the model hears an error (§5.3). */
  callTimeoutMs: 60_000,
});

/** UTF-8 bytes of a string — what §5.1's "measured on the plaintext" means. */
const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).length;

/** A tool's name: a slug a function-calling API accepts everywhere (§3). */
export const ToolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, {
  message:
    "a tool name is a lowercase identifier — a letter, then letters, digits " +
    "or underscores, at most 64",
});
export type ToolName = z.infer<typeof ToolName>;

/**
 * A parameter's name. §3 does not fix one, so this is the narrowest rule
 * every function-calling wire format the daemon speaks accepts: an
 * identifier, at most 64.
 */
const ParameterName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, {
  message: "a parameter name is an identifier of at most 64 characters",
});

/** What the model reads about a parameter. Rendered nowhere a person decides. */
const parameterDescription = z.string().min(1).max(1024).optional();

const StringParameter = z
  .object({
    type: z.literal("string"),
    description: parameterDescription,
    /**
     * Required, so the daemon can bound every string it validates without
     * inventing a default (§3: "with `maxLength` ≤ 4096").
     */
    maxLength: z.number().int().min(1).max(TOOL_LIMITS.maxStringLength),
    enum: z
      .array(z.string().max(TOOL_LIMITS.maxStringLength))
      .min(1)
      .max(64)
      .optional(),
  })
  .strict();

const NumericParameter = (type: "integer" | "number") =>
  z
    .object({
      type: z.literal(type),
      description: parameterDescription,
      minimum: z.number().optional(),
      maximum: z.number().optional(),
    })
    .strict();

const BooleanParameter = z
  .object({ type: z.literal("boolean"), description: parameterDescription })
  .strict();

/** The four scalar shapes §3 allows, which is also what an array may hold. */
const ScalarParameter = z.discriminatedUnion("type", [
  StringParameter,
  NumericParameter("integer"),
  NumericParameter("number"),
  BooleanParameter,
]);

const ArrayParameter = z
  .object({
    type: z.literal("array"),
    description: parameterDescription,
    /** An array of one scalar shape — no nesting beyond that (§3). */
    items: ScalarParameter,
    maxItems: z.number().int().min(1).max(TOOL_LIMITS.maxArrayItems),
  })
  .strict();

const ToolParameter = z.union([ScalarParameter, ArrayParameter]);

/**
 * A tool's arguments, as the JSON Schema subset §3 allows.
 *
 * Strict at every level, so `$ref`, `oneOf`, a nested object and
 * `additionalProperties: true` do not parse. The subset is small on purpose:
 * the daemon validates every call against it completely, so it is a schema
 * the daemon can check rather than one it has to trust.
 */
export const ToolParameters = z
  .object({
    type: z.literal("object"),
    properties: z
      .record(ParameterName, ToolParameter)
      .refine(
        (properties) =>
          Object.keys(properties).length <= TOOL_LIMITS.maxParameters,
        {
          message: `a tool takes at most ${String(TOOL_LIMITS.maxParameters)} parameters`,
        },
      ),
    required: z.array(ParameterName).max(TOOL_LIMITS.maxParameters).optional(),
    /** Only ever `false`, which is also what absence means (§3). */
    additionalProperties: z.literal(false).optional(),
  })
  .strict()
  .refine(
    (schema) =>
      (schema.required ?? []).every((name) => name in schema.properties),
    { message: "a required parameter must be one of the properties" },
  )
  .refine(
    (schema) =>
      new Set(schema.required ?? []).size === (schema.required ?? []).length,
    { message: "a required parameter is listed once" },
  );
export type ToolParameters = z.infer<typeof ToolParameters>;

/**
 * What a tool is, as the manifest records it and the consent screen shows it.
 *
 * The description follows the manifest's renderable rules, because a person
 * reads it to decide (§4, §10). 1 to 1,024 characters (§3).
 */
export const ToolSpec = z
  .object({
    description: renderable(1024, "tool description"),
    parameters: ToolParameters,
  })
  .strict();
export type ToolSpec = z.infer<typeof ToolSpec>;

/** One tool, as an `llm.tools` payload carries it: the spec with its name. */
export const ToolDeclaration = z
  .object({
    name: ToolName,
    description: ToolSpec.shape.description,
    parameters: ToolParameters,
  })
  .strict()
  .refine(
    (declaration) =>
      utf8Bytes(JSON.stringify(declaration)) <= TOOL_LIMITS.maxDeclarationBytes,
    {
      message: `one tool declaration serialises to at most ${String(TOOL_LIMITS.maxDeclarationBytes)} bytes`,
    },
  );
export type ToolDeclaration = z.infer<typeof ToolDeclaration>;

/**
 * The purpose's two limits, as registered, carried in an `llm.tools`
 * payload beside its declarations (§3, §4).
 *
 * Both required here, though the manifest may leave them unset: the payload
 * carries the numbers the person was shown, with the defaults applied, so
 * that the digest the device recomputes from it is over the same values the
 * control plane signed.
 */
export const ToolLimits = z
  .object({
    maxToolCalls: z.number().int().min(1).max(TOOL_LIMITS.maxToolCalls),
    maxToolResultChars: z
      .number()
      .int()
      .min(1)
      .max(TOOL_LIMITS.maxToolResultChars),
  })
  .strict();
export type ToolLimits = z.infer<typeof ToolLimits>;

/**
 * What a person consents to for one (purpose, `llm.tools`) slot, and what
 * {@link toolsDigest} is computed over (§4).
 *
 * `tools` is a record keyed by name, so the order a site happened to list its
 * declarations in cannot change the digest.
 */
export interface ToolsConsent {
  readonly tools: Readonly<Record<string, ToolSpec>>;
  readonly maxToolCalls: number;
  readonly maxToolResultChars: number;
}

/** The shape a `toolsDigest` has on the wire: SHA-256, lowercase hex. */
export const ToolsDigest = z.string().regex(/^[0-9a-f]{64}$/, {
  message: "a toolsDigest is a SHA-256, as 64 lowercase hex digits",
});

/**
 * SHA-256 over the RFC 8785 canonical form of `{ tools, maxToolCalls,
 * maxToolResultChars }` — byollm_012 §4.
 *
 * The limits are inside the digest so that the numbers a person was shown
 * bind (Owl, #54911 part 2 point 2): without them a site could send
 * `maxToolCalls: 20` to somebody who was shown 8.
 *
 * One function for every party that computes it — the control plane signing
 * a grant, the hub comparing an enqueue with the manifest of record, the site
 * SDK before it enqueues, and the device at admission — because three
 * implementations that differ by one byte refuse every job after it is
 * claimed, and the site sees only no-runner (Owl, #54911 part 2 point 3).
 */
export function toolsDigest(consent: ToolsConsent): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        tools: consent.tools,
        maxToolCalls: consent.maxToolCalls,
        maxToolResultChars: consent.maxToolResultChars,
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * The consent an `llm.tools` payload claims, rebuilt from it the way §4
 * says the device does: the declarations as a record keyed by name, beside
 * the purpose's limits the payload says it was built against.
 */
export function consentOfPayload(payload: {
  readonly tools: readonly ToolDeclaration[];
  readonly purposeLimits: ToolLimits;
}): ToolsConsent {
  const tools: Record<string, ToolSpec> = {};
  for (const { name, description, parameters } of payload.tools) {
    tools[name] = { description, parameters };
  }
  return { tools, ...payload.purposeLimits };
}

/**
 * Why an `llm.tools` job is refused over its tools — byollm_012 §4.
 *
 * - `tools-not-consented` — the device's refusal at admission: the payload's
 *   declarations or limits do not match the grant's `toolsDigest`, or its
 *   `maxToolCalls` is above the purpose's. The payload never reaches a
 *   backend.
 * - `tools-manifest-mismatch` — the hub's refusal at enqueue: the digest the
 *   site SDK computed over what it is about to send does not match the
 *   manifest of record. Nothing is queued.
 *
 * A vocabulary of its own rather than new {@link RefusalReason} or
 * `WireErrorCode` values. Both of those are parsed strictly by every 0.1.4
 * party, and a new value in a closed enum is breaking on the side nobody
 * upgraded. These two reach only a party that already speaks `llm.tools`:
 * the device's refusal is its own log line and a `refused` release, and the
 * hub's is a `bad-request` whose message carries the sentence below.
 */
export const ToolsRefusal = z.enum([
  "tools-not-consented",
  "tools-manifest-mismatch",
]);
export type ToolsRefusal = z.infer<typeof ToolsRefusal>;

/** The words for each, so the device, the hub and the SDK say one thing. */
export function toolsRefusalText(
  refusal: ToolsRefusal,
  at: { readonly site: string; readonly purpose: string },
): string {
  switch (refusal) {
    case "tools-not-consented":
      return (
        `the tools this ${at.site} job declares for ${at.purpose} are not ` +
        "the ones the person consented to"
      );
    case "tools-manifest-mismatch":
      // byollm_012 §4, word for word.
      return (
        `the tools ${at.site} declares in code for ${at.purpose} differ from ` +
        "its registered manifest — register the manifest, or fix the " +
        "declaration"
      );
  }
}

/**
 * The device's admission check for an `llm.tools` payload — byollm_012 §4.
 *
 * Run after the grant's own checks and before the backend sees anything.
 * `toolsDigest` is the grant's; on the direct lane there is no grant and so
 * no digest, and only the budget comparison applies (§4, "The direct lane").
 */
export function toolsConsentRefusal(input: {
  readonly payload: {
    readonly tools: readonly ToolDeclaration[];
    readonly maxToolCalls?: number | undefined;
    readonly purposeLimits: ToolLimits;
  };
  readonly toolsDigest?: string | undefined;
}): "tools-not-consented" | null {
  const { payload } = input;
  if (
    payload.maxToolCalls !== undefined &&
    payload.maxToolCalls > payload.purposeLimits.maxToolCalls
  ) {
    return "tools-not-consented";
  }
  if (
    input.toolsDigest !== undefined &&
    toolsDigest(consentOfPayload(payload)) !== input.toolsDigest
  ) {
    return "tools-not-consented";
  }
  return null;
}

/**
 * The daemon's id for one call: random, single-use, recorded with the job
 * (§5.1). Bounded so a relay can store it without trusting its length.
 *
 * Exported because it travels in the clear too: the four tool endpoints name
 * a call beside its envelope, so an upstream that cannot open the envelope
 * can still bind a result to the call it answers (byollm_012 §5.2).
 */
export const ToolCallId = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, {
  message: "a callId is 16 to 128 base64url characters",
});

/** Which call in the job, from 1, and never past the protocol ceiling. */
const CallSeq = z.number().int().min(1).max(TOOL_LIMITS.maxToolCalls);

/**
 * A tool call, sealed device → site in a `tool-call` envelope (§5.1).
 *
 * `arguments` is an object; whether it fits the tool's declaration is the
 * daemon's check before it seals (C036) and the site SDK's after it opens.
 */
export const ToolCall = z
  .object({
    callId: ToolCallId,
    seq: CallSeq,
    name: ToolName,
    arguments: z
      .record(z.string(), z.unknown())
      .refine(
        (args) =>
          utf8Bytes(JSON.stringify(args)) <= TOOL_LIMITS.maxArgumentBytes,
        {
          message: `a call's arguments serialise to at most ${String(TOOL_LIMITS.maxArgumentBytes)} bytes`,
        },
      ),
  })
  .strict();
export type ToolCall = z.infer<typeof ToolCall>;

/**
 * Whether a call's arguments fit its tool's declaration — byollm_012 §3,
 * C036. `null` when they do; otherwise the reason, in words the model reads.
 *
 * Complete, not sampled: §3 keeps the schema subset small precisely so that
 * this can check every rule it states — no unknown key (a declaration never
 * allows `additionalProperties`), every required key present, every value of
 * its declared type, a string within its `maxLength` and its `enum`, a number
 * within its bounds, an array within `maxItems` with every item of its type.
 *
 * One function for both ends: the daemon runs it before it seals a call, and
 * the site SDK after it opens one, so the two cannot disagree about which
 * calls a declaration admits.
 */
export function toolArgumentsRefusal(
  parameters: ToolParameters,
  args: Readonly<Record<string, unknown>>,
): string | null {
  for (const name of Object.keys(args)) {
    if (!Object.hasOwn(parameters.properties, name)) {
      return `"${name}" is not a parameter of this tool`;
    }
  }
  for (const name of parameters.required ?? []) {
    if (!Object.hasOwn(args, name)) return `"${name}" is required`;
  }
  for (const [name, value] of Object.entries(args)) {
    const parameter = parameters.properties[name];
    if (parameter === undefined) continue;
    const refusal =
      parameter.type === "array"
        ? arrayRefusal(parameter, value)
        : scalarRefusal(parameter, value);
    if (refusal !== null) return `"${name}" ${refusal}`;
  }
  return null;
}

type ScalarSpec = Exclude<
  ToolParameters["properties"][string],
  { type: "array" }
>;

function scalarRefusal(parameter: ScalarSpec, value: unknown): string | null {
  switch (parameter.type) {
    case "string": {
      if (typeof value !== "string") return "must be a string";
      if (value.length > parameter.maxLength) {
        return `must be at most ${String(parameter.maxLength)} characters`;
      }
      if (parameter.enum !== undefined && !parameter.enum.includes(value)) {
        return `must be one of ${parameter.enum.map((v) => JSON.stringify(v)).join(", ")}`;
      }
      return null;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `must be a ${parameter.type}`;
      }
      if (parameter.type === "integer" && !Number.isInteger(value)) {
        return "must be an integer";
      }
      if (parameter.minimum !== undefined && value < parameter.minimum) {
        return `must be at least ${String(parameter.minimum)}`;
      }
      if (parameter.maximum !== undefined && value > parameter.maximum) {
        return `must be at most ${String(parameter.maximum)}`;
      }
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
  }
}

function arrayRefusal(
  parameter: Extract<ToolParameters["properties"][string], { type: "array" }>,
  value: unknown,
): string | null {
  if (!Array.isArray(value)) return "must be an array";
  if (value.length > parameter.maxItems) {
    return `must have at most ${String(parameter.maxItems)} items`;
  }
  for (const [index, item] of value.entries()) {
    const refusal = scalarRefusal(parameter.items, item);
    if (refusal !== null) return `item ${String(index)} ${refusal}`;
  }
  return null;
}

/**
 * A tool's answer, sealed site → device in a `tool-result` envelope (§5.1).
 *
 * Accepted only if it names an outstanding `callId` of the same job with its
 * `seq` ({@link MUSTS.TOOL_ENVELOPES_BOUND}) — that is state this schema does
 * not have, and the daemon's to check.
 */
export const ToolResult = z.discriminatedUnion("ok", [
  z
    .object({
      callId: ToolCallId,
      seq: CallSeq,
      ok: z.literal(true),
      content: z
        .string()
        .refine((text) => utf8Bytes(text) <= TOOL_LIMITS.maxContentBytes, {
          message: `a tool result's content is at most ${String(TOOL_LIMITS.maxContentBytes)} bytes`,
        }),
    })
    .strict(),
  z
    .object({
      callId: ToolCallId,
      seq: CallSeq,
      ok: z.literal(false),
      error: z
        .string()
        .min(1)
        .refine((text) => utf8Bytes(text) <= TOOL_LIMITS.maxErrorBytes, {
          message: `a tool error is at most ${String(TOOL_LIMITS.maxErrorBytes)} bytes`,
        }),
    })
    .strict(),
]);
export type ToolResult = z.infer<typeof ToolResult>;

/**
 * How a job's tool calls ended — `RunMetadata.toolOutcomes`, byollm_012 §3.
 *
 * Answered by the site, answered with the site's error, timed out waiting
 * (§5.3), or refused by the daemon before sending or before the model saw
 * the result (§8). A site can then tell "answered from search" from "every
 * call timed out", which `toolCalls` alone cannot (Owl, #54911 part 2
 * point 4).
 */
export const ToolOutcomes = z
  .object({
    answered: z.number().int().nonnegative(),
    errored: z.number().int().nonnegative(),
    timedOut: z.number().int().nonnegative(),
    refused: z.number().int().nonnegative(),
  })
  .strict();
export type ToolOutcomes = z.infer<typeof ToolOutcomes>;

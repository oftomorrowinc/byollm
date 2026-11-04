import { z } from "zod";
import { SealedEnvelope } from "./envelope.js";
import { ToolCallId } from "./tools.js";
import { PROTOCOL_VERSION } from "./wire.js";

/**
 * The daemon plane's two tool endpoints — byollm_012 §5.2.
 *
 * | endpoint       | who calls it                          | what it carries |
 * |----------------|---------------------------------------|-----------------|
 * | `tool-call`    | the daemon holding the job's lease    | one sealed `tool-call` envelope, with `jobId`, `leaseId`, `callId` |
 * | `tool-results` | the daemon, while any job of its waits | the sealed `tool-result` envelopes for its held jobs |
 *
 * **The shapes are card 2's (#7054)**, which serves these endpoints and
 * defines them in `wire.ts`, inside {@link ENDPOINTS}. They are restated here,
 * field for field, only because this card's daemon needs them before that
 * card lands, and a name in `ENDPOINTS` is one every server and relay switch
 * must serve. Whichever of the two lands second deletes this file for
 * `wire.ts`'s definitions; `tool-arguments.test.ts` pins the field lists so
 * the two cannot drift before then.
 *
 * Both are signed like every daemon request, with the endpoint's name as the
 * `endpoint` the signature covers.
 */
export const TOOL_ENDPOINTS = Object.freeze([
  "tool-call",
  "tool-results",
] as const);
export type ToolEndpoint = (typeof TOOL_ENDPOINTS)[number];

/**
 * One call, named in the clear: its job, the grant it was made under, and its
 * id. A call outlives nothing — when the lease ends, so does every call made
 * under it.
 */
export const ToolCallRef = z
  .object({
    jobId: z.string().min(1),
    leaseId: z.string().min(1),
    callId: ToolCallId,
  })
  .strict();
export type ToolCallRef = z.infer<typeof ToolCallRef>;

/** `POST /byollm/tool-call` — one sealed call, from the lease's holder. */
export const ToolCallRequest = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    runnerId: z.string().min(1),
    jobId: z.string().min(1),
    leaseId: z.string().min(1),
    /**
     * In the clear as well as inside the envelope, so an upstream that cannot
     * open it can bind the site's answer to this call and count it (§8's
     * relay counter) without opening anything (`RELAY_BLIND`). The daemon
     * accepts a result only if the id inside the sealed result matches too.
     */
    callId: ToolCallId,
    /** A `tool-call` envelope, signed by the device, sealed to the site. */
    envelope: SealedEnvelope,
  })
  .strict();
export type ToolCallRequest = z.infer<typeof ToolCallRequest>;

export const ToolCallResponse = z
  .object({
    callId: ToolCallId,
    /**
     * When the upstream stops holding this call open, on its clock. The
     * daemon keeps its own timer (`TOOL_LIMITS.callTimeoutMs`); this says
     * when the two agree.
     */
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type ToolCallResponse = z.infer<typeof ToolCallResponse>;

/**
 * `POST /byollm/tool-results` — the answers to the calls this daemon is
 * waiting on, named one by one, so the read stays lease-scoped like every
 * other holder call. An answered result is returned on every poll that names
 * it until the job ends; the daemon names only the call it is waiting on.
 */
export const ToolResultsRequest = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    runnerId: z.string().min(1),
    calls: z.array(ToolCallRef).min(1).max(64),
  })
  .strict();
export type ToolResultsRequest = z.infer<typeof ToolResultsRequest>;

/**
 * The named calls the site has answered, each with its sealed `tool-result`
 * envelope. The labels are the upstream's claim and nothing more: the daemon
 * accepts a result only if the envelope opens for that job, verifies against
 * the site's pinned key, carries the `tool-result` direction, and names the
 * outstanding call with its `seq` (`TOOL_ENVELOPES_BOUND`).
 */
export const ToolResultsResponse = z
  .object({
    results: z.array(ToolCallRef.extend({ envelope: SealedEnvelope }).strict()),
  })
  .strict();
export type ToolResultsResponse = z.infer<typeof ToolResultsResponse>;

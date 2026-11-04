import {
  ENVELOPE_MAX_AGE_MS,
  TERMINAL_STATES,
  TOOL_LIMITS,
  ToolCall,
  ToolName,
  ToolResult,
  ToolsPayload,
  keyId,
  open,
  publicIdentityOf,
  seal,
  toolArgumentsRefusal,
  type SealedEnvelope,
  type SiteToolCalls,
  type StoredKeys,
} from "@byollm/protocol";
import type { JobRecord } from "./records.js";
import type { ByollmStore } from "./store.js";

/**
 * The site's side of a tool job — byollm_012 §5, §6 and §8 (#6933, card 4).
 *
 * A site registers a handler per tool name. Its pump collects the calls
 * waiting on it, runs a handler for each, and seals each answer back to the
 * device that asked. The same code serves both lanes: on the cloud lane the
 * calls come from the relay's `calls` and go back through its
 * `tool-result`; on the direct lane they are `ByollmApp.calls` and
 * `ByollmApp.toolResult`, in-process, because the site is the upstream.
 *
 * ## What a handler is never run for
 *
 * A handler runs only for a call that, in this order:
 *
 * 1. opens with this site's key, verifies against the device the upstream
 *    named, and carries the `tool-call` direction for the job it is listed
 *    under — so a call can be neither forged by a relay nor replayed from
 *    another job;
 * 2. names, in its sealed body, the call id it is listed under;
 * 3. belongs to an open `llm.tools` job of this site, under the lease the
 *    site recorded for it;
 * 4. fits the job's budget, charged in the store before anything runs (the
 *    site SDK's counter, §8, C040);
 * 5. names a tool **the job's own payload declares** — read from the
 *    site's sealed-at-rest copy, which neither a relay nor a device can
 *    write. A handler registered for one purpose's tool is never run for a
 *    job whose purpose did not declare it, whatever the call says;
 * 6. passes that declaration's schema (`toolArgumentsRefusal`, the same
 *    function the daemon runs before it seals).
 *
 * A call failing 1–3 is dropped: nothing runs and nothing is sent, because
 * there is nobody this site can trust to send it to. A call failing 4–6 is
 * answered with a tool error, so the model hears why and the device does not
 * wait out `TOOL_CALL_TIMEOUT` for nothing.
 */

/** What a handler is told about the call it is answering (§6). */
export interface ToolContext {
  /** The job the call belongs to. Scope a tool to this job, not to the user. */
  readonly jobId: string;
  /**
   * The job's user — the `owner` it was enqueued for. On a purpose a teammate
   * can serve, authorise no wider than the job: the caller may be a
   * teammate's modified daemon, and the user's authority reaches further than
   * the job does (§6).
   */
  readonly user: string;
  /** The purpose the job was enqueued under, when it named one. */
  readonly purpose: string | undefined;
  /** The daemon's id for this call. */
  readonly callId: string;
  /** Which call in the job, from 1, as the device numbered it. */
  readonly seq: number;
}

/**
 * A tool's implementation, on the site's own servers.
 *
 * `args` has already been checked against the tool's declaration. Treat it as
 * untrusted input all the same (§6): it was chosen by a model that a page or
 * a prompt may have talked into something.
 *
 * Return the text the model reads. Throw {@link ToolError} to answer with an
 * error the model reads; anything else thrown is answered with a fixed
 * sentence, so a stack trace or a database message never reaches a device.
 */
export type ToolHandler = (
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
) => string | Promise<string>;

/**
 * A tool's own refusal, in words the model may read — "no results for that
 * query". Its message travels sealed to the device, cut to
 * `TOOL_LIMITS.maxErrorBytes`.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** How each call the pump saw this cycle ended, by call id. */
export interface ToolsReport {
  /** A handler ran and its answer was accepted upstream. */
  readonly answered: string[];
  /**
   * Answered with a tool error: an undeclared tool, a tool with no handler,
   * arguments that fail the declaration, a handler that threw, or an answer
   * too large to send.
   */
  readonly errored: string[];
  /**
   * Past the job's budget: no handler ran, and the device was told so
   * (`TOOLS_BUDGETED`, the site SDK's counter).
   */
  readonly refused: string[];
  /**
   * Could not be trusted — not openable, not from the named device, not for
   * an open tool job of this site. Nothing ran and nothing was sent.
   */
  readonly dropped: string[];
  /**
   * Answered here, and the upstream no longer wanted it: the call timed out,
   * or its grant ended, while the handler ran.
   */
  readonly late: string[];
}

/** A call as the upstream lists it — the relay's `calls`, or the app's. */
export type ListedCall = SiteToolCalls["calls"][number];

/** Where the pump posts one sealed answer, and what the upstream said. */
export type PostToolResult = (answer: {
  readonly jobId: string;
  readonly callId: string;
  readonly envelope: SealedEnvelope;
}) => Promise<"accepted" | "not-found" | "too-late">;

/** The fixed sentence for a handler that failed without a {@link ToolError}. */
const HANDLER_FAILED = "the site's tool failed";

const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_STATES);

/** UTF-8 bytes, which is how §5.1 measures a result. */
const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/** Cut `text` to at most `limit` UTF-8 bytes, never mid-character. */
function clip(text: string, limit: number): string {
  if (utf8Bytes(text) <= limit) return text;
  let out = "";
  for (const char of text) {
    if (utf8Bytes(out + char + "…") > limit) break;
    out += char;
  }
  return `${out}…`;
}

/** What one call came to, before it is sealed. */
type Verdict =
  | { readonly kind: "dropped" }
  | {
      readonly kind: "answered" | "errored" | "refused";
      readonly result: ToolResult;
      readonly record: JobRecord;
    };

export class SiteTools {
  readonly #store: ByollmStore;
  readonly #siteKeys: StoredKeys;
  readonly #now: () => number;
  readonly #handlers = new Map<string, ToolHandler>();

  constructor(deps: {
    store: ByollmStore;
    siteKeys: StoredKeys;
    now: () => number;
  }) {
    this.#store = deps.store;
    this.#siteKeys = deps.siteKeys;
    this.#now = deps.now;
  }

  /**
   * Register the handler for one tool, by the name the manifest declares.
   *
   * A name registered twice is refused rather than replaced: two modules each
   * believing they own `web_search` is a bug that would otherwise surface as
   * one of them silently never running.
   */
  register(name: string, handler: ToolHandler): void {
    const parsed = ToolName.safeParse(name);
    if (!parsed.success) {
      throw new Error(
        `"${name}" is not a tool name — a lowercase identifier: a letter, ` +
          "then letters, digits or underscores, at most 64",
      );
    }
    if (this.#handlers.has(name)) {
      throw new Error(`a handler for "${name}" is already registered`);
    }
    this.#handlers.set(name, handler);
  }

  /**
   * Answer every listed call, each independently.
   *
   * Calls run concurrently: they belong to different jobs or to one model
   * turn that asked for several at once, and a slow search for one job must
   * not hold another's answer past its timeout. The budget is safe under
   * that, because the charge is one atomic step in the store. A post that
   * throws — a relay going away mid-cycle — is rethrown once every call has
   * finished, so the caller's retry rules apply and no answer already made is
   * abandoned unposted.
   */
  async answer(
    calls: readonly ListedCall[],
    post: PostToolResult,
  ): Promise<ToolsReport> {
    const report: ToolsReport = {
      answered: [],
      errored: [],
      refused: [],
      dropped: [],
      late: [],
    };
    const settled = await Promise.allSettled(
      calls.map(async (call) => {
        const verdict = await this.#decide(call);
        if (verdict.kind === "dropped") {
          report.dropped.push(call.callId);
          return;
        }
        const envelope = await this.#seal(call, verdict.record, verdict.result);
        const accepted = await post({
          jobId: call.jobId,
          callId: call.callId,
          envelope,
        });
        if (accepted === "accepted") report[verdict.kind].push(call.callId);
        else report.late.push(call.callId);
      }),
    );
    const failed = settled.find(
      (it): it is PromiseRejectedResult => it.status === "rejected",
    );
    if (failed) throw failed.reason;
    return report;
  }

  async #decide(call: ListedCall): Promise<Verdict> {
    const siteKeyId = keyId(publicIdentityOf(this.#siteKeys).identity);

    // 1. Opened, verified, and for this job, in this direction.
    const opened = await open({
      envelope: call.envelope,
      recipientKeys: this.#siteKeys,
      senderIdentityPublic: call.device.identity,
      expected: {
        jobId: call.jobId,
        senderKeyId: keyId(call.device.identity),
        recipientKeyId: siteKeyId,
        direction: "tool-call",
      },
    });
    if (!opened.ok) return { kind: "dropped" };

    // 2. The sealed call is the call it is listed as.
    let body: unknown;
    try {
      body = JSON.parse(opened.plaintext);
    } catch {
      return { kind: "dropped" };
    }
    const parsed = ToolCall.safeParse(body);
    if (!parsed.success || parsed.data.callId !== call.callId) {
      return { kind: "dropped" };
    }
    const toolCall = parsed.data;

    // 3. An open tool job of this site, under the grant the site recorded.
    const record = await this.#store.get(call.jobId);
    if (
      record?.kind !== "llm.tools" ||
      TERMINAL.has(record.state) ||
      record.lease?.id !== call.leaseId
    ) {
      return { kind: "dropped" };
    }
    const payload = await this.#payloadOf(record);
    if (!payload) return { kind: "dropped" };

    const error = (kind: "errored" | "refused", text: string): Verdict => ({
      kind,
      record,
      result: {
        callId: toolCall.callId,
        seq: toolCall.seq,
        ok: false,
        error: clip(text, TOOL_LIMITS.maxErrorBytes),
      },
    });

    // 4. Charged before anything runs — the site SDK's counter (§8, C040).
    //    Every distinct call counts, a declared one or not, as the daemon's
    //    counter has it (C036).
    const budget = Math.min(
      payload.maxToolCalls ?? payload.purposeLimits.maxToolCalls,
      payload.purposeLimits.maxToolCalls,
    );
    const charge = await this.#store.chargeToolCall({
      jobId: record.id,
      callId: toolCall.callId,
      maxToolCalls: budget,
      now: this.#now(),
    });
    if ("refused" in charge) {
      if (charge.refused === "closed") return { kind: "dropped" };
      return error(
        "refused",
        `this job has made every tool call it is allowed (${String(budget)})`,
      );
    }

    // 5. A tool this job's own payload declares.
    const declaration = payload.tools.find((t) => t.name === toolCall.name);
    if (!declaration) {
      return error("errored", `"${toolCall.name}" is not a tool of this job`);
    }
    const handler = this.#handlers.get(toolCall.name);
    if (!handler) {
      return error(
        "errored",
        `the site has no handler for "${toolCall.name}" right now`,
      );
    }

    // 6. Arguments that fit the declaration.
    const refusal = toolArgumentsRefusal(
      declaration.parameters,
      toolCall.arguments,
    );
    if (refusal !== null) return error("errored", refusal);

    let content: unknown;
    try {
      content = await handler(toolCall.arguments, {
        jobId: record.id,
        user: record.owner,
        purpose: record.purpose,
        callId: toolCall.callId,
        seq: toolCall.seq,
      });
    } catch (thrown) {
      return error(
        "errored",
        thrown instanceof ToolError && thrown.message !== ""
          ? thrown.message
          : HANDLER_FAILED,
      );
    }
    if (typeof content !== "string") return error("errored", HANDLER_FAILED);
    // §8: one result's content is bounded by the site SDK before sealing.
    if (utf8Bytes(content) > TOOL_LIMITS.maxContentBytes) {
      return error("errored", "the site's answer was too large to send");
    }
    return {
      kind: "answered",
      record,
      result: {
        callId: toolCall.callId,
        seq: toolCall.seq,
        ok: true,
        content,
      },
    };
  }

  /**
   * The job's payload, from the site's own sealed-at-rest copy.
   *
   * The declarations a call is checked against come from here, never from
   * anything the upstream or the device sent: this envelope is sealed by the
   * site to itself at enqueue, and nobody else can write one that opens.
   */
  async #payloadOf(record: JobRecord): Promise<ToolsPayload | null> {
    const siteKeyId = keyId(publicIdentityOf(this.#siteKeys).identity);
    const opened = await open({
      envelope: record.envelope,
      recipientKeys: this.#siteKeys,
      senderIdentityPublic: this.#siteKeys.identityPublic,
      expected: {
        jobId: record.id,
        senderKeyId: siteKeyId,
        recipientKeyId: siteKeyId,
        direction: "payload",
      },
    });
    if (!opened.ok) return null;
    try {
      const parsed = ToolsPayload.safeParse(JSON.parse(opened.plaintext));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Seal an answer to the device that asked, as a `tool-result`. */
  async #seal(
    call: ListedCall,
    record: JobRecord,
    result: ToolResult,
  ): Promise<SealedEnvelope> {
    return seal({
      plaintext: JSON.stringify(ToolResult.parse(result)),
      senderKeys: this.#siteKeys,
      recipientEncryptionPublic: call.device.encryption,
      context: {
        jobId: call.jobId,
        senderKeyId: keyId(publicIdentityOf(this.#siteKeys).identity),
        recipientKeyId: keyId(call.device.identity),
        // The bound the job's payload envelope carries: the ciphertext is
        // worth keeping no longer than the work it belongs to.
        deadlineAt: record.createdAt + ENVELOPE_MAX_AGE_MS,
        direction: "tool-result",
      },
    });
  }
}

import { randomBytes } from "node:crypto";
import {
  TOOL_LIMITS,
  ToolResult,
  toolArgumentsRefusal,
  type SealedEnvelope,
  type ToolCall,
  type ToolDeclaration,
  type ToolOutcomes,
} from "@byollm/protocol";
import type {
  Backend,
  BackendResult,
  ConverseMessage,
  ModelToolCall,
  StopReason,
} from "./backends/types.js";

/**
 * The function-calling loop — byollm_012 §5, §7, §8, §9.
 *
 * **Nothing here runs a tool** ({@link MUSTS.TOOLS_RUN_AT_SITE}). The model
 * is shown the site's declarations; when it asks for a call, the call is
 * checked against its declaration, written to the ingress log, signed and
 * sealed to the site, and sent. The site runs it on its own infrastructure
 * and seals the answer back. This module's only ways out of the process are
 * the backend it is handed (the owner's own model server) and the
 * {@link ToolTransport} (the upstream the job came from) — it imports no
 * process, file or socket API, and `tool-loop-reaches-nothing.test.ts` holds
 * it to that.
 *
 * The daemon owns the loop, the budget, the context cap and the log. The
 * model never touches a tool runtime, and a site never touches the model
 * except through what its tool returns — which is why that text is held to
 * the job's context cap and counted before the model sees it.
 */

/** How often a waiting call asks the upstream for its answer (§5.3). */
export const TOOL_POLL_MS = 1_000;

/**
 * What the model is told when it reaches its budget or its context cap —
 * §8, word for word. Asked once, with no tools offered.
 */
export const CLOSING_TURN = "Answer from what you have.";

/** The way to the site: the upstream's two tool endpoints, for this lease. */
export interface ToolTransport {
  /**
   * Send one call: `"sent"` when the upstream took it. Throws when it would
   * not, except for one refusal it names: `"tools-spent"`, the upstream
   * saying this job has made every call it is allowed (byollm_012 §8,
   * `TOOLS_SPENT_MESSAGE`).
   */
  send(call: {
    callId: string;
    envelope: SealedEnvelope;
  }): Promise<"sent" | "tools-spent">;
  /** The upstream's answers for the one call this job is waiting on. */
  poll(
    callId: string,
  ): Promise<
    readonly { jobId: string; callId: string; envelope: SealedEnvelope }[]
  >;
}

export interface ToolLoopLog {
  call(entry: {
    callId: string;
    seq: number;
    name: string;
    arguments: string;
  }): Promise<void>;
  outcome(entry: {
    callId: string;
    seq: number;
    outcome: keyof ToolOutcomes;
    content?: string;
    detail?: string;
  }): Promise<void>;
  dropped(entry: { callId?: string; why: string }): Promise<void>;
}

export interface ToolLoopInput {
  readonly backend: Backend;
  readonly model: string;
  readonly jobId: string;
  /** The opening turn: the job's composed prompt, as every kind gets. */
  readonly prompt: string;
  readonly declarations: readonly ToolDeclaration[];
  /** Calls this job may make: the lowest of the payload, purpose and owner. */
  readonly budget: number;
  /** Result text this job may read, summed — the context cap (§8). */
  readonly maxResultChars: number;
  /** One model turn's ceiling, as every backend call has. */
  readonly turnCeilingMs: number;
  readonly maxOutputBytes: number;
  /** The job's own deadline, which bounds the whole loop (§5.3). */
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly now: () => number;
  /** Waits between polls; a test's clock advances here. */
  readonly wait: (ms: number) => Promise<void>;
  readonly transport: ToolTransport;
  /** Sign and seal one call to the job's site, `tool-call` direction. */
  readonly seal: (call: ToolCall) => Promise<SealedEnvelope>;
  /**
   * Open one envelope as this job's `tool-result` from its site — the pinned
   * key, the direction, the job id. The plaintext, or `null` when it is not.
   */
  readonly open: (envelope: SealedEnvelope) => Promise<string | null>;
  readonly log: ToolLoopLog;
}

export interface ToolLoopRun {
  /** The answer, shaped like any backend's, so the runner reports it as one. */
  readonly result: BackendResult;
  readonly toolCalls: number;
  readonly toolOutcomes: ToolOutcomes;
  /** Model turns taken, for the daily budgets, which count turns (§8). */
  readonly turns: number;
  /** Characters sent to the model over every turn, for the spend estimate. */
  readonly inputChars: number;
}

/** A call the loop is waiting on: the only thing a result may answer. */
interface Outstanding {
  readonly callId: string;
  readonly seq: number;
}

/** Run one `llm.tools` job's loop to its answer. */
export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopRun> {
  const converse = input.backend.converse?.bind(input.backend);
  const started = input.now();
  const outcomes = { answered: 0, errored: 0, timedOut: 0, refused: 0 };
  const declared = new Map(input.declarations.map((d) => [d.name, d]));
  const tools = input.declarations.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: d.parameters,
  }));
  const messages: ConverseMessage[] = [{ role: "user", content: input.prompt }];
  /* Every call this job has finished with, so a second answer to one is
     named as a replay rather than as a stranger (C037). */
  const finished = new Set<string>();
  let calls = 0;
  let resultChars = 0;
  let turns = 0;
  let inputChars = 0;

  const run = (result: BackendResult): ToolLoopRun => ({
    result,
    toolCalls: calls,
    toolOutcomes: { ...outcomes },
    turns,
    inputChars,
  });
  const failed = (
    code: Extract<BackendResult, { ok: false }>["code"],
    message: string,
  ): ToolLoopRun =>
    run({ ok: false, code, message, durationMs: input.now() - started });

  if (converse === undefined) {
    /* Unreachable through config: an `llm.tools` route on a backend without
       `converse` is never advertised. Said rather than assumed. */
    return failed("backend-error", "this backend cannot carry a site's tools");
  }

  /** One model turn, bounded by its ceiling and by what is left of the job. */
  const turn = async (offer: boolean) => {
    const remaining = input.deadlineAt - input.now();
    if (remaining <= 0) return null;
    turns += 1;
    inputChars += messages.reduce((sum, m) => sum + m.content.length, 0);
    return converse({
      messages: [...messages],
      ...(offer ? { tools } : {}),
      model: input.model,
      timeoutMs: Math.min(input.turnCeilingMs, remaining),
      maxOutputBytes: input.maxOutputBytes,
      signal: input.signal,
    });
  };

  for (;;) {
    const answer = await turn(true);
    if (answer === null) {
      return failed("timeout", "this job's deadline passed during its tools");
    }
    if (!answer.ok)
      return run({ ...answer, durationMs: input.now() - started });
    if (answer.toolCalls.length === 0) {
      return run(okResult(answer.text, answer.stop, input.now() - started));
    }

    messages.push({
      role: "assistant",
      content: answer.text,
      toolCalls: answer.toolCalls,
    });

    let atLimit = false;
    for (const asked of answer.toolCalls) {
      if (atLimit) {
        /* Calls the model asked for after the limit was reached are never
           made, and never charged — but a tool turn must still answer each,
           or the model server refuses the conversation. */
        messages.push(toolTurn(asked, "Not run: this job's tools are spent."));
        continue;
      }
      /* Charged BEFORE the call, never after (§8, C038): the call that would
         exceed the budget is the one that is not made — it finds `atLimit`
         already set above.

         ONE check, here at the charge, so no path out of this iteration can
         skip it. There were two — before each call, and after the switch —
         and the refusal's `continue` skipped the second: a turn whose last
         call was refused and spent the budget asked the model once more with
         tools offered, as did one whose last call was sent before the second
         check existed (Owl, #55998 fix 2). With the check after the charge,
         the turn that spends the budget always goes to the closing turn. */
      calls += 1;
      if (calls >= input.budget) atLimit = true;
      const seq = calls;
      const callId = newCallId();

      /* The model's request, logged before anything else happens to it —
         including a refusal, because it is still a request of that site the
         owner may want to read (§9). */
      await input.log.call({
        callId,
        seq,
        name: asked.name,
        arguments: asked.arguments,
      });

      const refusal = checkCall(asked, declared);
      if (refusal !== null) {
        /* A tool error to the model, and nothing sent (C036). */
        outcomes.refused += 1;
        await input.log.outcome({
          callId,
          seq,
          outcome: "refused",
          detail: refusal.why,
        });
        messages.push(
          toolTurn(asked, `Tool error: ${refusal.why}. Nothing was sent.`),
        );
        continue;
      }

      const call: ToolCall = {
        callId,
        seq,
        name: asked.name,
        arguments: parsedArguments(asked),
      };
      let sent: "sent" | "unsent" | "tools-spent";
      try {
        sent = await input.transport.send({
          callId,
          envelope: await input.seal(call),
        });
      } catch {
        sent = "unsent";
      }
      const answered =
        sent === "sent"
          ? await waitForResult({
              ...input,
              outstanding: { callId, seq },
              finished,
            })
          : ({ kind: sent } as const);
      finished.add(callId);

      switch (answered.kind) {
        case "canceled":
          return run({
            ok: false,
            code: "canceled",
            message: "the job was canceled",
            durationMs: input.now() - started,
          });
        case "tools-spent": {
          /* The upstream's count is the job's, not this device's: a job
             claimed after a lapse can arrive with its calls already made
             (#7122, Owl #56042 point 3). Not a site that did not answer —
             nothing more will be taken, so the model is told so and the job
             closes like one at its own limit, `ok` with `stop:
             "tool-budget"` (§8). Never a failed request. */
          outcomes.refused += 1;
          atLimit = true;
          await input.log.outcome({
            callId,
            seq,
            outcome: "refused",
            detail:
              "the upstream says this job has made every tool call it is allowed",
          });
          messages.push(
            toolTurn(
              asked,
              "Tool error: this job's tools are spent. Nothing was run.",
            ),
          );
          break;
        }
        case "unsent":
        case "timed-out": {
          /* The call still counts toward the budget (§5.3). An unsent call is
             a site that did not answer, from the model's side and the site's:
             the site never saw it. */
          outcomes.timedOut += 1;
          await input.log.outcome({
            callId,
            seq,
            outcome: "timedOut",
            detail:
              answered.kind === "unsent"
                ? "the upstream would not take the call"
                : `no answer within ${String(TOOL_LIMITS.callTimeoutMs)}ms`,
          });
          messages.push(toolTurn(asked, "The site did not answer in time."));
          break;
        }
        case "result": {
          const result = answered.result;
          if (!result.ok) {
            outcomes.errored += 1;
            await input.log.outcome({
              callId,
              seq,
              outcome: "errored",
              detail: result.error,
            });
            messages.push(
              toolTurn(asked, `Tool error from the site: ${result.error}`),
            );
            break;
          }
          /* The context cap, before the model sees a character (§8, C046). */
          if (resultChars + result.content.length > input.maxResultChars) {
            outcomes.refused += 1;
            atLimit = true;
            await input.log.outcome({
              callId,
              seq,
              outcome: "refused",
              content: result.content,
              detail:
                `would take this job past its ${String(input.maxResultChars)}` +
                "-character tool-result limit",
            });
            messages.push(
              toolTurn(
                asked,
                "Not shown: this job has read all the tool results it may.",
              ),
            );
            break;
          }
          resultChars += result.content.length;
          outcomes.answered += 1;
          await input.log.outcome({
            callId,
            seq,
            outcome: "answered",
            content: result.content,
          });
          messages.push(toolTurn(asked, result.content));
          break;
        }
      }
    }

    if (atLimit) {
      /* At the limit the job finishes, and does not fail (§8): once more,
         with no tools offered, and the site is told why it is short. */
      messages.push({ role: "user", content: CLOSING_TURN });
      const closing = await turn(false);
      if (closing === null) {
        return failed("timeout", "this job's deadline passed during its tools");
      }
      if (!closing.ok) {
        return run({ ...closing, durationMs: input.now() - started });
      }
      return run(okResult(closing.text, "tool-budget", input.now() - started));
    }
  }
}

function okResult(
  text: string,
  stop: StopReason,
  durationMs: number,
): BackendResult {
  return { ok: true, text, stop, durationMs };
}

function toolTurn(asked: ModelToolCall, content: string): ConverseMessage {
  return { role: "tool", toolCallId: asked.id, content };
}

/** 128 bits, base64url — random and single-use (§5.1). */
function newCallId(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Whether a call may be sent: a declared name, arguments that parse as an
 * object and fit the declaration's schema (C036), and within §5.1's size.
 */
function checkCall(
  asked: ModelToolCall,
  declared: ReadonlyMap<string, ToolDeclaration>,
): { why: string } | null {
  const declaration = declared.get(asked.name);
  if (declaration === undefined) {
    return {
      why: `"${asked.name.slice(0, 64)}" is not one of this job's tools`,
    };
  }
  if (
    new TextEncoder().encode(asked.arguments).length >
    TOOL_LIMITS.maxArgumentBytes
  ) {
    return { why: "the arguments are too large" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(asked.arguments);
  } catch {
    return { why: "the arguments are not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { why: "the arguments are not an object" };
  }
  const refusal = toolArgumentsRefusal(
    declaration.parameters,
    parsed as Record<string, unknown>,
  );
  return refusal === null ? null : { why: refusal };
}

function parsedArguments(asked: ModelToolCall): Record<string, unknown> {
  return JSON.parse(asked.arguments) as Record<string, unknown>;
}

/**
 * Wait for the site's answer to one call — §5.3 and C037.
 *
 * Up to {@link TOOL_LIMITS.callTimeoutMs}, never past the job's deadline, and
 * no longer once the job is cancelled. The lease is renewed meanwhile by the
 * runner's heartbeat, which renews every lease the runner still holds — and
 * the job is held until its loop returns.
 *
 * A result is accepted only for the one call outstanding, of this job, with
 * its `seq`, in an envelope that opens as this job's `tool-result` from its
 * site. Everything else is dropped and logged, and the model never sees it.
 */
async function waitForResult(
  input: ToolLoopInput & {
    readonly outstanding: Outstanding;
    readonly finished: ReadonlySet<string>;
  },
): Promise<
  | { kind: "result"; result: ToolResult }
  | { kind: "timed-out" }
  | { kind: "canceled" }
> {
  const sentAt = input.now();
  for (;;) {
    if (input.signal.aborted) return { kind: "canceled" };
    let batch: Awaited<ReturnType<ToolTransport["poll"]>> = [];
    try {
      batch = await input.transport.poll(input.outstanding.callId);
    } catch {
      /* A failed poll is a poll that found nothing; the clock below is what
         gives up, not one bad request. */
    }
    for (const entry of batch) {
      const accepted = await acceptResult(input, entry);
      if (accepted !== null) return { kind: "result", result: accepted };
    }
    const now = input.now();
    if (now - sentAt >= TOOL_LIMITS.callTimeoutMs || now >= input.deadlineAt) {
      return { kind: "timed-out" };
    }
    await input.wait(TOOL_POLL_MS);
  }
}

async function acceptResult(
  input: ToolLoopInput & {
    readonly outstanding: Outstanding;
    readonly finished: ReadonlySet<string>;
  },
  entry: { jobId: string; callId: string; envelope: SealedEnvelope },
): Promise<ToolResult | null> {
  const drop = async (why: string): Promise<null> => {
    await input.log.dropped({ callId: entry.callId, why });
    return null;
  };
  if (entry.jobId !== input.jobId) {
    return drop("a result labelled for another job");
  }
  if (entry.callId !== input.outstanding.callId) {
    return drop(
      input.finished.has(entry.callId)
        ? "a second answer to a call already finished"
        : "a result for no call this job is waiting on",
    );
  }
  const plaintext = await input.open(entry.envelope);
  if (plaintext === null) {
    return drop(
      "did not open as this job's tool-result from the site it paired with",
    );
  }
  let parsed: ReturnType<typeof ToolResult.safeParse>;
  try {
    parsed = ToolResult.safeParse(JSON.parse(plaintext));
  } catch {
    return drop("the result is not JSON");
  }
  if (!parsed.success) return drop("the result is not a tool result");
  if (
    parsed.data.callId !== input.outstanding.callId ||
    parsed.data.seq !== input.outstanding.seq
  ) {
    return drop("the sealed result names a different call");
  }
  return parsed.data;
}

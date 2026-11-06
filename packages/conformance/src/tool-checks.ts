import { relative } from "node:path";
import {
  TOOL_LIMITS,
  generateKeys,
  open,
  payloadTextLength,
  publicIdentityOf,
  sizeClassOf,
  type MustId,
  type ToolDeclaration,
  type ToolLimits,
  type ToolsSealedOutcome,
} from "@byollm/protocol";
import type { ConformanceTarget } from "./target.js";
import {
  CLOSING_TURN,
  LOOKUP,
  call,
  toolStage,
  toolTurns,
  watchTheDevice,
  type Delivery,
  type ModelScript,
  type ModelTurn,
  type ToolRun,
  type ToolStage,
} from "./tools.js";

/**
 * byollm_012 §12's checks C033–C038, C041–C043 and C046, as kit checks —
 * #7116, lifting #7055's daemon suites (`packages/daemon/src/
 * tools-at-the-site.test.ts`) into the kit now that a target can be played as
 * its site (`ConformanceTarget.site`, `tools.ts`).
 *
 * Each keeps the assertions #7055 wrote. Where the kit sees more than the
 * daemon's suite did (the target's own site plane, the bytes it serves the
 * site), it asserts that too; where it sees less, the comment says what is
 * left to the daemon's suite, which stays. Each is in MUTATIONS.md with the
 * mutation #7055 recorded, seen to fail here.
 */

/** Structurally the kit's `Check`; `checks.ts` spreads these into `CHECKS`. */
interface ToolCheck {
  readonly id: string;
  readonly title: string;
  readonly musts: readonly MustId[];
  run(target: ConformanceTarget): Promise<void>;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

function expectSame(actual: unknown, expected: unknown, what: string): void {
  assert(
    same(actual, expected),
    `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/** Every key of `expected` matches in `actual` (a shallow `toMatchObject`). */
function expectMatch(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown>,
  what: string,
): void {
  for (const [key, value] of Object.entries(expected)) {
    const got = actual?.[key];
    const ok =
      typeof value === "object" && value !== null
        ? Object.entries(value).every(([k, v]) =>
            same((got as Record<string, unknown> | undefined)?.[k], v),
          )
        : same(got, value);
    assert(
      ok,
      `${what}: ${key} expected ${JSON.stringify(value)}, got ${JSON.stringify(got)}`,
    );
  }
}

async function withStage(
  target: ConformanceTarget,
  body: (stage: ToolStage) => Promise<void>,
): Promise<void> {
  const stage = await toolStage(target);
  try {
    await body(stage);
  } finally {
    await stage.dispose();
  }
}

/** The opened result of a run that must have ended with one. */
function resulted(run: ToolRun): ToolsSealedOutcome {
  assert(
    run.end.kind === "result",
    `the job was refused: ${run.end.kind === "refused" ? run.end.reason : ""}`,
  );
  assert(
    run.end.status === 200,
    `the target refused the job's genuine result (${String(run.end.status)})`,
  );
  return run.end.outcome as ToolsSealedOutcome;
}

const outcomeOf = (o: ToolsSealedOutcome): Record<string, unknown> => o.outcome;
const ranOf = (o: ToolsSealedOutcome): Record<string, unknown> => o.ran;

/**
 * C041's lease promise: from the claim to the result, the lease named in the
 * claim was never left a whole lease-length without a heartbeat naming it.
 *
 * Coverage, not a count. A floor of "one beat a second" assumed a tick costs
 * nothing; a daemon's beat is its sleep plus its heartbeat and claim round
 * trips, ~1.06s against PostgREST, and Supabase failed on 57 beats in 60.6s
 * (#7265) while its lease was never at risk. What the target promises is
 * here instead, and is the same on any backend: the first beat inside a
 * lease of the claim, the last inside a lease of the result, no gap a lease
 * long, and every beat naming the lease.
 *
 * And a wait long enough to need it. On a target whose lease outlasts the
 * hold, one beat anywhere satisfies all of that and the claim's own lease
 * would have carried the job anyway: C041 would prove the timeout and that
 * the result was accepted, not that the lease was renewed. So the hold must
 * span two leases, which no daemon covers without beating at least twice,
 * once well inside the hold; a target that cannot give that fails here, the
 * way a deadline too close to the timeout does in C041, rather than certify
 * a renewal nothing exercised.
 */
export function heldThroughout(input: {
  readonly beats: readonly { at: number; leases: readonly string[] }[];
  readonly leaseId: string;
  readonly claimedAt: number;
  readonly resultAt: number;
  readonly leaseMs: number;
}): void {
  const { leaseId, claimedAt, resultAt, leaseMs } = input;
  const held = resultAt - claimedAt;
  assert(
    held >= 2 * leaseMs,
    `the job was held ${String(held)}ms on a ${String(leaseMs)}ms lease, too short to show it was renewed`,
  );
  const during = input.beats.filter((b) => b.at > claimedAt && b.at < resultAt);
  for (const beat of during) {
    expectSame(beat.leases, [leaseId], "the leases a heartbeat named");
  }
  const first = during[0];
  const last = during.at(-1);
  assert(
    first !== undefined && last !== undefined,
    `no heartbeat in the ${String(held)}ms the job was held`,
  );
  assert(
    first.at - claimedAt < leaseMs,
    `the first heartbeat came ${String(first.at - claimedAt)}ms after the claim, past the ${String(leaseMs)}ms lease`,
  );
  assert(
    resultAt - last.at < leaseMs,
    `the last heartbeat came ${String(resultAt - last.at)}ms before the result, longer than the ${String(leaseMs)}ms lease`,
  );
  const gaps = during.slice(1).map((b, i) => b.at - (during[i]?.at ?? b.at));
  const widest = Math.max(0, ...gaps);
  assert(
    widest < leaseMs,
    `heartbeats ${String(widest)}ms apart, longer than the ${String(leaseMs)}ms lease`,
  );
}

/** Call `lookup` on the first `n` turns, then answer. */
const callsThenAnswers =
  (n: number, answer = "done"): ModelScript =>
  (_request, turn): ModelTurn =>
    turn <= n
      ? call("lookup", { query: `q${String(turn)}` })
      : { text: answer };

/** Two calls a turn while tools are offered; an answer once they are not. */
const twoATurn =
  (second: { name: string; arguments: string }): ModelScript =>
  (request) =>
    request.tools === undefined
      ? { text: "what I have" }
      : {
          calls: [{ name: "lookup", arguments: '{"query":"one"}' }, second],
        };

export const TOOL_CHECKS: readonly ToolCheck[] = [
  {
    id: "C033_TOOL_CALL_LEAVES_SEALED",
    title:
      "a tool call reaches the site as one tool-call envelope only the site's key opens, signed by the device",
    musts: ["TOOLS_RUN_AT_SITE"],
    async run(target: ConformanceTarget): Promise<void> {
      await withStage(target, async (stage) => {
        const NEEDLE = "a-term-only-the-site-may-read";
        const run = await stage.run({
          script: (_r, turn) =>
            turn === 1 ? call("lookup", { query: NEEDLE }) : { text: "done" },
        });
        const outcome = resulted(run);

        assert(
          run.arrived.length === 1,
          `expected one tool-call at the upstream, got ${String(run.arrived.length)}`,
        );
        assert(
          run.served.length === 1,
          `expected the site to be served one call, got ${String(run.served.length)}`,
        );
        // The direction is inside the signature: a call is never a payload.
        for (const envelope of [...run.arrived, ...run.served]) {
          assert(
            envelope.direction === "tool-call",
            `a call travelled as "${envelope.direction}", not "tool-call"`,
          );
        }
        // The site (the kit, with the site's key, verifying the device's)
        // opened it.
        assert(run.calls.length === 1, "the site did not open one call");
        assert(run.calls[0]?.name === "lookup", "the call was not `lookup`");
        expectSame(run.calls[0].arguments, { query: NEEDLE }, "arguments");
        // The bytes the upstream holds — what the daemon posted, and what the
        // target's site plane serves back out — carry neither the tool's name
        // nor its arguments (Owl, #55956 point 3): sealed, not merely present.
        for (const envelope of [...run.arrived, ...run.served]) {
          const bytes = JSON.stringify(envelope);
          assert(!bytes.includes(NEEDLE), "the upstream holds the arguments");
          assert(!bytes.includes('"lookup"'), "the upstream holds the name");
          assert(!bytes.includes("query"), "the upstream holds a parameter");
        }
        // Nothing of the call opens without the site's key.
        const [envelope] = run.arrived;
        const stranger = generateKeys(Date.now());
        const byStranger = await open({
          envelope: envelope!,
          recipientKeys: stranger,
          senderIdentityPublic: publicIdentityOf(stage.daemon.keys).identity,
          expected: {
            jobId: run.jobId,
            senderKeyId: envelope!.senderKeyId,
            recipientKeyId: envelope!.recipientKeyId,
            direction: "tool-call",
          },
        });
        assert(!byStranger.ok, "a stranger's key opened a tool call");
        // And the job finished on the site's answer.
        expectMatch(
          outcomeOf(outcome),
          { outcome: "ok", text: "done" },
          "outcome",
        );
        expectMatch(
          ranOf(outcome),
          {
            toolCalls: 1,
            toolOutcomes: { answered: 1, errored: 0, timedOut: 0, refused: 0 },
          },
          "ran",
        );
      });
    },
  },

  {
    id: "C034_NOTHING_RUNS_ON_THE_DEVICE",
    title:
      "a hostile site's shell, exec, read_file and fetch run nowhere on the device; all four calls reach the site sealed",
    musts: ["TOOLS_RUN_AT_SITE"],
    async run(target: ConformanceTarget): Promise<void> {
      const declared = (
        name: string,
        description: string,
        field: string,
      ): ToolDeclaration => ({
        name,
        description,
        parameters: {
          type: "object",
          properties: { [field]: { type: "string", maxLength: 256 } },
          required: [field],
        },
      });
      const HOSTILE: ToolDeclaration[] = [
        declared(
          "shell",
          "Run a shell command on the user's computer.",
          "command",
        ),
        declared("exec", "Execute a program on this device.", "argv"),
        declared("read_file", "Read a file from the user's disk.", "path"),
        declared("fetch", "Fetch a URL from the user's network.", "url"),
      ];
      const ASKS: [string, Record<string, string>][] = [
        ["shell", { command: "rm -rf ~" }],
        ["exec", { argv: "/bin/sh -c 'cat ~/.ssh/id_ed25519'" }],
        ["read_file", { path: "/etc/passwd" }],
        ["fetch", { url: "http://127.0.0.1:22/" }],
      ];
      await withStage(target, async (stage) => {
        const home = stage.daemon.home;
        const watch = watchTheDevice();
        let run: ToolRun;
        try {
          run = await stage.run({
            tools: HOSTILE,
            script: (_r, turn) => {
              const ask = ASKS[turn - 1];
              return ask === undefined
                ? { text: "done" }
                : call(ask[0], ask[1]);
            },
          });
        } finally {
          watch.stop();
        }
        const outcome = resulted(run);

        expectSame(watch.spawned, [], "processes the daemon started");
        expectSame(watch.datagrams, [], "datagrams the daemon sent");
        // The model is answered in-process, so the only sockets allowed are
        // the upstream's own — the target's, when it talks to its database.
        // #7055 allowed the model server's port; here there is none.
        const strays = watch.connected.filter((c) => !c.upstream);
        expectSame(strays, [], "sockets opened outside the upstream");
        // The control: the model was reached, through the shipped adapter.
        assert(run.requests.length > 0, "the model was never asked anything");
        // Every file written is the daemon's own state; the only one that
        // holds a call's arguments is the ingress log, which is where §9 puts
        // them.
        assert(watch.written.length > 0, "the daemon wrote nothing at all");
        for (const { path } of watch.written) {
          assert(
            path.startsWith(home),
            `the daemon wrote outside its home: ${path}`,
          );
        }
        const holding = [
          ...new Set(
            watch.written
              .filter(
                ({ data }) =>
                  data.includes("id_ed25519") || data.includes("rm -rf"),
              )
              .map(({ path }) => relative(home, path)),
          ),
        ];
        expectSame(
          holding,
          ["ingress.log"],
          "files holding a call's arguments",
        );
        expectSame(
          run.calls.map((c) => c.name),
          ["shell", "exec", "read_file", "fetch"],
          "calls the site received",
        );
        expectMatch(ranOf(outcome), { toolCalls: 4 }, "ran");
      });
    },
  },

  {
    id: "C035_TOOLS_MATCH_CONSENT",
    title:
      "a payload asking more calls than its purpose allows is refused at admission, before any model sees it",
    musts: ["TOOLS_MATCH_CONSENT"],
    async run(target: ConformanceTarget): Promise<void> {
      // #7055's C035 has four cases. Three compare the payload with the
      // grant's `toolsDigest` — the cloud lane's clause, and a direct target
      // routes no grant, so there is no digest for a device to compare
      // against (byollm_012 §4, "The direct lane"). Those three stay in the
      // daemon's suite. The fourth is every lane's, and is here as #7055
      // wrote it, with its control.
      await withStage(target, async (stage) => {
        const refused = await stage.run({
          maxToolCalls: 9,
          script: callsThenAnswers(1),
        });
        const end = refused.end;
        if (end.kind !== "refused") {
          throw new Error(
            "a payload whose maxToolCalls is above its purposeLimits was run",
          );
        }
        assert(
          end.reason.includes("not the ones the person consented to"),
          `refused for another reason: ${end.reason}`,
        );
        expectSame(refused.requests, [], "what the model saw");
        expectSame(refused.calls, [], "what the site received");

        // The control: without it, the refusal above could be some other rule.
        const runs = await stage.run({ script: callsThenAnswers(1) });
        expectMatch(outcomeOf(resulted(runs)), { outcome: "ok" }, "outcome");
        assert(
          runs.requests.length > 0,
          "the consented job never reached the model",
        );
      });
    },
  },

  {
    id: "C036_UNDECLARED_OR_ILL_TYPED_CALLS",
    title:
      "an undeclared tool, an extra argument and an over-long one are each a tool error to the model, and nothing is sent",
    musts: ["TOOLS_MATCH_CONSENT"],
    async run(target: ConformanceTarget): Promise<void> {
      await withStage(target, async (stage) => {
        const asks = [
          call("delete_everything", { all: true }),
          call("lookup", { query: "fine", sneaky: "extra" }),
          call("lookup", { query: "x".repeat(65) }),
        ];
        const run = await stage.run({
          script: (_r, turn) => asks[turn - 1] ?? { text: "done" },
        });
        const outcome = resulted(run);

        expectSame(run.calls, [], "calls the site received");
        expectSame(run.arrived, [], "calls the upstream received");
        expectMatch(
          ranOf(outcome),
          {
            toolCalls: 3,
            toolOutcomes: { answered: 0, errored: 0, timedOut: 0, refused: 3 },
          },
          "ran",
        );
        const errors = toolTurns(run.requests.at(-1));
        assert(
          errors.length === 3,
          `expected three tool errors, got ${String(errors.length)}`,
        );
        for (const error of errors) {
          assert(
            /^Tool error: .*Nothing was sent\.$/u.test(error),
            `not a tool error that says nothing was sent: ${error}`,
          );
        }
        assert(
          errors[0]!.includes("is not one of this job's tools"),
          errors[0]!,
        );
        assert(errors[1]!.includes('"sneaky" is not a parameter'), errors[1]!);
        assert(errors[2]!.includes("at most 64 characters"), errors[2]!);
      });
    },
  },

  {
    id: "C037_RESULT_BOUND_TO_ITS_CALL",
    title:
      "a result for an unknown call, for another job, a replay and a payload-direction envelope are each dropped and logged",
    musts: ["TOOL_ENVELOPES_BOUND"],
    async run(target: ConformanceTarget): Promise<void> {
      await withStage(target, async (stage) => {
        const MARK = "HOSTILE-RESULT";
        const STRANGER = "AAAAAAAAAAAAAAAAAAAAAA";
        let firstAnswer: Delivery | undefined;
        const targetHalf: string[] = [];
        const result = (callId: string, seq: number) =>
          JSON.stringify({ callId, seq, ok: true, content: MARK });
        const run = await stage.run({
          script: callsThenAnswers(2),
          onPoll: async (inject, calls, { jobId, leaseId }) => {
            const current = calls.at(-1);
            if (current === undefined) return;
            if (calls.length === 1 && firstAnswer === undefined) {
              firstAnswer = {
                jobId,
                leaseId,
                callId: current.callId,
                envelope: await stage.sealAsSite(
                  jobId,
                  result(current.callId, 1),
                ),
              };
              const unknown: Delivery = {
                jobId,
                leaseId,
                callId: STRANGER,
                envelope: await stage.sealAsSite(jobId, result(STRANGER, 1)),
              };
              const otherJob: Delivery = {
                jobId: "job_other",
                leaseId,
                callId: current.callId,
                envelope: await stage.sealAsSite(
                  "job_other",
                  result(current.callId, current.seq),
                ),
              };
              // The target's half first: posted as the site, through its own
              // `tool-result`, the two it can tell apart without opening
              // anything are refused there (byollm_012 §5.2).
              for (const d of [unknown, otherJob]) {
                const answered = await stage.site.toolResult(d);
                if ("accepted" in answered)
                  targetHalf.push(
                    d.callId === STRANGER
                      ? "an unknown callId"
                      : "another job's call",
                  );
              }
              // The daemon's half: an upstream that hands them over anyway.
              inject.push(
                unknown,
                // another job's call, labelled as that job
                otherJob,
                // another job's sealed result, labelled as this one
                {
                  jobId,
                  leaseId,
                  callId: current.callId,
                  envelope: await stage.sealAsSite(
                    "job_other",
                    result(current.callId, current.seq),
                  ),
                },
                // the right call, in a payload-direction envelope
                {
                  jobId,
                  leaseId,
                  callId: current.callId,
                  envelope: await stage.sealAsSite(
                    jobId,
                    result(current.callId, current.seq),
                    "payload",
                  ),
                },
              );
            }
            if (calls.length === 2 && firstAnswer !== undefined) {
              // a replay of the call already answered
              inject.push(firstAnswer);
              firstAnswer = undefined;
            }
          },
        });
        const outcome = resulted(run);

        expectSame(
          targetHalf,
          [],
          "results the target accepted for no outstanding call",
        );
        for (const request of run.requests) {
          assert(
            !JSON.stringify(request).includes(MARK),
            "the model was shown a result that was not bound to its call",
          );
        }
        expectMatch(
          ranOf(outcome),
          {
            toolCalls: 2,
            toolOutcomes: { answered: 2, errored: 0, timedOut: 0, refused: 0 },
          },
          "ran",
        );
        const dropped = (await stage.entries()).flatMap((e) =>
          e.type === "tool-dropped" ? [e.why] : [],
        );
        expectSame(
          dropped,
          [
            "a result for no call this job is waiting on",
            "a result labelled for another job",
            "did not open as this job's tool-result from the site it paired with",
            "did not open as this job's tool-result from the site it paired with",
            "a second answer to a call already finished",
          ],
          "what the daemon dropped and logged",
        );
      });
    },
  },

  {
    id: "C038_THE_DAEMONS_TOOL_BUDGET",
    title:
      "exactly maxToolCalls are sent, then one closing turn with no tools, ok with stop tool-budget",
    musts: ["TOOLS_BUDGETED"],
    async run(target: ConformanceTarget): Promise<void> {
      await withStage(target, async (stage) => {
        // Two calls a turn, so the third call and the fourth arrive in ONE
        // turn: the budget has to stop the fourth before it is sent, not
        // notice it after (a check that only ran between turns would let it
        // through).
        const three = await stage.run({
          maxToolCalls: 3,
          script: twoATurn({
            name: "lookup",
            arguments: '{"query":"and again"}',
          }),
        });
        const o3 = resulted(three);
        assert(
          three.calls.length === 3,
          `expected 3 calls sent, got ${String(three.calls.length)}`,
        );
        // The fourth was answered without being made, so the conversation
        // stays whole for the model server.
        expectSame(
          toolTurns(three.requests.at(-1)),
          [
            "found lookup",
            "found lookup",
            "found lookup",
            "Not run: this job's tools are spent.",
          ],
          "tool turns at the closing turn",
        );
        const closing = three.requests.at(-1);
        assert(closing?.tools === undefined, "the closing turn offered tools");
        expectSame(
          closing?.messages.at(-1),
          { role: "user", content: CLOSING_TURN },
          "the closing turn",
        );
        assert(
          three.requests.filter((r) => r.tools === undefined).length === 1,
          "not exactly one turn without tools",
        );
        expectMatch(
          outcomeOf(o3),
          { outcome: "ok", text: "what I have" },
          "outcome",
        );
        expectMatch(ranOf(o3), { stop: "tool-budget", toolCalls: 3 }, "ran");

        // Spent on a turn's LAST call: nothing in that turn is left over for
        // a pre-call check to stop, so the model must go straight to the
        // closing turn and never be offered tools again (Owl, #55998 fix 2).
        const two = await stage.run({
          maxToolCalls: 2,
          script: twoATurn({ name: "lookup", arguments: '{"query":"two"}' }),
        });
        const o2 = resulted(two);
        assert(
          two.calls.length === 2,
          `expected 2 calls sent, got ${String(two.calls.length)}`,
        );
        assert(
          two.requests.length === 2,
          `expected 2 model turns, got ${String(two.requests.length)}`,
        );
        assert(
          two.requests[0]?.tools !== undefined,
          "the first turn offered no tools",
        );
        assert(
          two.requests[1]?.tools === undefined,
          "the closing turn offered tools",
        );
        expectSame(
          two.requests[1]?.messages.at(-1),
          { role: "user", content: CLOSING_TURN },
          "the closing turn",
        );
        expectSame(
          toolTurns(two.requests[1]),
          ["found lookup", "found lookup"],
          "tool turns at the closing turn",
        );
        expectMatch(ranOf(o2), { stop: "tool-budget", toolCalls: 2 }, "ran");

        // The same when the call that spends it is refused, not sent: a
        // refused call is charged (§5.3).
        const refused = await stage.run({
          maxToolCalls: 2,
          script: twoATurn({ name: "shell", arguments: '{"command":"id"}' }),
        });
        const or = resulted(refused);
        assert(
          refused.calls.length === 1,
          `expected 1 call sent, got ${String(refused.calls.length)}`,
        );
        assert(
          refused.requests.length === 2,
          `expected 2 model turns, got ${String(refused.requests.length)}`,
        );
        assert(
          refused.requests[1]?.tools === undefined,
          "the model was offered tools again",
        );
        expectMatch(
          ranOf(or),
          {
            stop: "tool-budget",
            toolCalls: 2,
            toolOutcomes: { answered: 1, refused: 1 },
          },
          "ran",
        );
      });
    },
  },

  {
    id: "C041_SITE_THAT_DOES_NOT_ANSWER",
    title:
      "a call the site never answers is a tool error after TOOL_CALL_TIMEOUT, the job ends ok, and the lease is held throughout",
    musts: ["TOOLS_BUDGETED"],
    async run(target: ConformanceTarget): Promise<void> {
      await withStage(target, async (stage) => {
        const run = await stage.run({
          site: () => "silent",
          script: (request) =>
            toolTurns(request).length === 0
              ? call("lookup", { query: "anyone?" })
              : { text: "answered without it" },
        });
        const outcome = resulted(run);
        const waited = run.ended - run.started;

        // At the timeout, not at the deadline (five minutes away).
        assert(
          waited >= TOOL_LIMITS.callTimeoutMs,
          `the wait ended after ${String(waited)}ms, before TOOL_CALL_TIMEOUT`,
        );
        assert(
          waited < TOOL_LIMITS.callTimeoutMs + 5_000,
          `the wait ran ${String(waited)}ms, well past TOOL_CALL_TIMEOUT`,
        );
        assert(
          run.stub.deadlineAt - run.started > TOOL_LIMITS.callTimeoutMs + 5_000,
          "the job's deadline is too close to tell a timeout from it",
        );
        expectSame(
          toolTurns(run.requests.at(-1)),
          ["The site did not answer in time."],
          "the model's tool turn",
        );
        expectMatch(outcomeOf(outcome), { outcome: "ok" }, "outcome");
        expectMatch(
          ranOf(outcome),
          {
            toolCalls: 1,
            toolOutcomes: { answered: 0, errored: 0, timedOut: 1, refused: 0 },
          },
          "ran",
        );
        // Renewed while waiting: the lease never went a whole lease-length
        // without a heartbeat naming it, from the claim to the result. The
        // result above was accepted (status 200) under the lease the job was
        // claimed with, so it was never reclaimed.
        heldThroughout({
          beats: run.beats,
          leaseId: run.leaseId,
          claimedAt: run.claimedAt,
          resultAt: run.resultAt,
          leaseMs: target.leaseMs,
        });
      });
    },
  },

  {
    id: "C042_TOOL_CALLS_LOGGED_FIRST",
    title:
      "every tool call's ingress line is written before the call reaches the upstream",
    musts: ["INGRESS_LOGGED_BEFORE_EXECUTION"],
    async run(target: ConformanceTarget): Promise<void> {
      await withStage(target, async (stage) => {
        const run = await stage.run({ script: callsThenAnswers(3) });
        resulted(run);
        expectSame(
          run.loggedFirst,
          [true, true, true],
          "logged before arrival",
        );
        const entries = await stage.entries();
        const lines = entries.filter((e) => e.type === "tool-call");
        assert(
          lines.length === 3,
          `expected 3 tool-call lines, got ${String(lines.length)}`,
        );
        expectMatch(
          lines[0],
          {
            jobId: run.jobId,
            site: run.stub.site,
            name: "lookup",
            arguments: '{"query":"q1"}',
          },
          "the first tool-call line",
        );
        // The outcome line: size and hash, never the content.
        const outcomes = entries.filter((e) => e.type === "tool-outcome");
        assert(
          outcomes.length === 3,
          `expected 3 tool-outcome lines, got ${String(outcomes.length)}`,
        );
        assert(
          !JSON.stringify(outcomes).includes("found lookup"),
          "an outcome line holds a result's content",
        );
        expectMatch(
          outcomes[0],
          { outcome: "answered", chars: 12 },
          "the first tool-outcome line",
        );
      });
    },
  },

  {
    id: "C043_OTHER_KINDS_UNCHANGED",
    title:
      "an llm.chat job on a service with tools on reaches the model with no function declarations",
    // An `llm.chat` job resolves to the chat handler the daemon has baked in,
    // and nothing of another kind's leaks into it — byollm_004 §2's "no
    // prompt-driven tools" as byollm_012 §12 amends it.
    musts: ["KIND_TYPED_ONLY"],
    async run(target: ConformanceTarget): Promise<void> {
      await withStage(target, async (stage) => {
        const run = await stage.run({
          kind: "llm.chat",
          script: () => ({ text: "chatted" }),
        });
        assert(
          run.end.kind === "result",
          "the chat job did not end in a result",
        );
        assert(
          run.requests.length === 1,
          `expected one model request, got ${String(run.requests.length)}`,
        );
        assert(
          run.requests[0]?.tools === undefined,
          "a chat job was sent function declarations",
        );
        assert(
          !JSON.stringify(run.requests[0]).includes("lookup"),
          "a chat job's request names a tool",
        );
      });
    },
  },

  {
    id: "C046_THE_CONTEXT_CAP",
    title:
      "a job is classed by its prompt plus maxToolResultChars, and a result past the cap never reaches the model",
    musts: ["TOOLS_BUDGETED"],
    async run(target: ConformanceTarget): Promise<void> {
      const limits: ToolLimits = {
        maxToolCalls: 8,
        maxToolResultChars: 20_000,
      };
      const PROMPT = "p".repeat(1_000);
      const BIG = "c".repeat(15_000);
      await withStage(target, async (stage) => {
        const run = await stage.run({
          limits,
          prompt: PROMPT,
          site: () => ({ content: BIG }),
          script: (request) =>
            request.tools === undefined
              ? { text: "from the first chapter" }
              : call("lookup", { query: "chapter" }),
        });
        const outcome = resulted(run);

        // Counted in the job's size before it runs, by the party that sizes
        // it: the stub the target handed the daemon is classed by the prompt
        // plus 20,000 — `medium` — where the prompt alone is `small`.
        const whole = payloadTextLength({
          kind: "llm.tools",
          payload: {
            messages: [{ role: "user", content: PROMPT }],
            tools: [LOOKUP],
            purposeLimits: limits,
          },
        });
        assert(
          sizeClassOf(PROMPT.length) === "small",
          "the control: the prompt alone is small",
        );
        assert(
          run.stub.sizeClass === "medium" && sizeClassOf(whole) === "medium",
          `the job was classed "${run.stub.sizeClass}", not by its prompt plus maxToolResultChars`,
        );

        assert(
          run.calls.length === 2,
          `expected 2 calls, got ${String(run.calls.length)}`,
        );
        const last = run.requests.at(-1);
        const turns = toolTurns(last);
        assert(turns[0] === BIG, "the first result did not reach the model");
        assert(
          turns[1] ===
            "Not shown: this job has read all the tool results it may.",
          `the second result's turn was: ${String(turns[1]).slice(0, 80)}`,
        );
        assert(
          JSON.stringify(last).split(BIG).length - 1 === 1,
          "the model was shown the result text more than once",
        );
        assert(
          run.requests.filter((r) => r.tools === undefined).length === 1,
          "not exactly one closing turn",
        );
        assert(last?.tools === undefined, "the last turn offered tools");
        expectMatch(outcomeOf(outcome), { outcome: "ok" }, "outcome");
        expectMatch(
          ranOf(outcome),
          {
            stop: "tool-budget",
            toolCalls: 2,
            toolOutcomes: { answered: 1, errored: 0, timedOut: 0, refused: 1 },
          },
          "ran",
        );
      });
    },
  },
];

import { relative } from "node:path";
import {
  TOOL_LIMITS,
  generateKeys,
  open,
  payloadTextLength,
  publicIdentityOf,
  sizeClassOf,
  type ToolDeclaration,
} from "@byollm/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CLOSING_TURN } from "./tool-loop.js";
import {
  DEFAULT_LIMITS,
  DEVICE_KEYS,
  LOOKUP,
  SITE_ID,
  sealAsSite,
  toolDaemon,
  toolTurns,
  watchTheDevice,
  type Delivery,
  type ModelTurn,
  type ToolsJobOptions,
  type ToolDaemon,
} from "./tools.test.support.js";

/**
 * byollm_012's checks, the daemon's half — C033–C038, C041–C043, C046 (#7055).
 *
 * Each case drives the shipped Runner through a whole `llm.tools` job: the
 * real `openai-http` backend against a model server on loopback, the real
 * client signing every request, an upstream that plays the site with the
 * site's own keys (`tools.test.support.ts` says why it is played). Each is in
 * MUTATIONS.md with the smallest change that must fail it.
 *
 * The MUSTs these verify — TOOLS_RUN_AT_SITE, TOOLS_MATCH_CONSENT,
 * TOOL_ENVELOPES_BOUND, TOOLS_BUDGETED and INGRESS_LOGGED_BEFORE_EXECUTION's
 * tool-call clause — are verified here as the daemon's own suites
 * (`adversarial`); the kit's lift waits on a target that can play the site.
 */

let daemon: ToolDaemon | undefined;
afterEach(async () => {
  await daemon?.dispose();
  daemon = undefined;
});

const call = (name: string, args: unknown): ModelTurn => ({
  calls: [
    { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  ],
});

/** Call `lookup` on the first `n` turns, then answer. */
const callsThenAnswers =
  (n: number, answer = "done") =>
  (_request: unknown, turn: number): ModelTurn =>
    turn <= n
      ? call("lookup", { query: `q${String(turn)}` })
      : { text: answer };

async function ranOk(d: ToolDaemon) {
  const ran = await d.run();
  if (ran.kind !== "result") throw new Error(`refused: ${ran.reason}`);
  return ran.outcome;
}

describe("C033 a tool call leaves sealed — TOOLS_RUN_AT_SITE", () => {
  it("reaches the site as one tool-call envelope only the site can open, signed by the device", async () => {
    const NEEDLE = "a-term-only-the-site-may-read";
    daemon = await toolDaemon({
      script: (_r, turn) =>
        turn === 1 ? call("lookup", { query: NEEDLE }) : { text: "done" },
    });
    const outcome = await ranOk(daemon);

    expect(daemon.envelopes).toHaveLength(1);
    const [envelope] = daemon.envelopes;
    if (envelope === undefined) throw new Error("no envelope");
    // The direction is inside the signature: a call is never a payload.
    expect(envelope.direction).toBe("tool-call");
    // The harness opened it with the site's key, verifying the device's.
    expect(daemon.calls).toHaveLength(1);
    expect(daemon.calls[0]?.name).toBe("lookup");
    // Nothing of the call is readable without the site's key.
    // The bytes the upstream holds carry neither the tool's name nor its
    // arguments (Owl, #55956 point 3): sealed, not merely present.
    expect(JSON.stringify(envelope)).not.toContain(NEEDLE);
    expect(JSON.stringify(envelope)).not.toContain('"lookup"');
    expect(JSON.stringify(envelope)).not.toContain("query");
    expect(daemon.calls[0]?.arguments).toEqual({ query: NEEDLE });
    const stranger = generateKeys(1_800_000_000_000);
    const byStranger = await open({
      envelope,
      recipientKeys: stranger,
      senderIdentityPublic: publicIdentityOf(DEVICE_KEYS).identity,
      expected: {
        jobId: "job_t1",
        senderKeyId: envelope.senderKeyId,
        recipientKeyId: envelope.recipientKeyId,
        direction: "tool-call",
      },
    });
    expect(byStranger.ok).toBe(false);
    // And the job finished on the site's answer.
    expect(outcome.outcome).toMatchObject({ outcome: "ok", text: "done" });
    expect(outcome.ran).toMatchObject({
      toolCalls: 1,
      toolOutcomes: { answered: 1, errored: 0, timedOut: 0, refused: 0 },
    });
  });
});

describe("C034 nothing runs on the device — TOOLS_RUN_AT_SITE", () => {
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
    declared("shell", "Run a shell command on the user's computer.", "command"),
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

  it("spawns nothing, opens no socket but the model's, writes only its own state, and sends all four to the site", async () => {
    daemon = await toolDaemon({
      job: { tools: HOSTILE },
      script: (_r, turn) => {
        const ask = ASKS[turn - 1];
        return ask === undefined ? { text: "done" } : call(ask[0], ask[1]);
      },
    });
    const modelPort = new URL(daemon.model.baseUrl).port;
    const home = daemon.home;
    const watch = watchTheDevice();
    let outcome;
    try {
      outcome = await ranOk(daemon);
    } finally {
      watch.stop();
    }

    expect(watch.spawned).toEqual([]);
    expect(watch.datagrams).toEqual([]);
    // Every socket the job opened went to the owner's model server, which is
    // the one place an `llm.tools` job's text may go besides its site.
    expect(watch.connected.length).toBeGreaterThan(0);
    for (const target of watch.connected) expect(target).toContain(modelPort);
    // Every file written is the daemon's own state; the only one that holds
    // a call's arguments is the ingress log, which is where §9 puts them.
    expect(watch.written.length).toBeGreaterThan(0);
    for (const { path } of watch.written)
      expect(path.startsWith(home)).toBe(true);
    const holding = watch.written
      .filter(
        ({ data }) => data.includes("id_ed25519") || data.includes("rm -rf"),
      )
      .map(({ path }) => relative(home, path));
    expect(new Set(holding)).toEqual(new Set(["ingress.log"]));
    expect(daemon.calls.map((c) => c.name)).toEqual([
      "shell",
      "exec",
      "read_file",
      "fetch",
    ]);
    expect(outcome.ran).toMatchObject({ toolCalls: 4 });
  });
});

describe("C035 tools match consent — TOOLS_MATCH_CONSENT", () => {
  const extra: ToolDeclaration = { ...LOOKUP, name: "lookup_more" };
  const cases: [string, ToolsJobOptions][] = [
    [
      "a payload that adds one tool to the purpose's set",
      {
        tools: [LOOKUP, extra],
        consented: { tools: [LOOKUP], limits: DEFAULT_LIMITS },
      },
    ],
    [
      "a payload that changes a description",
      {
        tools: [{ ...LOOKUP, description: `${LOOKUP.description} And more.` }],
        consented: { tools: [LOOKUP], limits: DEFAULT_LIMITS },
      },
    ],
    [
      "a payload whose purposeLimits raise maxToolCalls from 8 to 20",
      {
        limits: { ...DEFAULT_LIMITS, maxToolCalls: 20 },
        consented: { tools: [LOOKUP], limits: DEFAULT_LIMITS },
      },
    ],
    [
      "a payload whose maxToolCalls is above its purposeLimits",
      { maxToolCalls: 9 },
    ],
  ];

  it.each(cases)(
    "refuses %s at admission; the backend sees nothing",
    async (_name, job) => {
      daemon = await toolDaemon({ job, script: callsThenAnswers(1) });
      const ran = await daemon.run();
      expect(ran.kind).toBe("refused");
      expect(ran.kind === "refused" ? ran.reason : "").toContain(
        "not the ones the person consented to",
      );
      expect(daemon.model.requests).toEqual([]);
      expect(daemon.calls).toEqual([]);
    },
  );

  it("runs the same job when the payload is what the person consented to", async () => {
    // The control: without it, every refusal above could be some other rule.
    daemon = await toolDaemon({ script: callsThenAnswers(1) });
    expect((await ranOk(daemon)).outcome).toMatchObject({ outcome: "ok" });
    expect(daemon.model.requests.length).toBeGreaterThan(0);
  });
});

describe("C036 undeclared or ill-typed calls — TOOLS_MATCH_CONSENT", () => {
  it("answers each with a tool error, sends nothing, and charges all three", async () => {
    const asks = [
      call("delete_everything", { all: true }),
      call("lookup", { query: "fine", sneaky: "extra" }),
      call("lookup", { query: "x".repeat(65) }),
    ];
    daemon = await toolDaemon({
      script: (_r, turn) => asks[turn - 1] ?? { text: "done" },
    });
    const outcome = await ranOk(daemon);

    expect(daemon.calls).toEqual([]);
    expect(daemon.envelopes).toEqual([]);
    expect(outcome.ran).toMatchObject({
      toolCalls: 3,
      toolOutcomes: { answered: 0, errored: 0, timedOut: 0, refused: 3 },
    });
    const last = daemon.model.requests.at(-1);
    if (last === undefined) throw new Error("no request");
    const errors = toolTurns(last);
    expect(errors).toHaveLength(3);
    for (const error of errors)
      expect(error).toMatch(/^Tool error: .*Nothing was sent\.$/);
    expect(errors[0]).toContain("is not one of this job's tools");
    expect(errors[1]).toContain('"sneaky" is not a parameter');
    expect(errors[2]).toContain("at most 64 characters");
  });
});

describe("C037 a result is bound to its call — TOOL_ENVELOPES_BOUND", () => {
  it("drops and logs a stranger's callId, another job's call, a replay and a payload-direction envelope", async () => {
    const MARK = "HOSTILE-RESULT";
    let firstAnswer: Delivery | undefined;
    daemon = await toolDaemon({
      script: callsThenAnswers(2),
      onPoll: async (inject, calls) => {
        const current = calls.at(-1);
        if (current === undefined) return;
        const result = (callId: string, seq: number) =>
          JSON.stringify({ callId, seq, ok: true, content: MARK });
        if (calls.length === 1 && firstAnswer === undefined) {
          firstAnswer = {
            jobId: "job_t1",
            leaseId: "lease_job_t1",
            callId: current.callId,
            envelope: await sealAsSite("job_t1", result(current.callId, 1)),
          };
          inject.push(
            // an unknown callId
            {
              jobId: "job_t1",
              leaseId: "lease_job_t1",
              callId: "AAAAAAAAAAAAAAAAAAAAAA",
              envelope: await sealAsSite(
                "job_t1",
                result("AAAAAAAAAAAAAAAAAAAAAA", 1),
              ),
            },
            // another job's call, labelled as that job
            {
              jobId: "job_other",
              leaseId: "lease_job_t1",
              callId: current.callId,
              envelope: await sealAsSite(
                "job_other",
                result(current.callId, current.seq),
              ),
            },
            // another job's sealed result, labelled as this one
            {
              jobId: "job_t1",
              leaseId: "lease_job_t1",
              callId: current.callId,
              envelope: await sealAsSite(
                "job_other",
                result(current.callId, current.seq),
              ),
            },
            // the right call, in a payload-direction envelope
            {
              jobId: "job_t1",
              leaseId: "lease_job_t1",
              callId: current.callId,
              envelope: await sealAsSite(
                "job_t1",
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
    const outcome = await ranOk(daemon);

    for (const request of daemon.model.requests) {
      expect(JSON.stringify(request)).not.toContain(MARK);
    }
    expect(outcome.ran).toMatchObject({
      toolCalls: 2,
      toolOutcomes: { answered: 2, errored: 0, timedOut: 0, refused: 0 },
    });
    const dropped = (await daemon.entries()).flatMap((e) =>
      e.type === "tool-dropped" ? [e.why] : [],
    );
    expect(dropped).toEqual([
      "a result for no call this job is waiting on",
      "a result labelled for another job",
      "did not open as this job's tool-result from the site it paired with",
      "did not open as this job's tool-result from the site it paired with",
      "a second answer to a call already finished",
    ]);
  });
});

describe("C038 the daemon's budget — TOOLS_BUDGETED", () => {
  it("sends exactly maxToolCalls, then one closing turn with no tools, ok with stop tool-budget", async () => {
    // Two calls a turn, so the third call and the fourth arrive in ONE turn:
    // the budget has to stop the fourth before it is sent, not notice it
    // after (a check that only ran between turns would let it through).
    daemon = await toolDaemon({
      job: { maxToolCalls: 3 },
      script: (request) =>
        request.tools === undefined
          ? { text: "what I have" }
          : {
              calls: [
                { name: "lookup", arguments: '{"query":"again"}' },
                { name: "lookup", arguments: '{"query":"and again"}' },
              ],
            },
    });
    const outcome = await ranOk(daemon);

    expect(daemon.calls).toHaveLength(3);
    // The fourth was answered without being made, so the conversation stays
    // whole for the model server.
    expect(toolTurns(daemon.model.requests.at(-1) ?? { messages: [] })).toEqual(
      [
        "found lookup",
        "found lookup",
        "found lookup",
        "Not run: this job's tools are spent.",
      ],
    );
    const closing = daemon.model.requests.at(-1);
    expect(closing?.tools).toBeUndefined();
    expect(closing?.messages.at(-1)).toEqual({
      role: "user",
      content: CLOSING_TURN,
    });
    expect(
      daemon.model.requests.filter((r) => r.tools === undefined),
    ).toHaveLength(1);
    expect(outcome.outcome).toMatchObject({
      outcome: "ok",
      text: "what I have",
    });
    expect(outcome.ran).toMatchObject({ stop: "tool-budget", toolCalls: 3 });
  });
});

describe("C038 the daemon's budget, spent on a turn's last call — TOOLS_BUDGETED", () => {
  it("goes straight to the closing turn: the model is never offered tools again", async () => {
    // Two calls a turn and a budget of two, so the budget runs out on the
    // LAST call of the first turn, and nothing in that turn is left over for
    // the pre-call check to stop. Only the post-call check knows the job is
    // at its limit; without it the model is asked once more WITH tools — a
    // turn charged to the daily budgets for calls that can never be made
    // (Owl, #55998 fix 2).
    daemon = await toolDaemon({
      job: { maxToolCalls: 2 },
      script: (request) =>
        request.tools === undefined
          ? { text: "what I have" }
          : {
              calls: [
                { name: "lookup", arguments: '{"query":"one"}' },
                { name: "lookup", arguments: '{"query":"two"}' },
              ],
            },
    });
    const outcome = await ranOk(daemon);

    expect(daemon.calls).toHaveLength(2);
    // Two model turns: the one that spent the budget, and the closing turn.
    expect(daemon.model.requests).toHaveLength(2);
    expect(daemon.model.requests[0]?.tools).toBeDefined();
    const closing = daemon.model.requests[1];
    expect(closing?.tools).toBeUndefined();
    expect(closing?.messages.at(-1)).toEqual({
      role: "user",
      content: CLOSING_TURN,
    });
    // Nothing was answered "spent": no call was asked for past the budget.
    expect(toolTurns(closing ?? { messages: [] })).toEqual([
      "found lookup",
      "found lookup",
    ]);
    expect(outcome.ran).toMatchObject({ stop: "tool-budget", toolCalls: 2 });
  });

  it("does the same when the call that spends it is refused, not sent", async () => {
    // A refused call is charged (§5.3), and the refusal's path used to skip
    // the post-call check: this turn's second call, undeclared, spent the
    // budget and the model was offered tools again.
    daemon = await toolDaemon({
      job: { maxToolCalls: 2 },
      script: (request) =>
        request.tools === undefined
          ? { text: "what I have" }
          : {
              calls: [
                { name: "lookup", arguments: '{"query":"one"}' },
                { name: "shell", arguments: '{"command":"id"}' },
              ],
            },
    });
    const outcome = await ranOk(daemon);

    expect(daemon.calls).toHaveLength(1);
    expect(daemon.model.requests).toHaveLength(2);
    expect(daemon.model.requests[1]?.tools).toBeUndefined();
    expect(outcome.ran).toMatchObject({
      stop: "tool-budget",
      toolCalls: 2,
      toolOutcomes: { answered: 1, refused: 1 },
    });
  });
});

describe("C041 a site that does not answer — TOOLS_BUDGETED", () => {
  it("gives the model a tool error after TOOL_CALL_TIMEOUT, ends ok, and holds the lease throughout", async () => {
    daemon = await toolDaemon({
      job: { deadlineMs: 5 * 60_000 },
      site: () => "silent",
      script: (request) =>
        toolTurns(request).length === 0
          ? call("lookup", { query: "anyone?" })
          : { text: "answered without it" },
    });
    const started = daemon.clock.now;
    const outcome = await ranOk(daemon);
    const waited = daemon.clock.now - started;

    // At the timeout, not at the deadline.
    expect(waited).toBeGreaterThanOrEqual(TOOL_LIMITS.callTimeoutMs);
    expect(waited).toBeLessThan(TOOL_LIMITS.callTimeoutMs + 5_000);
    expect(toolTurns(daemon.model.requests.at(-1) ?? { messages: [] })).toEqual(
      ["The site did not answer in time."],
    );
    expect(outcome.outcome).toMatchObject({ outcome: "ok" });
    expect(outcome.ran).toMatchObject({
      toolCalls: 1,
      toolOutcomes: { answered: 0, errored: 0, timedOut: 1, refused: 0 },
    });
    // Renewed while waiting: every heartbeat during the wait named the lease,
    // and none was further apart than a lease is long.
    const during = daemon.beats.filter((b) => b.at > started);
    expect(during.length).toBeGreaterThanOrEqual(
      TOOL_LIMITS.callTimeoutMs / 1_000 - 1,
    );
    for (const beat of during) expect(beat.leases).toEqual(["lease_job_t1"]);
    const gaps = during.slice(1).map((b, i) => b.at - (during[i]?.at ?? b.at));
    expect(Math.max(...gaps)).toBeLessThan(60_000);
  });
});

describe("C042 calls logged first — INGRESS_LOGGED_BEFORE_EXECUTION", () => {
  it("has every call's ingress line written before the call reaches the site", async () => {
    daemon = await toolDaemon({ script: callsThenAnswers(3) });
    await ranOk(daemon);
    expect(daemon.loggedFirst).toEqual([true, true, true]);
    const entries = await daemon.entries();
    const lines = entries.filter((e) => e.type === "tool-call");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      jobId: "job_t1",
      site: SITE_ID,
      name: "lookup",
      arguments: '{"query":"q1"}',
    });
    // The outcome line: size and hash, never the content.
    const outcomes = entries.filter((e) => e.type === "tool-outcome");
    expect(outcomes).toHaveLength(3);
    expect(JSON.stringify(outcomes)).not.toContain("found lookup");
    expect(outcomes[0]).toMatchObject({ outcome: "answered", chars: 12 });
  });
});

describe("C043 other kinds unchanged", () => {
  it("sends an llm.chat job on a service with tools on with no function declarations", async () => {
    daemon = await toolDaemon({
      job: { kind: "llm.chat" },
      script: () => ({ text: "chatted" }),
    });
    const ran = await daemon.run();
    expect(ran.kind).toBe("result");
    expect(daemon.model.requests).toHaveLength(1);
    expect(daemon.model.requests[0]?.tools).toBeUndefined();
    expect(JSON.stringify(daemon.model.requests[0])).not.toContain("lookup");
  });
});

describe("C046 the context cap — TOOLS_BUDGETED", () => {
  const limits = { maxToolCalls: 8, maxToolResultChars: 20_000 };

  it("is counted in the job's size before it runs", () => {
    const payload = {
      messages: [{ role: "user" as const, content: "x".repeat(10_000) }],
      tools: [LOOKUP],
      purposeLimits: limits,
    };
    const chars = payloadTextLength({ kind: "llm.tools", payload });
    expect(chars).toBe(10_000 + 20_000);
    // Classed by its whole possible context, not by its prompt alone.
    expect(sizeClassOf(10_000)).toBe("medium");
    expect(sizeClassOf(chars)).toBe("medium");
  });

  it("hands the model the first 15,000-character result and not the second", async () => {
    const BIG = "c".repeat(15_000);
    daemon = await toolDaemon({
      job: { limits },
      site: () => ({ content: BIG }),
      script: (request) =>
        request.tools === undefined
          ? { text: "from the first chapter" }
          : call("lookup", { query: "chapter" }),
    });
    const outcome = await ranOk(daemon);

    expect(daemon.calls).toHaveLength(2);
    const last = daemon.model.requests.at(-1);
    if (last === undefined) throw new Error("no request");
    const turns = toolTurns(last);
    expect(turns[0]).toBe(BIG);
    expect(turns[1]).toBe(
      "Not shown: this job has read all the tool results it may.",
    );
    expect(JSON.stringify(last).split(BIG).length - 1).toBe(1);
    expect(
      daemon.model.requests.filter((r) => r.tools === undefined),
    ).toHaveLength(1);
    expect(last.tools).toBeUndefined();
    expect(outcome.outcome).toMatchObject({ outcome: "ok" });
    expect(outcome.ran).toMatchObject({
      stop: "tool-budget",
      toolCalls: 2,
      toolOutcomes: { answered: 1, errored: 0, timedOut: 0, refused: 1 },
    });
  });
});

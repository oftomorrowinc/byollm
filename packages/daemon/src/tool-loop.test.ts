import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SealedEnvelope, ToolDeclaration } from "@byollm/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type {
  Backend,
  ConverseRequest,
  ConverseResult,
} from "./backends/types.js";
import { IngressLog } from "./ingress.js";
import { removeTemp } from "./test-support.js";
import { runToolLoop, type ToolLoopInput } from "./tool-loop.js";
import { probeTools } from "./tools-probe.js";
import { predatesMessage } from "./upstream-predates.js";

/**
 * The loop's own edges, driven directly — the paths a whole-daemon check
 * (`tools-at-the-site.test.ts`) reaches only by accident: a site's error, a
 * call the upstream would not take, a deadline mid-loop, a cancel, a model
 * whose arguments are not an object, results that do not open.
 */

const LOOKUP: ToolDeclaration = {
  name: "lookup",
  description: "Look a term up.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", maxLength: 64 } },
  },
};

const ENVELOPE = {
  ciphertext: "x",
  deadlineAt: 1,
  direction: "tool-result",
  recipientKeyId: "d",
  senderKeyId: "s",
} as unknown as SealedEnvelope;

/** The same backend, as one that cannot carry tools. */
function withoutConverse(backend: Backend): Backend {
  const rest: Partial<Backend> = { ...backend };
  delete rest.converse;
  return rest as Backend;
}

/** A backend that answers each turn from a list. */
function scripted(
  turns: ConverseResult[],
  seen: ConverseRequest[] = [],
): Backend {
  return {
    id: "openai-http",
    class: "http",
    stopReasons: { kind: "unavailable", why: "a test double" },
    health: () => Promise.resolve({ healthy: true, models: [] }),
    execute: () => Promise.reject(new Error("not used")),
    converse: (request) => {
      seen.push(request);
      const next = turns.shift();
      return Promise.resolve(
        next ?? {
          ok: true,
          text: "done",
          toolCalls: [],
          stop: "end",
          durationMs: 0,
        },
      );
    },
  };
}

const calls = (...args: string[]): ConverseResult => ({
  ok: true,
  text: "",
  toolCalls: args.map((a, i) => ({
    id: `c${String(i)}`,
    name: "lookup",
    arguments: a,
  })),
  stop: "unknown",
  durationMs: 0,
});

function input(
  over: Partial<ToolLoopInput> & { backend: Backend },
): ToolLoopInput {
  let now = 1_000;
  const dropped: string[] = [];
  return {
    model: "m",
    jobId: "job",
    prompt: "hi",
    declarations: [LOOKUP],
    budget: 8,
    maxResultChars: 1_000,
    turnCeilingMs: 60_000,
    maxOutputBytes: 1_000_000,
    deadlineAt: 10_000_000,
    signal: new AbortController().signal,
    now: () => now,
    wait: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    transport: {
      send: () => Promise.resolve(),
      poll: () => Promise.resolve([]),
    },
    seal: () => Promise.resolve(ENVELOPE),
    open: () => Promise.resolve(null),
    log: {
      call: () => Promise.resolve(),
      outcome: () => Promise.resolve(),
      dropped: (e) => {
        dropped.push(e.why);
        return Promise.resolve();
      },
    },
    ...over,
  };
}

/** A transport whose site answers every call with `answer(callId, seq)`. */
function answering(answer: (callId: string, seq: number) => string) {
  let last: { callId: string; seq: number } | undefined;
  let seq = 0;
  return {
    transport: {
      send: (call: { callId: string }) => {
        seq += 1;
        last = { callId: call.callId, seq };
        return Promise.resolve();
      },
      poll: () =>
        Promise.resolve(
          last === undefined
            ? []
            : [{ jobId: "job", callId: last.callId, envelope: ENVELOPE }],
        ),
    },
    open: () =>
      Promise.resolve(
        last === undefined ? null : answer(last.callId, last.seq),
      ),
  };
}

describe("the tool loop's edges", () => {
  it("counts a site's error as errored and tells the model", async () => {
    const seen: ConverseRequest[] = [];
    const site = answering((callId, seq) =>
      JSON.stringify({ callId, seq, ok: false, error: "rate limited" }),
    );
    const run = await runToolLoop(
      input({ backend: scripted([calls('{"query":"a"}')], seen), ...site }),
    );
    expect(run.toolOutcomes).toEqual({
      answered: 0,
      errored: 1,
      timedOut: 0,
      refused: 0,
    });
    expect(JSON.stringify(seen.at(-1)?.messages)).toContain(
      "Tool error from the site: rate limited",
    );
  });

  it("counts a call the upstream would not take as timed out, never as sent", async () => {
    const run = await runToolLoop(
      input({
        backend: scripted([calls('{"query":"a"}')]),
        transport: {
          send: () => Promise.reject(new Error("404")),
          poll: () => Promise.reject(new Error("unused")),
        },
      }),
    );
    expect(run.toolOutcomes.timedOut).toBe(1);
    expect(run.result.ok).toBe(true);
  });

  it("keeps waiting through a failed poll", async () => {
    let polls = 0;
    const site = answering((callId, seq) =>
      JSON.stringify({ callId, seq, ok: true, content: "fine" }),
    );
    const run = await runToolLoop(
      input({
        backend: scripted([calls('{"query":"a"}')]),
        ...site,
        transport: {
          send: site.transport.send,
          poll: () => {
            polls += 1;
            return polls === 1
              ? Promise.reject(new Error("blip"))
              : site.transport.poll();
          },
        },
      }),
    );
    expect(run.toolOutcomes.answered).toBe(1);
  });

  it.each([
    ["not JSON", "{nope"],
    ["not an object", "[1,2]"],
    ["too large", JSON.stringify({ query: "x".repeat(70_000) })],
  ])("refuses arguments that are %s", async (_why, args) => {
    const run = await runToolLoop(input({ backend: scripted([calls(args)]) }));
    expect(run.toolOutcomes.refused).toBe(1);
  });

  it.each([
    ["not JSON", () => "{nope", "the result is not JSON"],
    [
      "not a tool result",
      () => JSON.stringify({ hello: 1 }),
      "the result is not a tool result",
    ],
    [
      "a different call",
      (callId: string) =>
        JSON.stringify({ callId, seq: 9, ok: true, content: "x" }),
      "the sealed result names a different call",
    ],
  ])("drops a result that is %s", async (_name, make, why) => {
    const dropped: string[] = [];
    const site = answering((callId) => make(callId));
    const base = input({
      backend: scripted([calls('{"query":"a"}')]),
      ...site,
    });
    const run = await runToolLoop({
      ...base,
      log: {
        ...base.log,
        dropped: (e) => {
          dropped.push(e.why);
          return Promise.resolve();
        },
      },
    });
    expect(dropped[0]).toBe(why);
    expect(run.toolOutcomes.timedOut).toBe(1);
  });

  it("fails with the backend's own failure, mid-loop or at the closing turn", async () => {
    const failure: ConverseResult = {
      ok: false,
      code: "backend-unreachable",
      message: "down",
      durationMs: 0,
    };
    const midway = await runToolLoop(input({ backend: scripted([failure]) }));
    expect(midway.result).toMatchObject({
      ok: false,
      code: "backend-unreachable",
    });

    const site = answering((callId, seq) =>
      JSON.stringify({ callId, seq, ok: true, content: "x" }),
    );
    const closing = await runToolLoop(
      input({
        backend: scripted([calls('{"query":"a"}'), failure]),
        budget: 1,
        ...site,
      }),
    );
    expect(closing.result).toMatchObject({
      ok: false,
      code: "backend-unreachable",
    });
    expect(closing.toolCalls).toBe(1);
  });

  it("stops at the job's deadline, before a turn and during one's tools", async () => {
    const past = await runToolLoop(
      input({ backend: scripted([]), deadlineAt: 0 }),
    );
    expect(past.result).toMatchObject({ ok: false, code: "timeout" });

    const during = await runToolLoop(
      input({ backend: scripted([calls('{"query":"a"}')]), deadlineAt: 3_000 }),
    );
    expect(during.toolOutcomes.timedOut).toBe(1);
    expect(during.result).toMatchObject({ ok: false, code: "timeout" });
  });

  it("ends canceled when the job is cancelled while it waits", async () => {
    const controller = new AbortController();
    const run = await runToolLoop(
      input({
        backend: scripted([calls('{"query":"a"}')]),
        signal: controller.signal,
        wait: () => {
          controller.abort();
          return Promise.resolve();
        },
      }),
    );
    expect(run.result).toMatchObject({ ok: false, code: "canceled" });
  });

  it("refuses to run on a backend that cannot carry tools", async () => {
    const backend = scripted([]);
    const run = await runToolLoop(input({ backend: withoutConverse(backend) }));
    expect(run.result).toMatchObject({ ok: false, code: "backend-error" });
  });
});

describe("the probe's verdicts", () => {
  const turn = (
    over: Partial<Extract<ConverseResult, { ok: true }>>,
  ): ConverseResult => ({
    ok: true,
    text: "",
    toolCalls: [],
    stop: "end",
    durationMs: 0,
    ...over,
  });
  const echo = (args: string, name = "echo_number") => ({
    toolCalls: [{ id: "p", name, arguments: args }],
  });

  it.each([
    ["no converse", undefined, "cannot"],
    [
      "a server that does not answer",
      [{ ok: false, code: "timeout", message: "slow", durationMs: 0 }],
      "unanswered",
    ],
    ["a call with the wrong number", [turn(echo('{"n":8}'))], "cannot"],
    ["a call that is not JSON", [turn(echo("{"))], "cannot"],
    ["a call to something else", [turn(echo('{"n":7}', "other"))], "cannot"],
    [
      "a result it ignored",
      [turn(echo('{"n":7}')), turn({ text: "7" })],
      "cannot",
    ],
    [
      "a server that stops answering",
      [
        turn(echo('{"n":7}')),
        { ok: false, code: "timeout", message: "slow", durationMs: 0 },
      ],
      "unanswered",
    ],
    [
      "a model that uses it",
      [turn(echo('{"n":7}')), turn({ text: "4091" })],
      "calls-tools",
    ],
  ] as [string, ConverseResult[] | undefined, string][])(
    "%s",
    async (_name, turns, kind) => {
      const backend = scripted(turns ?? []);
      const probed = await probeTools(
        turns === undefined ? withoutConverse(backend) : backend,
        "m",
      );
      expect(probed.kind).toBe(kind);
    },
  );
});

describe("what guard (b) says", () => {
  it("names images, and both, as well as tools", () => {
    expect(
      predatesMessage({
        upstream: "u",
        kinds: ["llm.vision"],
        services: ["v"],
      }),
    ).toBe(
      "u runs byollm 0.1.4 or older and cannot carry images — update it, or turn images off for `v`",
    );
    expect(
      predatesMessage({
        upstream: "u",
        kinds: ["llm.tools", "llm.image"],
        services: ["a", "b"],
      }),
    ).toContain(
      "cannot carry the site's tools or images — update it, or turn tools and images off for `a`, `b`",
    );
  });
});

describe("a tool call's arguments in the ingress log — byollm_012 §9", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await removeTemp(dir);
  });

  it("keeps them as prompts are kept, and drops a teammate's after the retention window", async () => {
    dir = await mkdtemp(join(tmpdir(), "byollm-tool-log-"));
    const log = new IngressLog({
      path: join(dir, "i.log"),
      communityPromptDays: 1,
      keepSelfPrompts: false,
    });
    const at = 1_000_000;
    const call = {
      at,
      jobId: "j",
      callId: "c",
      seq: 1,
      name: "lookup",
      arguments: '{"q":1}',
    };
    await log.recordToolCall({ ...call, audience: "private" });
    await log.recordToolCall({ ...call, audience: "team", site: "s" });
    await log.recordToolDropped({ at, jobId: "j", why: "a stranger" });
    await log.recordToolOutcome({
      at,
      jobId: "j",
      callId: "c",
      seq: 1,
      outcome: "timedOut",
    });
    let entries = await log.read();
    // The owner opted out of keeping their own prompts, so their arguments go too.
    expect(entries[0]).not.toHaveProperty("arguments");
    expect(entries[1]).toMatchObject({ arguments: '{"q":1}' });

    expect(await log.applyRetention(at + 2 * 86_400_000)).toBe(1);
    entries = await log.read();
    expect(entries[1]).not.toHaveProperty("arguments");
    expect(entries[1]).toMatchObject({ argumentsChars: 7 });
    expect(entries.map((e) => e.type)).toEqual([
      "tool-call",
      "tool-call",
      "tool-dropped",
      "tool-outcome",
    ]);
  });
});

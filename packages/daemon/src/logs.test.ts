import { createHash } from "node:crypto";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { IngressLog } from "./ingress.js";
import { LogRenderer, redact, standing } from "./logs.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { removeTemp } from "./test-support.js";

/**
 * `byollm logs` — #9547. What a device did with a job, read at its own
 * console: box-1 claimed a roll's proof job and never answered, and the only
 * way to see it was `kubectl exec … grep` on this file.
 */
let home: string;
let paths: DaemonPaths;
let log: IngressLog;
let out: string;
let err: string;

const io = (): Partial<CliIo> => ({
  out: (text) => {
    out += text;
  },
  err: (text) => {
    err += text;
  },
  confirm: () => Promise.resolve(false),
});

const SITE = "https://hub.byo-llm.com";
const T0 = Date.parse("2026-11-18T14:02:09Z");
const SOMEONE_ELSES_PROMPT = "Summarise my medical notes from Tuesday";

/** A job that ran and answered, and one that started and never did. */
async function writeTwoJobs(): Promise<void> {
  await log.recordClaim({
    at: T0,
    jobId: "5e0a7c21-3b7d-4c55-9a51-0d3f6b1e2a90",
    site: SITE,
    kind: "chat",
    audience: "team",
  });
  await log.recordPrompt({
    at: T0 + 2_000,
    origin: SITE,
    jobId: "5e0a7c21-3b7d-4c55-9a51-0d3f6b1e2a90",
    site: SITE,
    kind: "chat",
    audience: "team",
    owner: "lis",
    backendId: "claude",
    backendClass: "subscription",
    model: "claude-sonnet-5-5",
    prompt: SOMEONE_ELSES_PROMPT,
  });
  await log.recordOutcome({
    at: T0 + 14_400,
    jobId: "5e0a7c21-3b7d-4c55-9a51-0d3f6b1e2a90",
    site: SITE,
    outcome: "ok",
    durationMs: 12_400,
    outputChars: 3_201,
  });
  await log.recordClaim({
    at: T0 + 60_000,
    jobId: "911c5d84-60e2-4a3b-8f0e-7d1c2b9a4e11",
    site: SITE,
    kind: "chat",
    audience: "team",
  });
  await log.recordPrompt({
    at: T0 + 61_000,
    origin: SITE,
    jobId: "911c5d84-60e2-4a3b-8f0e-7d1c2b9a4e11",
    site: SITE,
    kind: "chat",
    audience: "team",
    owner: "todd",
    backendId: "claude",
    backendClass: "subscription",
    model: "claude-sonnet-5-5",
    prompt: "the roll's proof prompt",
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-logs-"));
  paths = daemonPaths(home);
  log = new IngressLog({
    path: paths.ingressLog,
    communityPromptDays: 7,
    keepSelfPrompts: true,
  });
  out = "";
  err = "";
});

afterEach(async () => {
  vi.useRealTimers();
  await removeTemp(home);
});

describe("byollm logs --job", () => {
  it("says a job that finished was answered", async () => {
    await writeTwoJobs();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0 + 61_000 + 412_000);

    const code = await runCli(["logs", "--job", "5e0a7c21"], {
      paths,
      io: io(),
    });

    expect(code).toBe(0);
    expect(out).toBe(
      `job 5e0a7c21-3b7d-4c55-9a51-0d3f6b1e2a90 from ${SITE}\n` +
        `${paths.ingressLog} — times UTC, newest last\n` +
        `2026-11-18 14:02:09  5e0a7c21  chat    -        claimed — a team job from hub.byo-llm.com\n` +
        `2026-11-18 14:02:11  5e0a7c21  chat    claude   started on claude-sonnet-5-5 — a team prompt of 39 chars, not shown (sha256 ${hashPrefix(SOMEONE_ELSES_PROMPT)}…)\n` +
        `2026-11-18 14:02:23  5e0a7c21  chat    claude   answered in 12 s, 3201 chars\n` +
        `\n` +
        `where it stands: answered at 2026-11-18 14:02:23, in 12 s\n`,
    );
  });

  it("says a job that started and never answered has had no result for N seconds", async () => {
    await writeTwoJobs();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0 + 61_000 + 412_000);

    const code = await runCli(["logs", "--job", "911c5d84"], {
      paths,
      io: io(),
    });

    expect(code).toBe(0);
    expect(out).toBe(
      `job 911c5d84-60e2-4a3b-8f0e-7d1c2b9a4e11 from ${SITE}\n` +
        `${paths.ingressLog} — times UTC, newest last\n` +
        `2026-11-18 14:03:09  911c5d84  chat    -        claimed — a team job from hub.byo-llm.com\n` +
        `2026-11-18 14:03:10  911c5d84  chat    claude   started on claude-sonnet-5-5 — a team prompt of 23 chars, not shown (sha256 ${hashPrefix("the roll's proof prompt")}…)\n` +
        `\n` +
        `where it stands: started at 2026-11-18 14:03:10 and no result after 412 s (6 min)\n`,
    );
  });

  it("says a job that was claimed and never started is exactly that", async () => {
    await log.recordClaim({
      at: T0,
      jobId: "c1a1",
      site: SITE,
      kind: "embed",
      audience: "private",
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0 + 30_000);

    await runCli(["logs", "--job=c1"], { paths, io: io() });

    expect(out).toContain("claimed — your own job from hub.byo-llm.com");
    expect(out).toContain(
      "where it stands: claimed at 2026-11-18 14:02:09 and not started: no prompt line after 30 s",
    );
  });

  it("says a failure, and why, without the key a vendor echoed into it", async () => {
    await log.recordPrompt({
      at: T0,
      origin: SITE,
      jobId: "f00d",
      site: SITE,
      kind: "chat",
      audience: "private",
      owner: "me",
      backendId: "openai",
      backendClass: "metered",
      model: "gpt",
      prompt: "hello",
    });
    await log.recordOutcome({
      at: T0 + 3_100,
      jobId: "f00d",
      site: SITE,
      outcome: "error",
      durationMs: 3_100,
      detail: "401 invalid api key sk-proj-abcdefghijklmnop1234 for this org",
    });

    await runCli(["logs", "--job", "f00d"], { paths, io: io() });

    expect(out).toContain(
      "where it stands: failed at 2026-11-18 14:02:12 after 3.1 s — 401 invalid api key [redacted key] for this org",
    );
    expect(out).not.toContain("sk-proj");
  });

  it("asks for more of the id when a prefix names two jobs", async () => {
    for (const jobId of ["abc1", "abc2"]) {
      await log.recordClaim({
        at: T0,
        jobId,
        site: SITE,
        kind: "chat",
        audience: "team",
      });
    }

    expect(await runCli(["logs", "--job", "abc"], { paths, io: io() })).toBe(2);
    expect(err).toBe(
      `2 jobs in this device's log start "abc" — give more of the id:\n` +
        `  abc1  from ${SITE}\n` +
        `  abc2  from ${SITE}\n`,
    );
    /* The whole id is never ambiguous, even when it prefixes another. */
    expect(await runCli(["logs", "--job", "abc1"], { paths, io: io() })).toBe(
      0,
    );
  });

  it("says when no line names the job", async () => {
    await writeTwoJobs();
    expect(await runCli(["logs", "--job", "abc"], { paths, io: io() })).toBe(1);
    expect(out).toContain(
      `no line in this device's log names a job starting "abc"`,
    );
  });
});

describe("byollm logs", () => {
  it("prints the most recent events, newest last, and never a prompt", async () => {
    await writeTwoJobs();

    expect(await runCli(["logs", "--tail", "2"], { paths, io: io() })).toBe(0);

    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe(`${paths.ingressLog} — times UTC, newest last`);
    expect(lines.slice(1)).toHaveLength(2);
    expect(lines[1]).toContain("911c5d84  chat    -        claimed");
    expect(lines[2]).toContain("911c5d84  chat    claude   started");

    out = "";
    await runCli(["logs"], { paths, io: io() });
    expect(out.trimEnd().split("\n")).toHaveLength(1 + 5);
    /* Somebody else's prompt is still in the file — it is inside its 7 days
       — and this screen shows none of it. */
    expect(out).not.toContain(SOMEONE_ELSES_PROMPT);
    expect(out).not.toContain("proof prompt");
  });

  it("says the log is empty rather than printing nothing", async () => {
    expect(await runCli(["logs"], { paths, io: io() })).toBe(0);
    expect(out).toContain("nothing in this device's log yet");
  });

  it("refuses arguments it has no use for", async () => {
    expect(await runCli(["logs", "--tail", "lots"], { paths, io: io() })).toBe(
      2,
    );
    expect(err).toContain("--tail takes a number of lines");
    err = "";
    expect(await runCli(["logs", "--grep", "x"], { paths, io: io() })).toBe(2);
    expect(err).toContain(`byollm logs does not know "--grep"`);
    err = "";
    expect(await runCli(["logs", "--job"], { paths, io: io() })).toBe(2);
    expect(err).toContain("--job needs a value");
  });

  it("--follow prints what is appended, and --job --follow stops at the result", async () => {
    await writeTwoJobs();
    const stop = new AbortController();
    const following = runCli(["logs", "--job", "911c", "--follow"], {
      paths,
      io: io(),
      signal: stop.signal,
    });
    await vi.waitFor(() => {
      expect(out).toContain("following — Ctrl-C to stop");
    });
    /* Half a line first: --follow must wait for the rest, not drop it. */
    const outcome = JSON.stringify({
      type: "outcome",
      at: T0 + 90_000,
      jobId: "911c5d84-60e2-4a3b-8f0e-7d1c2b9a4e11",
      site: SITE,
      outcome: "ok",
      durationMs: 29_000,
    });
    await appendFile(paths.ingressLog, outcome.slice(0, 20));
    await new Promise((resolve) => setTimeout(resolve, 400));
    await appendFile(paths.ingressLog, `${outcome.slice(20)}\n`);

    expect(await following).toBe(0);
    expect(out).toContain("911c5d84  chat    claude   answered in 29 s");
    expect(out.trimEnd().split("\n").at(-1)).toBe(
      "where it stands: answered at 2026-11-18 14:03:39, in 29 s",
    );
    stop.abort();
  });

  it("--follow without --job runs until it is stopped", async () => {
    const stop = new AbortController();
    const following = runCli(["logs", "-f"], {
      paths,
      io: io(),
      signal: stop.signal,
    });
    await vi.waitFor(() => {
      expect(out).toContain("following");
    });
    await writeTwoJobs();
    await vi.waitFor(() => {
      expect(out).toContain("911c5d84  chat    claude   started");
    });
    stop.abort();
    expect(await following).toBe(0);
  });
});

describe("every kind of line", () => {
  it("has words for each event the log can hold", () => {
    const r = new LogRenderer({});
    const at = T0;
    const rows = [
      r.render({
        type: "claim",
        at,
        jobId: "j1",
        kind: "chat",
        audience: "private",
      }),
      r.render({
        type: "prompt",
        at,
        origin: SITE,
        jobId: "j1",
        kind: "chat",
        audience: "private",
        owner: "me",
        backendId: "ollama",
        backendClass: "local",
        model: "llama",
        promptHash: "a".repeat(64),
        promptChars: 5,
      }),
      r.render({
        type: "memory",
        at,
        jobId: "j1",
        backendId: "ollama",
        admit: false,
        why: "2 GB floor",
        pressure: "warn",
      }),
      r.render({
        type: "memory",
        at,
        backendId: "ollama",
        admit: true,
        why: "fits",
        pressure: "normal",
      }),
      r.render({
        type: "tool-call",
        at,
        jobId: "j1",
        audience: "private",
        callId: "c",
        seq: 1,
        name: "search",
        argumentsHash: "b".repeat(64),
        argumentsChars: 40,
        arguments: "SECRET ARGS",
      }),
      r.render({
        type: "tool-outcome",
        at,
        jobId: "j1",
        callId: "c",
        seq: 1,
        outcome: "answered",
        chars: 9,
        contentHash: "c".repeat(64),
      }),
      r.render({
        type: "tool-outcome",
        at,
        jobId: "j1",
        callId: "c",
        seq: 2,
        outcome: "errored",
        detail: "boom",
      }),
      r.render({ type: "tool-dropped", at, jobId: "j1", why: "replay" }),
      r.render({
        type: "outcome",
        at,
        jobId: "j1",
        outcome: "canceled",
        durationMs: 7_300_000,
        detail: "owner stopped it",
      }),
      r.render({
        type: "outcome",
        at,
        jobId: "j2",
        outcome: "refused",
        detail: "hourly cap",
      }),
      r.render({ type: "outcome", at, jobId: "j3", outcome: "ok" }),
    ].map((row) => row.slice(21));
    expect(rows).toEqual([
      "j1        chat    -        claimed — your own job",
      "j1        chat    ollama   started on llama — your prompt of 5 chars, not shown (sha256 aaaaaaaaaaaa…, text no longer kept)",
      "j1        chat    ollama   memory REFUSED the job: 2 GB floor (pressure warn)",
      "-         -       ollama   memory admitted the job: fits (pressure normal)",
      "j1        chat    ollama   tool call 1 asked for search — arguments not shown (40 chars)",
      "j1        chat    ollama   tool call 1 answered, 9 chars",
      "j1        chat    ollama   tool call 2 errored: boom",
      "j1        chat    ollama   tool result dropped: replay",
      "j1        chat    ollama   canceled after 7300 s (2 h 1 min): owner stopped it",
      "j2        -       -        refused: hourly cap",
      "j3        -       -        answered",
    ]);
  });

  it("stands each way a job can end, and says when a job was taken more than once", () => {
    const base = { at: T0, jobId: "j" } as const;
    const prompt = {
      ...base,
      type: "prompt",
      origin: SITE,
      kind: "chat",
      audience: "team",
      owner: "o",
      backendId: "b",
      backendClass: "c",
      model: "m",
      promptHash: "a".repeat(64),
      promptChars: 1,
    } as const;
    expect(standing([], T0, {}).text).toContain("nothing recorded yet");
    expect(
      standing(
        [prompt, prompt, { ...base, type: "outcome", outcome: "refused" }],
        T0,
        {},
      ).text,
    ).toBe("refused at 2026-11-18 14:02:09 (started 2 times)");
    expect(
      standing(
        [
          {
            ...base,
            type: "outcome",
            outcome: "canceled",
            durationMs: 500,
            detail: "x",
          },
        ],
        T0,
        {},
      ).text,
    ).toBe("canceled at 2026-11-18 14:02:09 after 0.5 s — x");
    expect(
      standing([{ ...base, type: "outcome", outcome: "ok" }], T0, {}).text,
    ).toBe("answered at 2026-11-18 14:02:09");
  });
});

describe("--follow, the edges", () => {
  it("waits for a job that has not arrived yet, and survives the log being rewritten smaller", async () => {
    await writeTwoJobs();
    const stop = new AbortController();
    const following = runCli(["logs", "--job", "77aa", "-f"], {
      paths,
      io: io(),
      signal: stop.signal,
    });
    await vi.waitFor(() => {
      expect(out).toContain(`waiting for a job starting "77aa"`);
    });
    /* Retention rewrites the file shorter; what is there was already seen. */
    await writeFile(paths.ingressLog, "");
    await new Promise((resolve) => setTimeout(resolve, 400));
    await log.recordClaim({
      at: T0,
      jobId: "77aa01",
      site: SITE,
      kind: "chat",
      audience: "team",
    });
    await log.recordOutcome({
      at: T0 + 1_000,
      jobId: "77aa01",
      site: SITE,
      outcome: "refused",
      detail: "full",
    });

    expect(await following).toBe(0);
    expect(out).toContain(`job 77aa01 from ${SITE}`);
    expect(out.trimEnd().split("\n").at(-1)).toBe(
      "where it stands: refused at 2026-11-18 14:02:10 — full",
    );
    stop.abort();
  });

  it("follows a log that does not exist yet", async () => {
    const stop = new AbortController();
    const following = runCli(["logs", "--follow"], {
      paths,
      io: io(),
      signal: stop.signal,
    });
    await vi.waitFor(() => {
      expect(out).toContain("nothing in this device's log yet");
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop.abort();
    expect(await following).toBe(0);
  });

  it("--job --follow on a settled job says so and returns", async () => {
    await writeTwoJobs();
    expect(
      await runCli(["logs", "--job", "5e0a", "--follow", "--tail=1"], {
        paths,
        io: io(),
      }),
    ).toBe(0);
    expect(out).not.toContain("following");
    expect(out).not.toContain("claimed —");
  });
});

/* Assembled from pieces so the tree's own secret scan does not flag it
   (scripts/no-secrets-in-the-tree.mjs reads tracked files). */
const FAKE_PAT = ["ghp", "_", "0123456789abcdefghijABCD"].join("");

describe("what logs will not print", () => {
  it("removes key shapes and the values of credential-named variables", () => {
    const env = { MY_SERVICE_TOKEN: "zz-unshaped-credential-42", HOME: "/h" };
    expect(
      redact(
        "auth failed: zz-unshaped-credential-42 / Bearer abc.def.ghi123 / " +
          `token=hunter22 / ${FAKE_PAT} / home /h`,
        env,
      ),
    ).toBe(
      "auth failed: [redacted MY_SERVICE_TOKEN] / Bearer [redacted] / " +
        "token=[redacted] / [redacted token] / home /h",
    );
  });
});

function hashPrefix(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

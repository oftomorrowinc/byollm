import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendId } from "@byollm/protocol";
import type { DaemonPaths } from "./paths.js";
import { serviceNameFor, type Probe } from "./services-manage.js";
import { InputEnded, runSetup } from "./setup.js";
import { runCli, setupFlags } from "./cli.js";
import {
  jsonFace,
  NeedsFlag,
  NotAnAnswer,
  SETUP_JSON_FORMAT,
  terminalFace,
  yesFace,
  type Face,
  type Question,
  type SetupJsonLine,
  type YesFlags,
} from "./questions.js";

/**
 * Three faces, one conversation — cloud_016 §2, phase 1, ask 2.
 *
 * The terminal, `byollm setup --yes` and `byollm setup --json` answer the
 * same records. The spec's test for that is this file's first case: **one
 * script of answers writes a byte-identical config through every face**,
 * and each face typed exactly that script — so a face that answered
 * differently and happened to land on the same file still fails.
 *
 * The rest is what `--yes` must not do: pick what this machine runs, or
 * which service is the default, for the owner. It stops and names the flag,
 * before a byte is written and before anything pairs. And what `--json` must
 * not do: take an ended input, or a stray blank line, as an answer.
 */

async function paths(): Promise<DaemonPaths> {
  const root = await mkdtemp(join(tmpdir(), "byollm-faces-"));
  return {
    root,
    config: join(root, "config.json"),
    pairings: join(root, "pairings.json"),
    allowlist: join(root, "allow.json"),
    ingressLog: join(root, "ingress.log"),
    budgets: join(root, "budgets.json"),
  } as DaemonPaths;
}

const machineWith =
  (ids: readonly BackendId[]) =>
  (id: BackendId): Promise<boolean> =>
    Promise.resolve(ids.includes(id));

const LOCAL_MODEL = "qwen3:8b";
const LOCAL = serviceNameFor(LOCAL_MODEL);

const ollama: Probe = () =>
  Promise.resolve([
    {
      label: "Ollama",
      baseUrl: "http://127.0.0.1:11434",
      models: [LOCAL_MODEL],
      backendId: "ollama",
    },
  ]);
const nothingServing: Probe = () => Promise.resolve([]);

const SUBSCRIPTION_SENTENCE =
  "uses your own subscription, for YOUR\n" +
  "OWN jobs only — never shared with a team, whatever the config says.\n" +
  "Someone else's terms are not yours to lend.";

/** A face that keeps every record it was given and every line it answered. */
function recorded(inner: Face): Face & {
  asked: Question[];
  typed: string[];
} {
  const asked: Question[] = [];
  const typed: string[] = [];
  return {
    asked,
    typed,
    out: (text) => {
      inner.out(text);
    },
    err: (text) => {
      inner.err(text);
    },
    interactive: inner.interactive,
    answer: async (question) => {
      asked.push(question);
      const line = await inner.answer(question);
      typed.push(line);
      return line;
    },
  };
}

/** The terminal face over a script of typed lines. */
function terminalOf(script: readonly string[]): Face {
  const left = [...script];
  return terminalFace({
    interactive: true,
    out: () => undefined,
    err: () => undefined,
    ask: () => {
      const line = left.shift();
      return line === undefined
        ? Promise.reject(new InputEnded())
        : Promise.resolve(line);
    },
  });
}

/** The JSON face, with stdin as the given raw lines and stdout kept. */
function jsonOf(stdin: readonly string[]): {
  face: Face;
  stdout: string[];
} {
  const left = [...stdin];
  const stdout: string[] = [];
  return {
    stdout,
    face: jsonFace({
      line: (text) => stdout.push(text),
      err: () => undefined,
      read: () => {
        const line = left.shift();
        return line === undefined
          ? Promise.reject(new InputEnded())
          : Promise.resolve(line);
      },
    }),
  };
}

/** `--yes`, with what it printed kept. */
function yesOf(flags: YesFlags): { face: Face; printed: () => string } {
  const said: string[] = [];
  return {
    printed: () => said.join(""),
    face: yesFace(
      {
        out: (text) => said.push(text),
        err: (text) => said.push(text),
      },
      flags,
    ),
  };
}

/** One setup on a described machine, with what it asked `run` to do. */
async function setupOn(
  face: Face,
  machine: { readonly clis: readonly BackendId[]; readonly probe: Probe },
  /** Each real call the verifier would have spent, as `<cli> <model>`. */
  checked: string[] = [],
): Promise<{
  p: DaemonPaths;
  ran: string[][];
  config: () => Promise<string | undefined>;
  result: Promise<Awaited<ReturnType<typeof runSetup>>>;
}> {
  const p = await paths();
  const ran: string[][] = [];
  const result = runSetup(
    p,
    face,
    machineWith(machine.clis),
    machine.probe,
    (id, model) => {
      checked.push(`${id} ${model}`);
      return Promise.resolve({ installed: true, answers: true });
    },
    () => Promise.reject(new Error("nobody is signed out here")),
    (argv) => {
      ran.push([...argv]);
      return Promise.resolve(0);
    },
    {},
    "linux",
  );
  return {
    p,
    ran,
    result,
    config: () =>
      Promise.resolve(
        existsSync(p.config) ? readFile(p.config, "utf8") : undefined,
      ),
  };
}

beforeEach(() => {
  vi.stubEnv("BYOLLM_LABEL", "");
  vi.stubEnv("BYOLLM_SUPERVISOR_PID", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("one script of answers writes the same config through every face", () => {
  /**
   * Claude and a local model: the picker, the team question (the local
   * model could be shared), the default (two services answer one kind),
   * connect and start — every question `--yes` answers by default and both
   * it answers by flag.
   */
  const SCRIPT = [
    "", // device name: the suggested one
    "1 2", // picker: claude and the local model
    "", // picker: done
    "", // team: no (the default)
    "1", // default service: claude
    "", // connect: yes
    "", // start: yes
  ];
  const machine = { clis: ["claude-cli"] as const, probe: ollama };

  it("the terminal, --yes and --json type the same lines and write the same bytes", async () => {
    const terminal = recorded(terminalOf(SCRIPT));
    const yes = yesOf({
      services: ["claude", LOCAL],
      defaultService: "claude",
    });
    const yesFaced = recorded(yes.face);
    const json = jsonOf(SCRIPT.map((line) => JSON.stringify(line)));
    const jsonFaced = recorded(json.face);

    const runs = [];
    for (const face of [terminal, yesFaced, jsonFaced]) {
      const run = await setupOn(face, machine);
      const result = await run.result;
      runs.push({ ...run, result, config: await run.config() });
    }

    const [byTerminal, byYes, byJson] = runs;
    expect(byTerminal?.config).toBeDefined();
    expect(byTerminal?.config).toContain('"claude"');
    expect(byTerminal?.config).toContain(`"${LOCAL}"`);
    expect(byYes?.config).toBe(byTerminal?.config);
    expect(byJson?.config).toBe(byTerminal?.config);

    /* Not only the same file: the same answers, to the same questions. */
    expect(terminal.typed).toEqual(SCRIPT);
    expect(yesFaced.typed).toEqual(SCRIPT);
    expect(jsonFaced.typed).toEqual(SCRIPT);
    const ids = (face: { asked: Question[] }): string[] =>
      face.asked.map((q) => q.id);
    expect(ids(yesFaced)).toEqual(ids(terminal));
    expect(ids(jsonFaced)).toEqual(ids(terminal));

    for (const run of runs) {
      expect(run.ran).toEqual([
        ["connect", "--name", "my-computer"],
        ["start"],
      ]);
      expect(run.result.running).toBe(true);
    }

    /* --yes printed the sentence that must be shown, in the record's words. */
    expect(yes.printed()).toContain(`claude ${SUBSCRIPTION_SENTENCE}`);
    /* --json carried it on the record, and wrote nothing but records. */
    const lines = json.stdout.map((line) => JSON.parse(line) as SetupJsonLine);
    for (const line of lines) expect(line.format).toBe(SETUP_JSON_FORMAT);
    const questions = lines.flatMap((line) =>
      "question" in line ? [line.question] : [],
    );
    expect(questions.map((q) => q.id)).toEqual(ids(terminal));
    expect(questions.map((q) => q.mustShow).join("")).toContain(
      SUBSCRIPTION_SENTENCE,
    );
    /* The record went out whole: what the terminal was given is what the
       parent was given. */
    expect(questions).toEqual(terminal.asked);
  });
});

describe("--yes does not pick for the owner", () => {
  /**
   * The red-team question: an agent runs `byollm setup --yes` on a machine
   * with a Claude and a ChatGPT tool, both signed in.
   *
   * `codex` has no model this build knows, so its question is asked and
   * `--yes` skips it, as "enter skips" says — codex never becomes a row.
   * Then the picker: no flag, so it stops and names `--service`. Nothing is
   * enabled, nothing is written, nothing pairs.
   */
  it("a bare --yes on a Claude and ChatGPT machine stops at the picker and names --service", async () => {
    const yes = yesOf({});
    const run = await setupOn(yes.face, {
      clis: ["claude-cli", "codex-cli"],
      probe: nothingServing,
    });
    const stopped = await run.result.catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(NeedsFlag);
    expect((stopped as NeedsFlag).flag).toBe("--service");
    expect((stopped as NeedsFlag).question).toBe("services.pick");
    expect((stopped as NeedsFlag).message).toContain(
      "--service <name>: claude",
    );
    expect(await run.config()).toBeUndefined();
    expect(run.ran).toEqual([]);
    /* What it printed is the terminal's own words: the model question,
       skipped, and the picker it stopped at. */
    expect(yes.printed()).toContain(
      "`codex` is installed. Which model does it serve?",
    );
    expect(yes.printed()).toContain(
      "What should byollm be able to run on this machine?",
    );
  });

  it("naming a service that is not a row stops, rather than writing a config without it", async () => {
    const run = await setupOn(
      yesOf({ services: ["claude", "codex"], defaultService: "claude" }).face,
      { clis: ["claude-cli", "codex-cli"], probe: nothingServing },
    );
    const stopped = await run.result.catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(NeedsFlag);
    expect((stopped as NeedsFlag).message).toContain(
      "--service codex: not on this machine's list",
    );
    expect(await run.config()).toBeUndefined();
    expect(run.ran).toEqual([]);
  });

  it("two services answering one kind stop at the default and name --default, after the subscription sentence", async () => {
    const yes = yesOf({ services: ["claude", LOCAL] });
    const run = await setupOn(yes.face, {
      clis: ["claude-cli"],
      probe: ollama,
    });
    const stopped = await run.result.catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(NeedsFlag);
    expect((stopped as NeedsFlag).flag).toBe("--default");
    expect((stopped as NeedsFlag).message).toContain(
      `--default <name>: claude, ${LOCAL}`,
    );
    expect(yes.printed()).toContain(`claude ${SUBSCRIPTION_SENTENCE}`);
    expect(await run.config()).toBeUndefined();
    expect(run.ran).toEqual([]);
  });

  it("one named service needs no default, and pairs", async () => {
    const yes = yesOf({ services: ["claude"] });
    const run = await setupOn(yes.face, {
      clis: ["claude-cli"],
      probe: nothingServing,
    });
    const result = await run.result;
    expect(result.services).toEqual(["claude"]);
    expect(run.ran).toEqual([["connect", "--name", "my-computer"], ["start"]]);
    /* Neither the team nor the default question is asked, so the sentence
       is said where they would have been — and --yes printed it. */
    expect(yes.printed()).toContain(`claude ${SUBSCRIPTION_SENTENCE}`);
  });
});

describe("--yes checks only the subscriptions it was given by name", () => {
  /**
   * #10374, rule 34: "A bare --yes never turns on or checks a subscription
   * that was not named."
   *
   * The check is a real call on the person's plan — the verifier ends in
   * `backend.canary` — and it used to run for every detected CLI with a
   * model, before the picker was asked. So a bare `--yes` that stopped and
   * enabled nothing had already spent a call on Claude. The verifier here
   * counts what it would have spent.
   */
  it("a bare --yes on a Claude and ChatGPT machine makes no call, and stops where it did", async () => {
    const checked: string[] = [];
    const yes = yesOf({});
    const run = await setupOn(
      yes.face,
      { clis: ["claude-cli", "codex-cli"], probe: nothingServing },
      checked,
    );
    const stopped = await run.result.catch((error: unknown) => error);
    expect(checked).toEqual([]);
    expect(stopped).toBeInstanceOf(NeedsFlag);
    expect((stopped as NeedsFlag).message).toContain(
      "--service <name>: claude",
    );
    /* Still listed as found: not checked is not hidden. */
    expect(yes.printed()).toContain("claude");
    expect(yes.printed()).toContain("your subscription — your own jobs only");
    expect(yes.printed()).not.toContain("signed out");
  });

  it("--yes --service claude checks claude and nothing else", async () => {
    const checked: string[] = [];
    const yes = yesOf({ services: ["claude"] });
    const run = await setupOn(
      yes.face,
      { clis: ["claude-cli", "codex-cli"], probe: ollama },
      checked,
    );
    const result = await run.result;
    expect(checked).toEqual(["claude-cli opus"]);
    expect(result.services).toEqual(["claude"]);
    expect(yes.printed()).toContain(`claude ${SUBSCRIPTION_SENTENCE}`);
  });

  it("--yes --service <a local model> on a Claude machine does not check Claude", async () => {
    const checked: string[] = [];
    const yes = yesOf({ services: [LOCAL] });
    const run = await setupOn(
      yes.face,
      { clis: ["claude-cli"], probe: ollama },
      checked,
    );
    const result = await run.result;
    expect(checked).toEqual([]);
    expect(result.services).toEqual([LOCAL]);
    expect(yes.printed()).not.toContain(SUBSCRIPTION_SENTENCE);
  });

  it("a person, and --json, still see every subscription checked", async () => {
    const SCRIPT = ["", "1", "", "", ""];
    const byPerson: string[] = [];
    await (
      await setupOn(
        terminalOf(SCRIPT),
        { clis: ["claude-cli"], probe: nothingServing },
        byPerson,
      )
    ).result;
    const byJson: string[] = [];
    await (
      await setupOn(
        jsonOf(SCRIPT.map((line) => JSON.stringify(line))).face,
        { clis: ["claude-cli"], probe: nothingServing },
        byJson,
      )
    ).result;
    expect(byPerson).toEqual(["claude-cli opus"]);
    expect(byJson).toEqual(byPerson);
  });
});

describe("--json takes only answers", () => {
  const machine = { clis: ["claude-cli"] as const, probe: nothingServing };

  it("input that ends before the questions do is not a yes: written, not paired", async () => {
    /* Name, picker, done — then stdin ends at "Connect?", whose default
       pairs the device. */
    const json = jsonOf(['""', '"1"', '""']);
    const run = await setupOn(json.face, machine);
    await expect(run.result).rejects.toBeInstanceOf(InputEnded);
    expect(run.ran).toEqual([]);
    const last = JSON.parse(json.stdout.at(-1) ?? "{}") as SetupJsonLine;
    expect("question" in last && last.question.id).toBe("setup.connect");
  });

  it("a blank line is not Enter: it stops, and nothing pairs", async () => {
    const json = jsonOf(['""', '"1"', '""', ""]);
    const run = await setupOn(json.face, machine);
    const stopped = await run.result.catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(NotAnAnswer);
    expect((stopped as NotAnAnswer).question).toBe("setup.connect");
    expect(run.ran).toEqual([]);
  });

  it("a JSON value that is not a string is not an answer", async () => {
    const json = jsonOf(["true"]);
    const run = await setupOn(json.face, machine);
    await expect(run.result).rejects.toBeInstanceOf(NotAnAnswer);
    expect(run.ran).toEqual([]);
  });
});

describe("byollm setup's flags", () => {
  it("reads each face, and the answers --yes is given", () => {
    expect(setupFlags([])).toEqual({ face: "terminal" });
    expect(setupFlags(["--json"])).toEqual({ face: "json" });
    expect(setupFlags(["--yes"])).toEqual({ face: "yes", flags: {} });
    expect(
      setupFlags([
        "--yes",
        "--service",
        "claude",
        "--service",
        "qwen3-8b",
        "--default",
        "claude",
      ]),
    ).toEqual({
      face: "yes",
      flags: { services: ["claude", "qwen3-8b"], defaultService: "claude" },
    });
  });

  it.each([
    [["--yes", "--json"]],
    [["--service", "claude"]],
    [["--json", "--default", "claude"]],
    [["--yes", "--service"]],
    [["--yes", "--default", "--json"]],
    [["--yes", "--default", "a", "--default", "b"]],
    [["--yse"]],
  ])("refuses %j, and the CLI exits 2 having asked nothing", async (args) => {
    expect(typeof setupFlags(args)).toBe("string");
    const p = await paths();
    let err = "";
    const code = await runCli(["setup", ...args], {
      paths: p,
      io: {
        out: () => undefined,
        err: (text) => {
          err += text;
        },
      },
    });
    expect(code).toBe(2);
    expect(err).toContain("usage: byollm setup");
    expect(existsSync(p.config)).toBe(false);
  });
});

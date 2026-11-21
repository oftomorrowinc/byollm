import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendId } from "@byollm/protocol";
import type { LoginCommand } from "./login.js";
import type { DaemonPaths } from "./paths.js";
import type { Detected, Probe, Verifier } from "./services-manage.js";
import { manageServices, writeManaged } from "./services-manage.js";
import { runSetup, type SetupIo } from "./setup.js";
import {
  QUESTION_IDS,
  terminalFace,
  type Face,
  type Question,
} from "./questions.js";

/**
 * Setup's transcript, character for character — cloud_016 phase 1, ask 2.
 *
 * The card that turned setup's questions into records had one promise to the
 * person at the terminal: **they see the same words**. Not similar words, not
 * the same questions in a tidier layout — the same bytes, because the words
 * are ruled (the subscription sentence is product law, byollm_015) and a
 * refactor is not where a ruled sentence gets edited.
 *
 * So the goldens in `__transcripts__/` were recorded from the code BEFORE the
 * change, in their own commit, and every scenario here must still produce
 * them exactly. Each golden holds the transcript (prompts, what was said, and
 * the typed answer echoed as a terminal echoes it) and then the config the
 * run wrote — the second half is "the same answers write a byte-identical
 * config".
 *
 * **The scenarios are chosen by question, not by story.** Every question id
 * setup or `services manage` can ask is reached by at least one of them, and
 * `QUESTIONS_REACHED` at the bottom is checked against the full list — the
 * states that only some machines reach (a CLI whose model nobody knows, a
 * Windows sign-in, a metered model on a loopback port, two services that both
 * answer, a config that already has services) are each a scenario of their
 * own, so a question that only appears in some state is not a question the
 * test never sees.
 *
 * Re-recording is `BYOLLM_RECORD_TRANSCRIPTS=1`, and it is not a fix: a
 * golden that changes is a word that changed, and that is a ruling.
 */

const HERE = fileURLToPath(new URL("./__transcripts__/", import.meta.url));
const RECORD = process.env["BYOLLM_RECORD_TRANSCRIPTS"] === "1";

async function paths(): Promise<DaemonPaths> {
  const root = await mkdtemp(join(tmpdir(), "byollm-transcript-"));
  return {
    root,
    config: join(root, "config.json"),
    pairings: join(root, "pairings.json"),
    allowlist: join(root, "allow.json"),
    ingressLog: join(root, "ingress.log"),
    budgets: join(root, "budgets.json"),
  } as DaemonPaths;
}

/**
 * A terminal, as a person sees it: prompts, what was said, and each answer
 * echoed with its newline the way a TTY echoes typing.
 *
 * `ask` is the only door an answer comes in by on this side, so the same
 * recorder reads the old free-text conversation and the new terminal face
 * without knowing which it is talking to.
 */
function terminal(answers: readonly string[]): SetupIo & {
  transcript: () => string;
  left: () => readonly string[];
} {
  const said: string[] = [];
  const queue = [...answers];
  return {
    interactive: true,
    out: (text) => said.push(text),
    err: (text) => said.push(`[err]${text}`),
    ask: (question) => {
      said.push(question);
      const answer = queue.shift();
      if (answer === undefined) {
        said.push("<<the script ran out of answers>>\n");
        return Promise.reject(new Error("the script ran out of answers"));
      }
      said.push(`${answer}\n`);
      return Promise.resolve(answer);
    },
    transcript: () => said.join(""),
    left: () => queue,
  };
}

const machineWith =
  (ids: readonly BackendId[]) =>
  (id: BackendId): Promise<boolean> =>
    Promise.resolve(ids.includes(id));

const serving =
  (...servers: Awaited<ReturnType<Probe>>): Probe =>
  () =>
    Promise.resolve(servers);

/**
 * A verifier that reads its answers off a script, per backend and model.
 *
 * Stateful on purpose: the sign-in loop re-verifies after every round, and
 * "signed out, then signed out again, then signed in" is the path that reaches
 * every one of its questions.
 */
function verifying(
  script: Record<string, readonly Detected[]>,
  otherwise: Detected = { installed: true, answers: true },
): Verifier {
  const left = Object.fromEntries(
    Object.entries(script).map(([key, list]) => [key, [...list]]),
  );
  return (id, model) => {
    const next = left[`${id}:${model}`]?.shift();
    return Promise.resolve(next ?? otherwise);
  };
}

const signsIn = (): ((command: LoginCommand) => Promise<boolean>) => () =>
  Promise.resolve(true);

/**
 * A home directory with exactly this codex model cache in it, or none.
 *
 * Through `HOME` rather than an injected `suggest`, because `runSetup` takes
 * no `suggest` and this test had to run unchanged against the code from
 * before the card: the default reads the real home, so the real home is what
 * gets replaced.
 */
async function homeWith(
  root: string,
  models: readonly { slug: string; description?: string }[] | undefined,
): Promise<void> {
  const home = join(root, "home");
  await mkdir(join(home, ".codex"), { recursive: true });
  if (models !== undefined) {
    await writeFile(
      join(home, ".codex", "models_cache.json"),
      JSON.stringify({
        models: models.map((m) => ({ ...m, visibility: "list" })),
      }),
    );
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
}

async function golden(
  name: string,
  root: string,
  transcript: string,
  config: string | undefined,
): Promise<void> {
  const body =
    transcript.split(root).join("<root>") +
    "\n──── config.json ────\n" +
    (config ?? "(not written)\n");
  const file = join(HERE, `${name}.txt`);
  if (RECORD) {
    await mkdir(HERE, { recursive: true });
    await writeFile(file, body);
    return;
  }
  expect(existsSync(file), `no golden for ${name}`).toBe(true);
  expect(body).toBe(await readFile(file, "utf8"));
}

async function configOf(p: DaemonPaths): Promise<string | undefined> {
  return existsSync(p.config) ? readFile(p.config, "utf8") : undefined;
}

/** Every record any scenario's run was asked, filled as the scenarios run. */
const QUESTIONS_REACHED: Question[] = [];

/**
 * The terminal face over the recording terminal, keeping each record.
 *
 * The scenarios drive setup through a FACE, not a line terminal, so what
 * reaches the goldens is the records as the terminal face prints them — the
 * thing this card claims, rather than the line path `faceOf` keeps for old
 * callers.
 */
function face(io: SetupIo): Face {
  const terminal = terminalFace(io);
  return {
    ...terminal,
    interactive: io.interactive,
    answer: (question) => {
      QUESTIONS_REACHED.push(question);
      return terminal.answer(question);
    },
  };
}

beforeEach(() => {
  /* The suggested device name reads this; a developer's own label must not
     land in a golden. */
  vi.stubEnv("BYOLLM_LABEL", "");
  vi.stubEnv("BYOLLM_SUPERVISOR_PID", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("setup's transcript is the same as before the questions became records", () => {
  it("the long way: two CLIs, a model picked on the second try, a sign-in, a team, a cap, a default, paired and running", async () => {
    const p = await paths();
    await homeWith(p.root, [{ slug: "gpt-5.5", description: "frontier" }]);
    const io = terminal([
      "", // device name: the suggested one
      "9", // codex model: not in the menu, so it is a name, and it fails
      "1", // codex model: the first suggestion
      "zz", // picker: not a number
      "1 3 4 99", // picker: toggles, and one past the end
      "", // picker: done
      "", // claude sign-in: yes (the default)
      "n", // claude sign-in, round two: no, I will do it elsewhere
      "", // claude elsewhere: re-check
      "y", // team
      "a", // shares picker: all
      "", // shares picker: done
      "abc", // cap: not an amount
      "2.50", // cap
      "2", // default service
      "y", // connect
      "", // start
    ]);
    const ran: string[][] = [];
    const result = await runSetup(
      p,
      face(io),
      machineWith(["claude-cli", "codex-cli"]),
      serving({
        label: "Ollama",
        baseUrl: "http://127.0.0.1:11434",
        models: ["qwen3:8b", "glm-5.2:cloud"],
        backendId: "ollama",
      }),
      verifying({
        "claude-cli:opus": [
          { installed: true, answers: false, detail: "Not logged in." },
          { installed: true, answers: false, detail: "Still not." },
        ],
        "codex-cli:9": [
          { installed: true, answers: false, detail: "model 9 not found" },
        ],
      }),
      signsIn(),
      (argv) => {
        ran.push([...argv]);
        return Promise.resolve(0);
      },
      {},
      "linux",
    );
    expect(io.left()).toEqual([]);
    expect(result.running).toBe(true);
    expect(ran).toEqual([["connect", "--name", "my-computer"], ["start"]]);
    await golden("long-way", p.root, io.transcript(), await configOf(p));
  });

  it("a config left empty by an old version, on Windows: yes to set it up, a printed sign-in that is skipped, one local model, no team, not paired", async () => {
    const p = await paths();
    await homeWith(p.root, undefined);
    await writeFile(p.config, JSON.stringify({ services: {} }));
    const io = terminal([
      "", // empty config: set it up
      "laptop", // device name
      "1 2", // picker: claude and the local model
      "", // picker: done
      "n", // claude elsewhere: skip
      "n", // team: no
      "n", // connect: no
    ]);
    const result = await runSetup(
      p,
      face(io),
      machineWith(["claude-cli"]),
      serving({
        label: "Ollama",
        baseUrl: "http://127.0.0.1:11434",
        models: ["qwen3:8b"],
        backendId: "ollama",
      }),
      verifying({
        "claude-cli:opus": [
          { installed: true, answers: false, detail: "Not logged in." },
        ],
      }),
      signsIn(),
      () => Promise.reject(new Error("nothing should run")),
      {},
      "win32",
    );
    expect(io.left()).toEqual([]);
    expect(result.connected).toBe(false);
    await golden(
      "empty-config-windows",
      p.root,
      io.transcript(),
      await configOf(p),
    );
  });

  it("a config left empty, and no to setting it up", async () => {
    const p = await paths();
    await homeWith(p.root, undefined);
    await writeFile(p.config, JSON.stringify({ services: {} }));
    const io = terminal(["n"]);
    const result = await runSetup(p, face(io), machineWith([]), serving());
    expect(result.wrote).toBe(false);
    await golden(
      "empty-config-declined",
      p.root,
      io.transcript(),
      await configOf(p),
    );
  });

  it("a config that already has services asks nothing", async () => {
    const p = await paths();
    await homeWith(p.root, undefined);
    await writeFile(
      p.config,
      JSON.stringify({
        services: { a: { type: "claude-cli", model: "opus" } },
      }),
    );
    const io = terminal([]);
    await runSetup(p, face(io), machineWith([]), serving());
    await golden(
      "config-has-services",
      p.root,
      io.transcript(),
      await configOf(p),
    );
  });

  it("not a terminal asks nothing", async () => {
    const p = await paths();
    const io = { ...terminal([]), interactive: false };
    const said: string[] = [];
    io.err = (text) => said.push(text);
    await runSetup(p, face(io), machineWith([]), serving());
    await golden("not-a-terminal", p.root, said.join(""), await configOf(p));
  });

  it("a codex with no model cache, three names that do not answer, a sign-in that fails twice, pairing that fails", async () => {
    const p = await paths();
    await homeWith(p.root, undefined);
    const io = terminal([
      "phone", // device name
      "nope-1", // codex model
      "nope-2",
      "nope-3", // three rounds, and it is left out
      "1", // picker: claude
      "", // picker: done
      "y", // claude sign-in: yes
      "y", // round two: yes, and now it answers
      "", // connect
    ]);
    const result = await runSetup(
      p,
      face(io),
      machineWith(["claude-cli", "codex-cli"]),
      serving(),
      verifying(
        {
          "claude-cli:opus": [
            { installed: true, answers: false },
            { installed: true, answers: false, detail: "Expired." },
            { installed: true, answers: true },
          ],
        },
        { installed: true, answers: false, detail: "unknown model" },
      ),
      signsIn(),
      () => Promise.resolve(1),
      {},
      "darwin",
    );
    expect(io.left()).toEqual([]);
    expect(result.connected).toBe(false);
    await golden(
      "codex-unknown-pairing-fails",
      p.root,
      io.transcript(),
      await configOf(p),
    );
  });

  it("paired, and no to starting; and paired with a start that fails", async () => {
    for (const [name, answers, started] of [
      ["paired-not-started", ["", "1", "", "y", "n"], 0],
      ["paired-start-fails", ["", "1", "", "y", "y"], 1],
    ] as const) {
      const p = await paths();
      await homeWith(p.root, undefined);
      const io = terminal(answers);
      await runSetup(
        p,
        face(io),
        machineWith(["claude-cli"]),
        serving(),
        verifying({}),
        signsIn(),
        (argv) => Promise.resolve(argv[0] === "start" ? started : 0),
        {},
        "linux",
      );
      expect(io.left()).toEqual([]);
      await golden(name, p.root, io.transcript(), await configOf(p));
    }
  });

  it("nothing on the machine, and nothing selected", async () => {
    for (const [name, detect, answers] of [
      ["nothing-on-the-machine", [], [""]],
      ["nothing-selected", ["claude-cli"], ["", ""]],
    ] as const) {
      const p = await paths();
      await homeWith(p.root, undefined);
      const io = terminal(answers);
      await runSetup(
        p,
        face(io),
        machineWith(detect),
        serving(),
        verifying({}),
      );
      expect(io.left()).toEqual([]);
      await golden(name, p.root, io.transcript(), await configOf(p));
    }
  });

  it("services manage over a config that has services: an unreadable block, a shared metered service, three bad caps, two that answer", async () => {
    const p = await paths();
    await homeWith(p.root, undefined);
    const existing = {
      broken: { type: "no-such-backend" },
      claude: { type: "claude-cli", model: "opus", kinds: ["llm.chat"] },
      glm: {
        type: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "glm-5.2:cloud",
        kinds: ["llm.generate", "llm.chat"],
        offer: "team",
        spend: { acknowledged: true, dailyCapCents: 700 },
      },
    };
    const io = terminal([
      "", // codex model: skip
      "", // picker: keep what the config has
      "", // team: no (the default) — and the shared row is turned off
      "", // default service: the offered one
    ]);
    const outcome = await manageServices({
      io: face(io),
      existing,
      detector: machineWith(["claude-cli", "codex-cli"]),
      verifier: verifying({}),
      probe: serving({
        label: "Ollama",
        baseUrl: "http://127.0.0.1:11434",
        models: ["glm-5.2:cloud", "qwen3:8b"],
        backendId: "ollama",
      }),
      login: signsIn(),
      platform: "linux",
      suggest: () => Promise.resolve([]),
    });
    expect(io.left()).toEqual([]);
    await writeManaged(p.config, io, {}, outcome, {});
    await golden("manage-team-no", p.root, io.transcript(), await configOf(p));

    const p2 = await paths();
    const io2 = terminal([
      "", // codex model: skip
      "2", // picker: the local qwen too
      "", // picker: done
      "y", // team
      "", // shares picker: as it is
      "ten", // cap: three bad answers
      "lots",
      "$$",
      "", // default service: the offered one
    ]);
    const { broken: _unreadable, ...readable } = existing;
    const outcome2 = await manageServices({
      io: face(io2),
      existing: readable,
      detector: machineWith(["claude-cli", "codex-cli"]),
      verifier: verifying({}),
      probe: serving({
        label: "Ollama",
        baseUrl: "http://127.0.0.1:11434",
        models: ["glm-5.2:cloud", "qwen3:8b"],
        backendId: "ollama",
      }),
      login: signsIn(),
      platform: "linux",
      suggest: () => Promise.resolve([]),
    });
    expect(io2.left()).toEqual([]);
    await writeManaged(p2.config, io2, {}, outcome2, {});
    await golden(
      "manage-caps-refused",
      p2.root,
      io2.transcript(),
      await configOf(p2),
    );
  });
});

describe("added after the first recording, recorded against the same pre-change code", () => {
  it("two subscriptions and nothing local: the subscription sentence goes with the default question", async () => {
    const p = await paths();
    await homeWith(p.root, [{ slug: "gpt-5.5", description: "frontier" }]);
    const io = terminal([
      "", // device name
      "1", // codex model: the first suggestion
      "1", // picker: claude too
      "", // picker: done
      "", // default service: the offered one
      "n", // connect: no
    ]);
    await runSetup(
      p,
      face(io),
      machineWith(["claude-cli", "codex-cli"]),
      serving(),
      verifying({}),
      signsIn(),
      () => Promise.reject(new Error("nothing should run")),
      {},
      "linux",
    );
    expect(io.left()).toEqual([]);
    await golden(
      "two-subscriptions",
      p.root,
      io.transcript(),
      await configOf(p),
    );
  });
});

/** Everything the terminal face prints for one record, prompt included. */
async function printedFor(question: Question): Promise<string> {
  const said: string[] = [];
  await terminalFace({
    interactive: true,
    out: (text) => said.push(text),
    err: (text) => said.push(text),
    ask: (prompt) => {
      said.push(prompt);
      return Promise.resolve("");
    },
  }).answer(question);
  return said.join("");
}

describe("every question setup can ask is a record", () => {
  it("the scenarios above reached every question id, and only ids on the list", () => {
    /* Runs after the scenarios: vitest runs a file's tests in order. A new
       question needs an id on the list, a terminal layout, and a scenario
       here that reaches it — or this names it. */
    const reached = new Set(QUESTIONS_REACHED.map((q) => q.id));
    expect([...reached].sort()).toEqual([...QUESTION_IDS].sort());
  });

  it("each record's own words are what the terminal printed for it", async () => {
    /* The words live in the record and the terminal adds only furniture —
       so every line of a record's words is on screen, as is every option. */
    expect(QUESTIONS_REACHED.length).toBeGreaterThan(0);
    for (const question of QUESTIONS_REACHED) {
      const printed = await printedFor(question);
      /* A picker's later rounds redraw the rows without re-introducing it,
         sentence included: it was shown with the question, once. */
      const words = question.again === true ? [] : question.words.split("\n");
      for (const line of words) {
        expect(printed).toContain(line);
      }
      for (const option of question.options ?? []) {
        expect(printed).toContain(option.label);
      }
      if (question.mustShow !== undefined && question.again !== true) {
        expect(printed).toContain(question.mustShow);
      }
    }
  });

  it("the subscription sentence travels with a question, not beside it", () => {
    const carried = QUESTIONS_REACHED.filter((q) =>
      q.mustShow?.includes("never shared with a team"),
    );
    expect(carried.map((q) => q.id)).toContain("services.team");
    expect(carried.map((q) => q.id)).toContain("services.default");
  });

  it("no question is asked as bare text: the conversation never calls `ask`", async () => {
    /* A Face has no `ask`, so the compiler refuses a bare question inside the
       conversation. This holds the files to it too, so one cannot come back
       by way of a line terminal threaded past the face. */
    for (const file of ["services-manage.ts", "setup.ts"]) {
      const source = await readFile(
        fileURLToPath(new URL(`./${file}`, import.meta.url)),
        "utf8",
      );
      expect(source, file).not.toMatch(/\.ask\(/);
    }
  });
});

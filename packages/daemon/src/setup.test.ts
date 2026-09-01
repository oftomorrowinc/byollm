import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectInstalled,
  runSetup,
  terminalIo,
  type Detector,
  type Probe,
  type SetupIo,
} from "./setup.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import type { DaemonPaths } from "./paths.js";

/**
 * The wizard, byollm_015 Phase 1.
 *
 * Its whole contract is that it writes the same `~/.byollm/config.json` a hand
 * would — so every assertion here ends at that file, parsed by the schema the
 * daemon actually loads. A wizard that emitted a config the daemon refuses
 * would have invented a second format, which is the failure this project has
 * paid for in other shapes and does not need in a new one.
 */

async function paths(): Promise<DaemonPaths> {
  const root = await mkdtemp(join(tmpdir(), "byollm-setup-"));
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
 * A machine with exactly these backends startable.
 *
 * The wizard takes its detector as an argument for this reason: what is
 * installed on the machine running the tests is not a fact any assertion here
 * should depend on.
 */
const machineWith =
  (ids: readonly string[]): Detector =>
  (id) =>
    Promise.resolve(ids.includes(id));

/**
 * A machine with these local servers answering, and no others.
 *
 * Passed everywhere, including the cases that do not care: the default probe
 * reaches localhost, so a test that omits it is testing whatever the developer
 * happens to be running. That is the same trap the empty-machine case fell
 * into with `claude` already installed, one layer out.
 */
const serving =
  (...servers: Awaited<ReturnType<Probe>>): Probe =>
  () =>
    Promise.resolve(servers);

/**
 * A CLI that is installed and answers, without spawning anything.
 *
 * The real verifier runs the backend's canary — a genuine one-token call
 * through the genuine binary — which is exactly what it is for and exactly
 * what a unit test must not do. A test that stubbed only `detector` hung for
 * five seconds waiting for a subscription CLI that was never going to be
 * there.
 */
const answersFine = () =>
  Promise.resolve({ installed: true, answers: true } as const);

const noServers: Probe = () => Promise.resolve([]);

/** A scripted terminal: answers in order, transcript captured. */
function scripted(answers: readonly string[]): SetupIo & {
  transcript: () => string;
} {
  const said: string[] = [];
  let at = 0;
  return {
    interactive: true,
    out: (text) => said.push(text),
    err: (text) => said.push(text),
    ask: (question) => {
      said.push(question);
      return Promise.resolve(answers[at++] ?? "");
    },
    transcript: () => said.join(""),
  };
}

describe("the wizard writes a config the daemon accepts", () => {
  it("writes nothing when no CLI is installed, and says what to install", async () => {
    // The honest empty case. A wizard that wrote an empty `services` map
    // would produce a daemon that advertises nothing and cannot say why.
    const p = await paths();
    const io = scripted(["my laptop", "n"]);
    const result = await runSetup(
      p,
      io,
      machineWith([]),
      noServers,
      answersFine,
    );

    expect(result.wrote).toBe(false);
    await expect(readFile(p.config, "utf8")).rejects.toThrow();
    expect(io.transcript()).toContain("no supported CLI found");
  });

  it("refuses to touch a config that already exists", async () => {
    // Somebody's hand-written config is their work. Offering to start over is
    // a different thing from doing it, and this wizard does neither.
    const p = await paths();
    await mkdir(p.root, { recursive: true });
    const mine = JSON.stringify({
      services: {
        studio: {
          type: "openai-http",
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "qwen",
          kinds: ["llm.generate"],
        },
      },
    });
    await writeFile(p.config, mine, "utf8");

    const result = await runSetup(
      p,
      scripted(["x", "y"]),
      machineWith([]),
      noServers,
      answersFine,
    );
    expect(result.wrote).toBe(false);
    expect(await readFile(p.config, "utf8")).toBe(mine);
  });

  it("will not ask questions of something that is not a terminal", async () => {
    // A wizard reading from a pipe answers its own questions with whatever is
    // there, which is how an unattended install ends up configured by
    // accident.
    const p = await paths();
    const io = { ...scripted([]), interactive: false };
    const result = await runSetup(
      p,
      io,
      machineWith([]),
      noServers,
      answersFine,
    );
    expect(result.wrote).toBe(false);
    expect(io.transcript()).toContain("needs a terminal");
  });
});

describe("what it writes, when something is installed", () => {
  it("writes a service the schema parses, and only that", async () => {
    const p = await paths();
    const result = await runSetup(
      p,
      scripted(["studio-mac", "y", "n"]),
      machineWith(["claude-cli"]),
      noServers,
      answersFine,
    );
    expect(result.wrote).toBe(true);

    const written: unknown = JSON.parse(await readFile(p.config, "utf8"));
    const parsed = DaemonConfig.safeParse(written);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (!parsed.success) return;

    // Parsing is necessary and not sufficient: a config can be well-formed
    // and serve nothing, so this asks the daemon to resolve it into routes.
    const loaded = resolveConfig(parsed.data);
    expect(loaded.problems).toEqual([]);
    expect(loaded.routes.map((r) => r.kind).sort()).toEqual([
      "llm.chat",
      "llm.generate",
    ]);
  });

  it("says the self-lock in its own words before asking", async () => {
    // Consent wording is product law: the moment of enablement is the moment
    // of disclosure. Asserted on the transcript, because that is what a person
    // reads — a comment in the source is not a disclosure.
    const io = scripted(["mac", "y", "n"]);
    await runSetup(
      await paths(),
      io,
      machineWith(["claude-cli"]),
      noServers,
      answersFine,
    );

    const text = io.transcript();
    const disclosure = text.indexOf("YOUR OWN jobs");
    const question = text.indexOf("Use it for your own jobs?");
    expect(disclosure).toBeGreaterThan(-1);
    expect(question).toBeGreaterThan(-1);
    expect(
      disclosure,
      "the lock must be stated before the question",
    ).toBeLessThan(question);
  });

  it("resolves the ambiguity byollm_016 would otherwise withhold", async () => {
    // Two subscription CLIs answer the same kinds. Left alone that is the
    // withheld state — nothing advertised, and a person with no idea why. The
    // wizard settles it out loud, so somebody who used it never meets it.
    const p = await paths();
    await runSetup(
      p,
      scripted(["mac", "y", "y", "2"]),
      machineWith(["claude-cli", "codex-cli"]),
      noServers,
      answersFine,
    );
    const parsed = DaemonConfig.safeParse(
      JSON.parse(await readFile(p.config, "utf8")),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const loaded = resolveConfig(parsed.data);
    expect(loaded.withheld).toEqual([]);
    expect(loaded.problems).toEqual([]);
    expect(parsed.data.defaults["llm.generate"]).toBe("codex");
  });

  it("never writes a config it would refuse itself", async () => {
    // The control on the whole file: every path above ends in
    // `DaemonConfig.safeParse` inside the wizard, so a shape it cannot build
    // is a shape it does not write. Asserted by driving every branch and
    // reading back what landed.
    for (const [answers, machine] of [
      [["a", "y", "n"], ["claude-cli"]],
      [["a", "n", "n"], ["claude-cli"]],
      [
        ["a", "y", "y", "y", "1"],
        ["claude-cli", "codex-cli"],
      ],
    ] as const) {
      const p = await paths();
      const result = await runSetup(
        p,
        scripted(answers),
        machineWith(machine),
        noServers,
        answersFine,
      );
      if (!result.wrote) continue;
      expect(
        DaemonConfig.safeParse(JSON.parse(await readFile(p.config, "utf8")))
          .success,
        answers.join(","),
      ).toBe(true);
    }
  });
});

describe("the smaller decisions", () => {
  it("keeps the suggested name when the answer is empty", async () => {
    // Enter means "yes, that one". A wizard that wrote an empty string here
    // would name the device "" and nobody would notice until it appeared on
    // somebody's devices page.
    const p = await paths();
    const io = scripted(["", "y", "n"]);
    await runSetup(p, io, machineWith(["claude-cli"]), noServers, answersFine);
    expect(io.transcript()).toContain("byollm connect --name");
    expect(io.transcript()).not.toContain('--name ""');
  });

  it("takes the device name from BYOLLM_LABEL when it is set", async () => {
    const previous = process.env["BYOLLM_LABEL"];
    process.env["BYOLLM_LABEL"] = "studio-rig";
    try {
      const io = scripted(["", "y", "n"]);
      await runSetup(
        await paths(),
        io,
        machineWith(["claude-cli"]),
        noServers,
        answersFine,
      );
      expect(io.transcript()).toContain("studio-rig");
    } finally {
      if (previous === undefined) delete process.env["BYOLLM_LABEL"];
      else process.env["BYOLLM_LABEL"] = previous;
    }
  });

  it("says so plainly when nothing is listening", async () => {
    // The honest empty case. Somebody with no local server should be told
    // where to add one, not shown an empty numbered list.
    const io = scripted(["mac", "y", ""]);
    await runSetup(
      await paths(),
      io,
      machineWith(["claude-cli"]),
      noServers,
      answersFine,
    );
    expect(io.transcript()).toContain("none answering on the usual ports");
    expect(io.transcript()).toContain("guides/models");
  });

  it("declining every CLI writes nothing", async () => {
    // Detected is not enabled. Somebody who says no to both should end with
    // no config rather than an empty one that advertises nothing.
    const p = await paths();
    const result = await runSetup(
      p,
      scripted(["mac", "n", "n"]),
      machineWith(["claude-cli", "codex-cli"]),
      noServers,
      answersFine,
    );
    expect(result.wrote).toBe(false);
    await expect(readFile(p.config, "utf8")).rejects.toThrow();
  });

  it("treats an unreadable config as absent rather than crashing", async () => {
    // A truncated or hand-mangled file should not stop somebody setting up.
    // It is the daemon's job to complain about a broken config, loudly, when
    // it loads one — not this wizard's job to refuse to help.
    const p = await paths();
    await mkdir(p.root, { recursive: true });
    await writeFile(p.config, "{ this is not json", "utf8");
    const result = await runSetup(
      p,
      scripted(["mac", "y", "n"]),
      machineWith(["claude-cli"]),
      noServers,
      answersFine,
    );
    expect(result.wrote).toBe(true);
  });

  it("defaults to the first service when the pick is nonsense", async () => {
    const p = await paths();
    await runSetup(
      p,
      scripted(["mac", "y", "y", "banana"]),
      machineWith(["claude-cli", "codex-cli"]),
      noServers,
      answersFine,
    );
    const parsed = DaemonConfig.safeParse(
      JSON.parse(await readFile(p.config, "utf8")),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.defaults["llm.generate"]).toBe("claude");
    expect(resolveConfig(parsed.data).withheld).toEqual([]);
  });
});

describe("the real terminal adapter", () => {
  it("passes output through and reports whether it may ask", () => {
    // `ask` is not exercised here on purpose: it opens readline against the
    // process's own stdin, and a unit test that does that either hangs or
    // steals the runner's input. What is checkable without a terminal is
    // checked, and the conversation itself is covered by the scripted io
    // above — which is why the wizard takes its io as an argument at all.
    const out: string[] = [];
    const err: string[] = [];
    const io = terminalIo(
      (text) => out.push(text),
      (text) => err.push(text),
    );
    io.out("hello");
    io.err("trouble");
    expect(out).toEqual(["hello"]);
    expect(err).toEqual(["trouble"]);
    // Under vitest stdin is not a TTY, so this is the refusing case — the
    // same one that makes `byollm setup < /dev/null` decline rather than
    // answer its own questions.
    expect(io.interactive).toBe(false);
  });

  it("refuses to run when it cannot ask", async () => {
    const p = await paths();
    const result = await runSetup(
      p,
      terminalIo(
        () => undefined,
        () => undefined,
      ),
      machineWith(["claude-cli"]),
      noServers,
      answersFine,
    );
    expect(result.wrote).toBe(false);
  });
});

describe("asking, on a real readline", () => {
  it("returns what was typed", async () => {
    // The one path that touches the user's actual stdin. Driven through a
    // pipe rather than a terminal, so it is exercised here instead of only
    // ever running on somebody's laptop.
    const input = new PassThrough();
    const output = new PassThrough();
    const io = terminalIo(
      () => undefined,
      () => undefined,
      input,
      output,
    );
    const asked = io.ask("name? ");
    input.write("studio-mac\n");
    expect(await asked).toBe("studio-mac");
  });
});

describe("the default detector", () => {
  it("answers no for a backend that cannot be constructed", async () => {
    // `createBackend` throws for an id it has no implementation for. Somebody
    // setting up a laptop should get "not found" rather than a stack trace,
    // and the detail belongs in `byollm services` where it can be acted on.
    await expect(
      detectInstalled(
        "not-a-real-backend" as Parameters<typeof detectInstalled>[0],
      ),
    ).resolves.toBe(false);
  });
});

describe("a config file that is JSON but not a config", () => {
  it("is left alone, because it is still the owner's file", async () => {
    // `{}` parses, has no services, and is somebody's work in progress. The
    // wizard reports what it found rather than overwriting it — the same rule
    // as a full config, since "looks empty to me" is not a licence to write.
    const p = await paths();
    await mkdir(p.root, { recursive: true });
    await writeFile(p.config, "{}", "utf8");
    const result = await runSetup(
      p,
      scripted(["mac", "y", "n"]),
      machineWith(["claude-cli"]),
      noServers,
      answersFine,
    );
    expect(result.wrote).toBe(false);
    expect(await readFile(p.config, "utf8")).toBe("{}");
  });
});

describe("what the wizard is allowed to write", () => {
  it("writes answers only, never a schema default", async () => {
    // A default belongs in one place. `DaemonConfig.parse()` returns the
    // answers *plus* concurrency, the community and ingress blocks and a
    // per-service offer — today's values for settings nobody was asked about,
    // frozen into a file that outlives them. Tune a budget next year and every
    // wizard-written config sits on the old number, chosen by no one.
    //
    // Asserted on the raw JSON rather than the parsed shape, because parsing
    // is exactly what would hide it.
    const p = await paths();
    await runSetup(
      p,
      scripted(["mac", "y", ""]),
      machineWith(["claude-cli"]),
      noServers,
      answersFine,
    );
    const raw: unknown = JSON.parse(await readFile(p.config, "utf8"));
    expect(Object.keys(raw as object)).toEqual(["services"]);

    const service = (raw as { services: Record<string, object> }).services[
      "claude"
    ];
    // The service carries what was asked and decided, and nothing else —
    // notably not `offer`, which the schema would have filled with "private".
    expect(Object.keys(service ?? {}).sort()).toEqual([
      "kinds",
      "model",
      "type",
    ]);
  });

  it("still writes a config the daemon reads the same way", async () => {
    // The control on the rule above: writing less must not mean meaning less.
    // The daemon fills the defaults on load, so the resolved routes are
    // identical to what the fatter file would have produced.
    const p = await paths();
    await runSetup(
      p,
      scripted(["mac", "y", ""]),
      machineWith(["claude-cli"]),
      noServers,
      answersFine,
    );
    const parsed = DaemonConfig.safeParse(
      JSON.parse(await readFile(p.config, "utf8")),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const loaded = resolveConfig(parsed.data);
    expect(loaded.problems).toEqual([]);
    expect(loaded.routes.every((r) => r.offerScope === "private")).toBe(true);
  });
});

describe("finding local servers by asking them", () => {
  const ollama = {
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: ["llama3.2", "qwen2.5"],
  };
  const lmstudio = {
    label: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    models: ["mistral"],
  };

  it("offers what answered, with the models it named", async () => {
    const io = scripted(["mac", "1"]);
    await runSetup(await paths(), io, machineWith([]), serving(ollama));
    const text = io.transcript();
    expect(text).toContain("Ollama at http://127.0.0.1:11434/v1");
    // The models come from the server's own answer, so a person recognises
    // the thing they installed rather than a guess.
    expect(text).toContain("llama3.2");
  });

  it("writes the server's own address and first model", async () => {
    // Never a guessed model name: a guess writes a route that is unhealthy on
    // first use, which is worse than writing nothing.
    const p = await paths();
    await runSetup(
      await paths.call(null),
      scripted([]),
      machineWith([]),
      noServers,
      answersFine,
    );
    const p2 = await paths();
    await runSetup(
      p2,
      scripted(["mac", "1"]),
      machineWith([]),
      serving(ollama),
    );
    const raw = JSON.parse(await readFile(p2.config, "utf8")) as {
      services: Record<string, { baseUrl: string; model: string }>;
    };
    expect(raw.services["ollama"]?.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(raw.services["ollama"]?.model).toBe("llama3.2");
    void p;
  });

  it("takes several at once", async () => {
    const p = await paths();
    await runSetup(
      p,
      scripted(["mac", "1,2", "1"]),
      machineWith([]),
      serving(ollama, lmstudio),
    );
    const raw = JSON.parse(await readFile(p.config, "utf8")) as {
      services: Record<string, unknown>;
      defaults?: Record<string, string>;
    };
    expect(Object.keys(raw.services).sort()).toEqual(["lm", "ollama"]);
    // Two services answering the same kinds is the withheld state, so the
    // wizard asks here too rather than leaving it for somebody to discover.
    expect(raw.defaults?.["llm.generate"]).toBe("ollama");
  });

  it("skips a server that lists no models rather than guessing one", async () => {
    const io = scripted(["mac", "1"]);
    const p = await paths();
    await runSetup(
      p,
      io,
      machineWith([]),
      serving({
        label: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        models: [],
      }),
    );
    expect(io.transcript()).toContain("lists no models");
    await expect(readFile(p.config, "utf8")).rejects.toThrow();
  });

  it("ignores a choice nobody offered", async () => {
    // A stray number should not cost the conversation.
    const p = await paths();
    await runSetup(p, scripted(["mac", "9"]), machineWith([]), serving(ollama));
    await expect(readFile(p.config, "utf8")).rejects.toThrow();
  });
});

/**
 * "Found" is not "works" — a8137b5.
 *
 * `health()` runs `--version`, which needs no credentials. So a machine whose
 * subscription token expired last week finished this wizard being told
 * everything was fine, advertised a service it could not provide, and the
 * first person to find out was whoever was waiting on a job.
 *
 * A job is not where somebody discovers their token lapsed. Setup is sitting
 * in front of a terminal with the fix one command away, so it asks.
 */
describe("a CLI that is there but cannot answer", () => {
  const cannotAnswer = () =>
    Promise.resolve({
      installed: true,
      answers: false,
      detail: "the claude CLI is not signed in",
    } as const);

  it("says so, and says what to do about it", async () => {
    const io = scripted(["a", "y", "n"]);
    await runSetup(
      await paths(),
      io,
      machineWith(["claude-cli"]),
      noServers,
      cannotAnswer,
    );
    const said = io.transcript();
    expect(said).toContain("cannot answer yet");
    expect(said, "the person is not told what to run").toMatch(/sign(ing)? in/);
  });

  /* Still written. A token that expires is a five-second fix, and a wizard
     that refused to record the service would make somebody redo the whole
     thing after running one command. Nothing routes to it until it answers. */
  it("sets it up anyway, and says nothing will route yet", async () => {
    const io = scripted(["a", "y", "n"]);
    const result = await runSetup(
      await paths(),
      io,
      machineWith(["claude-cli"]),
      noServers,
      cannotAnswer,
    );
    expect(result.services).toContain("claude");
    expect(io.transcript()).toMatch(/nothing will route to it/);
  });

  /* And a backend with no canary is not reported as broken. `undefined` is
     "not asked", which is a third thing, and rendering it as `false` would
     tell everybody with a local model server that it cannot answer. */
  it("says nothing when there was no way to ask", async () => {
    const io = scripted(["a", "y", "n"]);
    await runSetup(
      await paths(),
      io,
      machineWith(["claude-cli"]),
      noServers,
      () => Promise.resolve({ installed: true, answers: undefined } as const),
    );
    expect(io.transcript()).not.toContain("cannot answer yet");
  });
});

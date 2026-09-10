import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectInstalled,
  InputEnded,
  runSetup,
  terminalIo,
  type Detector,
  type Probe,
  type SetupIo,
} from "./setup.js";
import { DaemonConfig, resolveConfig } from "./config.js";
import type { DaemonPaths } from "./paths.js";

/**
 * The wizard, byollm_015 Phase 1 — and what is left of it after B100a.
 *
 * Its whole contract is that it writes the same `~/.byollm/config.json` a hand
 * would, so every assertion here ends at that file, parsed by the schema the
 * daemon actually loads. A wizard that emitted a config the daemon refuses
 * would have invented a second format, which is the failure this project has
 * paid for in other shapes and does not need in a new one.
 *
 * **The conversation about services is no longer here.** Todd, 09-10: *"We
 * should remove the old setup and replace with this one. I shouldn't have even
 * suggested having two."* The picker is `services-manage.ts` and has its own
 * suite; what remains in this file is setup's own: the guards on somebody
 * else's file, the device name, and the two verbs that finish the job. The
 * cases that moved are the ones whose subject moved — a test for a picker
 * driven through the wizard tests the wizard's argument passing.
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

/**
 * The shortest true run: name it, take the one thing on offer, stop before
 * pairing.
 *
 * Written once because eleven cases below want it and the script is now a
 * sequence rather than three yes/nos — a copy of it in each case is eleven
 * places to edit when a question moves, which is the thing this row spent its
 * afternoon removing from the source.
 */
const ONE_CLI = ["mac", "1", "", "n"] as const;

describe("the wizard writes a config the daemon accepts", () => {
  it("writes nothing when there is nothing on the machine", async () => {
    // The honest empty case. A wizard that wrote an empty `services` map
    // would produce a daemon that advertises nothing and cannot say why.
    const p = await paths();
    const io = scripted(["my laptop"]);
    const result = await runSetup(
      p,
      io,
      machineWith([]),
      noServers,
      answersFine,
    );

    expect(result.wrote).toBe(false);
    await expect(readFile(p.config, "utf8")).rejects.toThrow();
    expect(io.transcript()).toContain("Nothing to configure yet");
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

  it("names the screen that CAN change an existing config", async () => {
    /**
     * The refusal above used to end at *"or edit that file"*, which was the
     * only true sentence available until B100a. There is a command now, and a
     * refusal that does not name the way forward teaches people to go and
     * hand-edit JSON — which is the complaint B100 opened with.
     */
    const p = await paths();
    await mkdir(p.root, { recursive: true });
    await writeFile(
      p.config,
      JSON.stringify({
        services: {
          studio: {
            type: "openai-http",
            baseUrl: "http://127.0.0.1:8080/v1",
            model: "qwen",
            kinds: ["llm.generate"],
          },
        },
      }),
      "utf8",
    );
    const io = scripted([]);
    await runSetup(p, io, machineWith([]), noServers, answersFine);
    expect(io.transcript()).toContain("byollm services manage");
  });

  it("will not ask questions of something that is not a terminal", async () => {
    const p = await paths();
    const io = scripted([]);
    const result = await runSetup(
      p,
      { ...io, interactive: false },
      machineWith(["claude-cli"]),
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
      scripted([...ONE_CLI]),
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

  it("resolves the ambiguity byollm_016 would otherwise withhold", async () => {
    // Two services answer the same kinds. Left alone that is the withheld
    // state — nothing advertised, and a person with no idea why. The wizard
    // settles it out loud, so somebody who used it never meets it.
    //
    // A CLI and a local model rather than two CLIs, because B116 stopped
    // `codex` being offered on a machine that has not configured it: this
    // build knows no model it can stand behind for that binary, and a row
    // whose model string we invented must not be offered.
    const p = await paths();
    await runSetup(
      p,
      scripted(["mac", "a", "", "n", "2", "n"]),
      machineWith(["claude-cli"]),
      serving({
        label: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        models: ["qwen3:8b"],
      }),
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
    expect(parsed.data.defaults["llm.generate"]).toBe("qwen3-8b");
  });

  it("never writes a config it would refuse itself", async () => {
    // The control on the whole file: every path ends in
    // `DaemonConfig.safeParse` inside `writeManaged`, so a shape it cannot
    // build is a shape it does not write. Asserted by driving several branches
    // and reading back what landed.
    for (const [answers, machine] of [
      [[...ONE_CLI], ["claude-cli"]],
      [
        ["mac", "a", "", "1", "n"],
        ["claude-cli", "codex-cli"],
      ],
      [
        ["mac", "a", "", "banana", "n"],
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
    const io = scripted(["", "1", "", "n"]);
    await runSetup(p, io, machineWith(["claude-cli"]), noServers, answersFine);
    expect(io.transcript()).toContain("byollm connect --name");
    expect(io.transcript()).not.toContain('--name ""');
  });

  it("takes the device name from BYOLLM_LABEL when it is set", async () => {
    const previous = process.env["BYOLLM_LABEL"];
    process.env["BYOLLM_LABEL"] = "studio-rig";
    try {
      const io = scripted(["", "1", "", "n"]);
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

  it("selecting nothing writes nothing", async () => {
    // Offered is not enabled. Somebody who turns nothing on should end with
    // no config rather than an empty one that advertises nothing.
    const p = await paths();
    const result = await runSetup(
      p,
      scripted(["mac", ""]),
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
      scripted([...ONE_CLI]),
      machineWith(["claude-cli"]),
      noServers,
      answersFine,
    );
    expect(result.wrote).toBe(true);
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
  /** A real readline over a pipe, with the transcript captured. */
  const piped = () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let said = "";
    output.on("data", (chunk: Buffer) => {
      said += chunk.toString();
    });
    return {
      input,
      io: terminalIo(
        () => undefined,
        () => undefined,
        input,
        output,
      ),
      said: () => said,
    };
  };

  it("returns what was typed", async () => {
    // The one path that touches the user's actual stdin. Driven through a
    // pipe rather than a terminal, so it is exercised here instead of only
    // ever running on somebody's laptop.
    const { input, io } = piped();
    const asked = io.ask("name? ");
    input.write("studio-mac\n");
    expect(await asked).toBe("studio-mac");
    io.close();
  });

  it("keeps answers that arrived before the question — B114", async () => {
    /**
     * The defect, and it is the whole row. `ask` opened a NEW readline per
     * question and closed it after, so every line delivered before the first
     * prompt was consumed by that first interface and thrown away with it —
     * question two then waited forever for input that had already been sent.
     *
     * A person typing one line at a time never met it. **A script always
     * does**, and a script is what answers the box console.
     */
    const { input, io } = piped();
    input.write("one\ntwo\nthree\n");
    expect(await io.ask("a? ")).toBe("one");
    expect(await io.ask("b? ")).toBe("two");
    expect(await io.ask("c? ")).toBe("three");
    io.close();
  });

  it("still waits when the question comes first", async () => {
    /* The control on the queue: parking lines must not break the ordinary
       order, which is the one a person produces. */
    const { input, io } = piped();
    const asked = io.ask("a? ");
    input.write("later\n");
    expect(await asked).toBe("later");
    io.close();
  });

  it("mixes both orders in one conversation", async () => {
    const { input, io } = piped();
    input.write("first\n");
    expect(await io.ask("a? ")).toBe("first");
    const asked = io.ask("b? ");
    input.write("second\nthird\n");
    expect(await asked).toBe("second");
    expect(await io.ask("c? ")).toBe("third");
    io.close();
  });

  it("prints every prompt, in order", async () => {
    /**
     * A transcript with an answer and no question is one nobody can read
     * back, and the parked-line path is where a prompt is easiest to skip:
     * the answer is already in hand, so writing the question can look
     * optional. It is not — the question is what the answer means.
     */
    const { input, io, said } = piped();
    /* The first `ask` is what opens the interface, so nothing can be parked
       until one exists — and it must not be awaited before the input arrives
       or it waits forever. Two lines at once: the first answers it, the
       second parks. Without this the "parked" case is the waiting case in
       disguise, which is how a mutation that skipped the prompt on the parked
       path survived. */
    const first = io.ask("a? ");
    input.write("one\nparked\n");
    expect(await first).toBe("one");
    expect(await io.ask("b? ")).toBe("parked");
    io.close();
    expect(said()).toContain("a? ");
    expect(said()).toContain("b? ");
    expect(said().indexOf("a? ")).toBeLessThan(said().indexOf("b? "));
  });

  it("treats the end of input as a third thing, not as Enter", async () => {
    /**
     * **Not `""`.** Every screen reads a blank line as "keep the default", so
     * an ended stdin returning `""` would answer every remaining question
     * with its default — `byollm setup < /dev/null` would pair the device and
     * install a background service on the strength of an empty file.
     *
     * It rejects, the waiting question included, and every later one.
     */
    const { input, io } = piped();
    const asked = io.ask("a? ");
    input.end();
    await expect(asked).rejects.toBeInstanceOf(InputEnded);
    await expect(io.ask("b? ")).rejects.toBeInstanceOf(InputEnded);
    io.close();
  });

  it("hands over what was already sent before it reports the end", async () => {
    /* Order matters here: input that arrived is input that was given, and
       ending the stream does not retract it. */
    const { input, io } = piped();
    input.write("one\n");
    input.end();
    expect(await io.ask("a? ")).toBe("one");
    await expect(io.ask("b? ")).rejects.toBeInstanceOf(InputEnded);
    io.close();
  });

  it("closes without having been asked anything", async () => {
    /* `close()` runs in a `finally`, so it must be safe on the path where the
       command refused before the first question — the non-TTY refusal, which
       is the common one. */
    const { io } = piped();
    expect(() => {
      io.close();
    }).not.toThrow();
    await Promise.resolve();
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
    // wizard offers rather than overwrites — the same rule as a full config,
    // since "looks empty to me" is not a licence to write.
    const p = await paths();
    await mkdir(p.root, { recursive: true });
    await writeFile(p.config, "{}", "utf8");
    const result = await runSetup(
      p,
      scripted(["n"]),
      machineWith(["claude-cli"]),
      noServers,
      answersFine,
    );
    expect(result.wrote).toBe(false);
    expect(await readFile(p.config, "utf8")).toBe("{}");
  });
});

describe("what the wizard is allowed to write", () => {
  it("writes answers only, never a schema default — with one exception", async () => {
    // A default belongs in one place. `DaemonConfig.parse()` returns the
    // answers *plus* concurrency, the community and ingress blocks — today's
    // values for settings nobody was asked about, frozen into a file that
    // outlives them. Tune a budget next year and every wizard-written config
    // sits on the old number, chosen by no one.
    //
    // **`offer` is the exception, and it is deliberate.** B100's second
    // constraint: a service created without a visible scope is a consent
    // decision made by a tool. It is also the one field where "the default
    // moves later" would be a widening rather than a tuning — a config that
    // relied on the default would then share what nobody agreed to share. So
    // the rule holds for settings and does not hold for consent.
    //
    // Asserted on the raw JSON rather than the parsed shape, because parsing
    // is exactly what would hide it.
    const p = await paths();
    await runSetup(
      p,
      scripted([...ONE_CLI]),
      machineWith(["claude-cli"]),
      noServers,
      answersFine,
    );
    const raw: unknown = JSON.parse(await readFile(p.config, "utf8"));
    expect(Object.keys(raw as object)).toEqual(["services"]);

    const service = (raw as { services: Record<string, object> }).services[
      "claude"
    ];
    expect(Object.keys(service ?? {}).sort()).toEqual([
      "kinds",
      "model",
      "offer",
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
      scripted([...ONE_CLI]),
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

describe("what setup hands to the screen", () => {
  it("passes the machine it was given, not the one it is running on", async () => {
    /**
     * The wiring assertion, and it is the reason four injectables travel
     * through `runSetup` untouched. Ollama here, `claude` there: if setup
     * dropped either argument the picker would fall back to its own defaults
     * and probe this laptop, which is precisely the failure the injection
     * exists for.
     */
    const p = await paths();
    const io = scripted(["mac", "a", "", "n", "", "n"]);
    await runSetup(
      p,
      io,
      machineWith(["claude-cli"]),
      serving({
        label: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        models: ["qwen3:8b"],
      }),
      answersFine,
    );
    const written = JSON.parse(await readFile(p.config, "utf8")) as {
      services: Record<string, unknown>;
    };
    expect(Object.keys(written.services).sort()).toEqual([
      "claude",
      "qwen3-8b",
    ]);
  });

  it("says who each service was written for, not one sentence for all of them", async () => {
    /**
     * The summary said *"claude, qwen — your own jobs only"* for every config
     * the wizard could write, which was true right up until the screen could
     * share one. A summary that cannot be wrong about what it summarises is a
     * summary nobody has to check.
     */
    const io = scripted(["mac", "1", "", "y", "1", "", "n"]);
    await runSetup(
      await paths(),
      io,
      machineWith([]),
      serving({
        label: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        models: ["qwen3:8b"],
      }),
      answersFine,
    );
    expect(io.transcript()).toContain("qwen3-8b — your team may use it");
  });
});

describe("an existing config with no services", () => {
  const emptyConfig = async (): Promise<DaemonPaths> => {
    const p = await paths();
    await mkdir(p.root, { recursive: true });
    await writeFile(p.config, JSON.stringify({ services: {} }), "utf8");
    return p;
  };

  it("offers to set it up rather than stopping", async () => {
    // A file with zero services was written by a version that wrote one
    // before it knew how to find anything. Refusing it left Kevin's Windows
    // box with "It has 0 service(s). Setup will not change it" and nothing
    // else, on the machine where setup was exactly what was needed.
    const p = await emptyConfig();
    const result = await runSetup(
      p,
      scripted(["y", ...ONE_CLI]),
      machineWith(["claude-cli"]),
      noServers,
      answersFine,
    );
    expect(result.wrote).toBe(true);
  });

  it("changes nothing when the answer is no", async () => {
    const p = await emptyConfig();
    const before = await readFile(p.config, "utf8");
    const result = await runSetup(
      p,
      scripted(["n"]),
      machineWith(["claude-cli"]),
      noServers,
      answersFine,
    );
    expect(result.wrote).toBe(false);
    expect(await readFile(p.config, "utf8")).toBe(before);
  });

  it("keeps the settings it did not ask about", async () => {
    /**
     * The path that loses work is the path taken by people whose config a
     * previous version left empty — i.e. the people already having a bad time.
     * `concurrency` and the ingress block are settings somebody chose
     * deliberately, and a command that never said it would touch them must
     * not.
     */
    const p = await paths();
    await mkdir(p.root, { recursive: true });
    await writeFile(
      p.config,
      JSON.stringify({
        services: {},
        concurrency: 7,
        ingress: { keepSelfPrompts: false },
      }),
      "utf8",
    );
    await runSetup(
      p,
      scripted(["y", ...ONE_CLI]),
      machineWith(["claude-cli"]),
      noServers,
      answersFine,
    );
    const written = JSON.parse(await readFile(p.config, "utf8")) as {
      concurrency?: number;
      ingress?: { keepSelfPrompts?: boolean };
    };
    expect(written.concurrency).toBe(7);
    expect(written.ingress?.keepSelfPrompts).toBe(false);
  });
});

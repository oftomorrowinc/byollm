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
    const result = await runSetup(p, io, machineWith([]));

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

    const result = await runSetup(p, scripted(["x", "y"]), machineWith([]));
    expect(result.wrote).toBe(false);
    expect(await readFile(p.config, "utf8")).toBe(mine);
  });

  it("will not ask questions of something that is not a terminal", async () => {
    // A wizard reading from a pipe answers its own questions with whatever is
    // there, which is how an unattended install ends up configured by
    // accident.
    const p = await paths();
    const io = { ...scripted([]), interactive: false };
    const result = await runSetup(p, io, machineWith([]));
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
    await runSetup(await paths(), io, machineWith(["claude-cli"]));

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

  it("warns that codex is an agent, where the decision is made", async () => {
    // Todd's ruling, in the place it has to be said. Codex's tools are off and
    // tested off; what remains is that a site you trust is still a site you
    // are trusting, and that belongs at enablement rather than in a doc.
    const io = scripted(["mac", "y", "n"]);
    await runSetup(await paths(), io, machineWith(["codex-cli"]));
    expect(io.transcript()).toContain("only use it");
    expect(io.transcript()).toContain("sites you trust");
  });

  it("resolves the ambiguity byollm_016 would otherwise withhold", async () => {
    // Two subscription CLIs answer the same kinds. Left alone that is the
    // withheld state — nothing advertised, and a person with no idea why. The
    // wizard settles it out loud, so somebody who used it never meets it.
    const p = await paths();
    await runSetup(
      p,
      scripted(["mac", "y", "y", "n", "2"]),
      machineWith(["claude-cli", "codex-cli"]),
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
      const result = await runSetup(p, scripted(answers), machineWith(machine));
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
    await runSetup(p, io, machineWith(["claude-cli"]));
    expect(io.transcript()).toContain("byollm connect --name");
    expect(io.transcript()).not.toContain('--name ""');
  });

  it("takes the device name from BYOLLM_LABEL when it is set", async () => {
    const previous = process.env["BYOLLM_LABEL"];
    process.env["BYOLLM_LABEL"] = "studio-rig";
    try {
      const io = scripted(["", "y", "n"]);
      await runSetup(await paths(), io, machineWith(["claude-cli"]));
      expect(io.transcript()).toContain("studio-rig");
    } finally {
      if (previous === undefined) delete process.env["BYOLLM_LABEL"];
      else process.env["BYOLLM_LABEL"] = previous;
    }
  });

  it("points at the guide rather than interrogating for a local model", async () => {
    // byollm_015: the mainstream path stays three answers long, and the LoRA
    // path is a link rather than a fourth interrogation.
    const io = scripted(["mac", "y", "y"]);
    await runSetup(await paths(), io, machineWith(["claude-cli"]));
    expect(io.transcript()).toContain("guides/models");
    // Still only the three questions it promised.
    expect(io.transcript().match(/\? \[/g)?.length ?? 0).toBeLessThanOrEqual(3);
  });

  it("declining every CLI writes nothing", async () => {
    // Detected is not enabled. Somebody who says no to both should end with
    // no config rather than an empty one that advertises nothing.
    const p = await paths();
    const result = await runSetup(
      p,
      scripted(["mac", "n", "n", "n"]),
      machineWith(["claude-cli", "codex-cli"]),
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
    );
    expect(result.wrote).toBe(true);
  });

  it("defaults to the first service when the pick is nonsense", async () => {
    const p = await paths();
    await runSetup(
      p,
      scripted(["mac", "y", "y", "n", "banana"]),
      machineWith(["claude-cli", "codex-cli"]),
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
    );
    expect(result.wrote).toBe(false);
    expect(await readFile(p.config, "utf8")).toBe("{}");
  });
});

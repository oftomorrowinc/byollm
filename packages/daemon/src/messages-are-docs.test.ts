import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { noSupervisor, removeTemp } from "./test-support.js";

/**
 * A command an error message tells you to run has to work.
 *
 * Todd ran `byollm offer glm-5.2 team --cap 2500`, was told it succeeded, and
 * `byollm status` answered with a problem line naming
 * `byollm offer glm-5.2 team` — the command he had just run, minus the flag
 * that would have made it work. Following the instruction exactly returned him
 * to the instruction.
 *
 * Error messages are documentation: they are read at the moment somebody is
 * stuck, by somebody with no other source. Documentation gets walked, so these
 * do — each case runs the command the message names and asserts the state it
 * promised.
 */

let home: string;
let paths: DaemonPaths;
let out = "";
let err = "";
let confirmAnswer = true;

function io(): Partial<CliIo> {
  return {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    confirm: () => Promise.resolve(confirmAnswer),
  };
}

const run = (...argv: string[]) =>
  runCli(argv, { paths, io: io(), service: noSupervisor() });

/** Every `byollm …` command quoted in a message, as argv. */
const commandsIn = (text: string): string[][] =>
  [...text.matchAll(/`byollm ([^`\n]+)`/g)]
    .map((match) => match[1]!.trim())
    // A placeholder is the message teaching a shape, not naming a runnable
    // command. Substituted rather than skipped, so the shape is still walked.
    .map((command) => command.replace(/<cents[^>]*>/g, "2500"))
    .filter((command) => !command.includes("<"))
    .map((command) => command.split(/\s+/));

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-docs-"));
  paths = daemonPaths(home);
  await mkdir(home, { recursive: true });
  out = "";
  err = "";
  confirmAnswer = true;
});

afterEach(async () => {
  await removeTemp(home);
});

const METERED = {
  services: {
    glm: {
      type: "openai-http",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "glm-5.2:cloud",
      kinds: ["llm.generate"],
    },
  },
};

const FREE = {
  services: {
    "my-ollama": {
      type: "ollama",
      model: "llama3.2",
      kinds: ["llm.generate"],
    },
  },
};

describe("every command a message names", () => {
  it("works, when `offer` refuses a ceiling it cannot use", async () => {
    // The refusal used to end "Drop --cap" — an edit described, not a command
    // to run. An error message is documentation that arrives at the moment
    // somebody is stuck, so it now ends with the line they can paste, and
    // this walks it.
    await writeFile(paths.config, JSON.stringify(FREE), "utf8");
    const refused = await run("offer", "my-ollama", "team", "--cap", "2500");
    expect(refused).toBe(2);

    const named = commandsIn(err);
    expect(named.length, `no command named in: ${err}`).toBeGreaterThan(0);

    for (const argv of named) {
      out = "";
      err = "";
      const code = await run(...argv);
      expect(code, `byollm ${argv.join(" ")} failed: ${err}`).toBe(0);
    }

    const config = JSON.parse(await readFile(paths.config, "utf8")) as {
      services: Record<string, { offer?: string }>;
    };
    expect(config.services["my-ollama"]?.offer).toBe("team");
  });

  it("works, when `offer` refuses for want of a ceiling", async () => {
    await writeFile(paths.config, JSON.stringify(METERED), "utf8");
    await run("offer", "glm", "team");

    const named = commandsIn(err);
    expect(named.length, `no command named in: ${err}`).toBeGreaterThan(0);

    // Run what it said, verbatim.
    for (const argv of named) {
      out = "";
      err = "";
      const code = await run(...argv);
      expect(code, `byollm ${argv.join(" ")} failed: ${err}`).toBe(0);
    }

    // And the thing it promised is true.
    const config = JSON.parse(await readFile(paths.config, "utf8")) as {
      services: Record<
        string,
        { offer?: string; spend?: Record<string, unknown> }
      >;
    };
    expect(config.services["glm"]?.offer).toBe("team");
    expect(config.services["glm"]?.spend?.["acknowledged"]).toBe(true);
  });

  it("works, when `status` explains a narrowed offer", async () => {
    // A relay, because otherwise there are *two* narrowings and this test is
    // about one of them. With nothing paired, `team` narrows for want of a
    // relay to admit anybody — a second, differently-remedied problem, and
    // following the spend instruction would correctly land on it. Pairing one
    // leaves the spend narrowing as the only thing in the way, which is what
    // the loop was about.
    await writeFile(
      paths.pairings,
      JSON.stringify({
        version: 1,
        pairings: [
          {
            origin: "https://relay.test",
            runnerId: "runner_1",
            owner: "me",
            sites: {},
            controlPlanePublic: "a-pinned-control-plane-key",
            pairedAt: Date.now(),
          },
        ],
      }),
      "utf8",
    );
    // The exact loop. A config that says `team` with no consent — which is
    // what the broken `offer` used to write, and what a hand edit writes.
    await writeFile(
      paths.config,
      JSON.stringify({
        services: { glm: { ...METERED.services.glm, offer: "team" } },
      }),
      "utf8",
    );
    await run("status");

    const named = commandsIn(out);
    const offers = named.filter((argv) => argv[0] === "offer");
    expect(offers.length, `status named no offer command: ${out}`).toBe(1);

    out = "";
    err = "";
    const code = await run(...offers[0]!);
    expect(code, `byollm ${offers[0]!.join(" ")} failed: ${err}`).toBe(0);

    // Following the instruction must leave the problem gone, rather than
    // returning to the instruction.
    out = "";
    await run("status");
    expect(out).not.toContain("was narrowed");
    expect(out).toContain("team (you and the people your relay admits)");
  });
});

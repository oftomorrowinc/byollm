import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { removeTemp } from "./test-support.js";

/**
 * The surface byollm_020 rules — one concept, one command.
 *
 * The CLI is the project's front page: the docs, the video, and a stranger's
 * first two minutes are these words on a screen. Shipping `install` when
 * nothing is installed, and two list commands for one table, is the small
 * dishonesty the whole project trades against.
 *
 * The renames keep working for a window, and that is the part worth testing
 * hardest. Kevin, Casul and Rob have the old words in their shells and their
 * notes today; a rename that answers "unknown command" costs somebody an
 * afternoon for nothing. And an alias must do **the same thing** under a new
 * name — one that quietly does something more destructive is the failure this
 * audit exists to remove, arriving through the fix for it.
 */
let home: string;
let paths: DaemonPaths;
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

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-surface-"));
  paths = daemonPaths(home);
  out = "";
  err = "";
});

afterEach(async () => {
  await removeTemp(home);
});

describe("what help offers", () => {
  it("names the verbs that act and the nouns that list", async () => {
    await runCli(["--help"], { paths, io: io() });
    for (const command of [
      "byollm setup",
      "byollm connect",
      "byollm forget",
      "byollm name",
      "byollm start",
      "byollm stop",
      "byollm run",
      "byollm status",
      "byollm log",
      "byollm services",
      "byollm model ",
      "byollm offer",
      "byollm sites",
    ]) {
      expect(out, command).toContain(command);
    }
  });

  it("no longer offers the words that moved", async () => {
    await runCli(["--help"], { paths, io: io() });
    /* `install` for a thing that installs nothing, `run [url]` where the url
       means something else entirely, and a second list of one table. */
    for (const gone of [
      "byollm install",
      "byollm uninstall",
      "byollm pause",
      "byollm resume",
      "byollm models",
      "byollm run [url]",
    ]) {
      expect(out, gone).not.toContain(gone);
    }
  });
});

describe("the words people already have in their shells", () => {
  it("still work, and say what to type next time", async () => {
    /* Not an error. Somebody mid-test with `byollm install` in their notes
       gets the thing they asked for, plus one line. */
    for (const [was, now] of [
      ["install", "start"],
      ["uninstall", "stop"],
      ["models", "services"],
    ] as const) {
      err = "";
      await runCli([was], { paths, io: io(), service: quietService() });
      expect(err, was).toContain(`\`byollm ${was}\` is now \`byollm ${now}\``);
    }
  });

  it("says it on stderr, so a pipeline still gets only the answer", async () => {
    /* `byollm models > list.txt` should hold the list and not a notice about
       naming. A deprecation that lands in a pipeline is the rename breaking
       the thing it was trying not to break. */
    await runCli(["models"], { paths, io: io() });
    expect(err).toContain("is now");
    expect(out).not.toContain("is now");
  });
});

describe("run, which no longer takes a url", () => {
  it("refuses one rather than guessing, and names the verb that does", async () => {
    expect(
      await runCli(["run", "https://example.test"], { paths, io: io() }),
    ).toBe(2);
    expect(err).toContain("byollm run takes no arguments");
    expect(err).toContain("byollm connect https://example.test");
  });
});

/** A service layer that touches no real supervisor. */
function quietService() {
  return {
    platform: "linux" as const,
    execPath: process.execPath,
    scriptPath: "/tmp/byollm-surface-not-real",
    home,
    uid: 0,
    run: () => Promise.resolve({ code: 1, output: "" }),
    wait: () => Promise.resolve(),
  };
}

/**
 * The lock document names these verbs as locked — B236, and this is what
 * makes that a check rather than a sentence.
 *
 * `docs/schema-lock.md` promises that `setup run start stop status services
 * model log` do not move inside 0.1.x. A promise about the CLI, written in a
 * document, with nothing comparing it to the CLI, is the shape of claim this
 * repository has learned to distrust — and the drift is not exotic: the audit
 * this file exists for RENAMED commands, deliberately and correctly. The next
 * such rename must be a decision about the lock, not a tidy-up that happens to
 * cross it.
 *
 * The list is read out of the document rather than repeated here. Two copies
 * of a promise is how one of them comes to be wrong.
 */
describe("the verbs docs/schema-lock.md locks", () => {
  const LOCK = fileURLToPath(
    new URL("../../../docs/schema-lock.md", import.meta.url),
  );

  function lockedVerbs(): string[] {
    const doc = readFileSync(LOCK, "utf8");
    const line = doc
      .split("\n")
      .find((text) => text.includes("the CLI verbs:"));
    if (line === undefined) {
      throw new Error(
        `${LOCK} no longer has a line naming the locked CLI verbs — either ` +
          "the promise moved or it was dropped, and both need a person",
      );
    }
    /* The verbs are the backticked words on that line and the one after it,
       which is where the sentence wraps. */
    const doc_lines = doc.split("\n");
    const at = doc_lines.indexOf(line);
    const region = `${line}\n${doc_lines[at + 1] ?? ""}`;
    return [...region.matchAll(/`([a-z]+)`/g)].map((match) => match[1] ?? "");
  }

  it("finds them in the document, or this compares nothing", () => {
    const verbs = lockedVerbs();
    expect(verbs.length, `read no verbs out of ${LOCK}`).toBeGreaterThan(5);
    expect(verbs).toContain("setup");
    expect(verbs).toContain("log");
  });

  it("are every one of them offered by the CLI it promises about", async () => {
    await runCli(["--help"], { paths, io: io() });
    for (const verb of lockedVerbs()) {
      expect(
        out,
        `docs/schema-lock.md locks \`byollm ${verb}\` and --help does not ` +
          "offer it — the lock document is making a promise about a command " +
          "that is not there",
      ).toContain(`byollm ${verb}`);
    }
  });
});

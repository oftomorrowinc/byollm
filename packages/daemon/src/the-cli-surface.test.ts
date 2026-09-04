import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

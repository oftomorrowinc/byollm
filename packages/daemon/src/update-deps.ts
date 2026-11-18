import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommandRunner } from "./install.js";
import {
  NPM_REGISTRY,
  verifyProvenance,
  type Provenance,
} from "./provenance.js";
import { HANDED_OFF_SAYS, type UpdateDeps } from "./update.js";

/**
 * The real hands behind {@link update} — B053.
 *
 * Kept apart from the decision logic because everything here shells out, and
 * a module that installs npm packages is a module you cannot run the failure
 * paths of. `update.ts` holds the ordering and the rollback and is tested
 * exhaustively; this holds the four commands and is small enough to read.
 *
 * `npm` is spelled as an argv rather than a shell string, through the same
 * runner the supervisor uses: no shell means nothing here can be
 * re-interpreted by whichever `/bin/sh` a platform ships, and a version
 * string is the one argument an attacker would most like to see concatenated
 * into a command line. `exactVersion` has already refused anything that is
 * not a literal version by the time it reaches here, so this is the second
 * of two fences rather than the only one.
 *
 * ## Two flags on the install, both B360
 *
 * `--ignore-scripts`, because the provenance check runs AFTER npm has put
 * the package down, and an install script would run before it. byollm ships
 * none and neither do its dependencies, so the flag costs nothing today and
 * means a package that fails the check has executed nothing when it is
 * rolled back. A future dependency that needs an install script will fail
 * here, loudly, which is the right time to have that conversation.
 *
 * `--registry`, pinned to the one {@link verifyProvenance} reads. A check
 * against npmjs of a tarball that came from a mirror checks nothing; an
 * owner whose npm points elsewhere gets a failed install and stays where
 * they are, rather than a verified-looking update from somewhere unverified.
 */
export function realUpdateDeps(input: {
  readonly run: CommandRunner;
  readonly drain: UpdateDeps["drain"];
  readonly report: (line: string) => void;
  /** Injected in tests; the registry's provenance for the real thing. */
  readonly verify?: (version: string) => Promise<Provenance>;
  /** Where npm and byollm are looked for. This process's, normally. */
  readonly host?: Host;
}): UpdateDeps {
  const host = input.host ?? thisHost();
  const npm = npmCommand(host);
  /* byollm is asked for afresh each time: it is the binary npm has just put
     down, and on Windows that is found by asking npm where it put it. */
  const byollm = async (...args: readonly string[]) => {
    const command = await byollmCommand(host, npm, input.run);
    return command === undefined
      ? { code: 127, output: "" }
      : input.run([...command, ...args]);
  };
  return {
    drain: input.drain,
    install: async (version) => {
      if (npm === undefined) {
        input.report(
          `npm install byollm@${version} failed: no npm-cli.js beside ` +
            `${host.execPath} or on PATH, so there is no npm to run`,
        );
        return false;
      }
      const result = await input.run([
        ...npm,
        "install",
        "--global",
        "--ignore-scripts",
        `--registry=${NPM_REGISTRY}`,
        `byollm@${version}`,
      ]);
      if (result.code !== 0) {
        /* The words npm used, not our reading of them. A global install fails
           for reasons that are somebody's to fix — a permissions problem on a
           system prefix reads nothing like a registry outage — and an
           interpretation here would throw away the line that tells them
           apart. The same rider the supervisor refusal took. */
        input.report(
          `npm install byollm@${version} failed (exit ${String(result.code)})` +
            (result.output.trim() === ""
              ? ""
              : `: ${result.output.trim().split("\n").slice(-3).join(" ")}`),
        );
      }
      return result.code === 0;
    },
    verify: input.verify ?? ((version) => verifyProvenance(version)),
    /* `byollm start` re-registers with the supervisor, which is what the new
       entry point needs. It is not this process's own restart — that is the
       supervisor's, after we exit. What it says goes into the update's
       account (#9594): it is where #9572's hand-off says it will finish once
       this daemon exits, and the only record of a re-register that failed. */
    reregister: async () => {
      const result = await byollm("start");
      const said = result.output.trim().split("\n").slice(-3).join(" ");
      input.report(
        result.code !== 0
          ? `byollm start failed (exit ${String(result.code)})${said === "" ? "" : `: ${said}`}`
          : said === ""
            ? "byollm start finished and said nothing"
            : `byollm start said: ${said}`,
      );
      if (result.code !== 0) return "failed";
      return result.output.includes(HANDED_OFF_SAYS)
        ? "handed-off"
        : "registered";
    },
    installedVersion: async () => {
      const result = await byollm("--version");
      if (result.code !== 0) return undefined;
      /**
       * The version, from a line that carries more than the version.
       *
       * `byollm --version` prints a sentence, so a whole-output comparison
       * would never match and every update would roll back.
       *
       * **Anchored to `byollm`, and the first draft was not.** It took the
       * first semver-shaped token, which is fine until the line is reworded
       * — a mutation that changed the prefix made it match `node 24.18.0`
       * from the second line and report NODE's version as the daemon's. Not
       * a failed canary: a confidently wrong one, rolling every machine back
       * and saying the binary reports 24.18.0.
       *
       * Anchored, a reworded line matches nothing and the answer is
       * `undefined`, which the caller treats as a failed canary. Wrong in
       * the direction that is safe, and loud.
       */
      const found = /^byollm (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/m.exec(
        result.output,
      );
      return found?.[1];
    },
    report: input.report,
  };
}

/** What {@link npmCommand} and {@link byollmCommand} look at. */
export interface Host {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** The Node binary running this daemon. */
  readonly execPath: string;
  readonly exists: (path: string) => boolean;
}

function thisHost(): Host {
  return {
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    exists: existsSync,
  };
}

/**
 * How to run npm here — #9726.
 *
 * Everywhere but Windows, `npm` by name, as it always was. On Windows `npm`
 * is `npm.cmd`, and Node will not start a `.cmd` without a shell (hardened
 * after CVE-2024-27980): `spawn("npm")` is ENOENT, which the runner reports
 * as exit 127, and `spawn("npm.cmd")` throws EINVAL. Every Windows daemon
 * failed its update that way, at 0.1.5 to 0.1.6 on Kevin's desktop.
 *
 * `shell: true` breaches {@link MUSTS.NO_SHELL_INTERPOLATION} — the version
 * is in this argv — so, as `findWindowsEntry` does for `claude`, this runs
 * the JavaScript the shim would have run under the Node already running the
 * daemon. Beside `node.exe` first, which is where the Node installer puts
 * it; then each PATH directory, the order `npm` by name is looked up in.
 *
 * Not `findWindowsEntry` itself: the first path npm's own shim names is
 * `%~dp0\node.exe`, which that function's reading would take as the entry.
 *
 * `undefined` when there is no npm to be found, which the install reports.
 */
export function npmCommand(host: Host): readonly string[] | undefined {
  if (host.platform !== "win32") return ["npm"];
  const dirs = [
    dirname(host.execPath),
    ...(host.env["PATH"] ?? host.env["Path"] ?? "").split(";").filter(Boolean),
  ];
  for (const dir of dirs) {
    const cli = join(dir, "node_modules", "npm", "bin", "npm-cli.js");
    if (host.exists(cli)) return [host.execPath, cli];
  }
  return undefined;
}

/**
 * How to run the byollm npm just installed — #9726.
 *
 * `byollm` by name everywhere but Windows, where it is `byollm.cmd` and fails
 * exactly as `npm` did. There it is `dist/bin.js` in npm's global root,
 * asked of npm (`npm root --global`) rather than assumed: that is where the
 * `--global` install above put it, whatever prefix this machine's npm has.
 * The same file a supervised daemon was started from, now holding the new
 * version — so the `start` it re-registers with names the path it always
 * did.
 *
 * Checked to exist before it is run: a root with no byollm in it is
 * `undefined`, which the caller treats as a binary that will not run.
 */
export async function byollmCommand(
  host: Host,
  npm: readonly string[] | undefined,
  run: CommandRunner,
): Promise<readonly string[] | undefined> {
  if (host.platform !== "win32") return ["byollm"];
  if (npm === undefined) return undefined;
  const result = await run([...npm, "root", "--global"]);
  if (result.code !== 0) return undefined;
  /* stdout and stderr arrive as one stream, and npm warns on stderr; the
     root is the line under which byollm actually is. */
  for (const line of result.output.split(/\r?\n/).reverse()) {
    const bin = join(line.trim(), "byollm", "dist", "bin.js");
    if (line.trim() !== "" && host.exists(bin)) return [host.execPath, bin];
  }
  return undefined;
}

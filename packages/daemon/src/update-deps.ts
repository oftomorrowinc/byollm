import type { CommandRunner } from "./install.js";
import {
  NPM_REGISTRY,
  verifyProvenance,
  type Provenance,
} from "./provenance.js";
import type { UpdateDeps } from "./update.js";

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
  /** How the installed CLI is asked its version. `byollm`, normally. */
  readonly binary?: string;
}): UpdateDeps {
  const binary = input.binary ?? "byollm";
  return {
    drain: input.drain,
    install: async (version) => {
      const result = await input.run([
        "npm",
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
      const result = await input.run([binary, "start"]);
      const said = result.output.trim().split("\n").slice(-3).join(" ");
      input.report(
        result.code !== 0
          ? `byollm start failed (exit ${String(result.code)})${said === "" ? "" : `: ${said}`}`
          : said === ""
            ? "byollm start finished and said nothing"
            : `byollm start said: ${said}`,
      );
      return result.code === 0;
    },
    installedVersion: async () => {
      const result = await input.run([binary, "--version"]);
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

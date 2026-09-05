import type { CommandRunner } from "./install.js";
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
 */
export function realUpdateDeps(input: {
  readonly run: CommandRunner;
  readonly drain: () => Promise<void>;
  readonly reregister: () => Promise<boolean>;
  readonly report: (line: string) => void;
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
    reregister: async () => (await input.run([binary, "start"])).code === 0,
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

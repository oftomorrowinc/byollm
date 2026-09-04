import { spawn } from "node:child_process";
import type { BackendId } from "@byollm/protocol";

/**
 * Signing a vendor CLI in, from inside `byollm setup`.
 *
 * Two machines sat in "we thought it wasn't working" because a logged-out CLI
 * only produced a *note*: setup found the binary, said it could not answer
 * yet, wrote the config anyway and moved on. The config was right — nothing
 * routes until it answers — and the person was not stopped at the one moment
 * they were sitting in front of a terminal ready to fix it.
 *
 * ## One terminal, because that is what a hosted console has
 *
 * The obvious shape is "open another terminal and log in there", and it is
 * wrong for the place this has to work: a hosted device's console is one
 * window, and so is an SSH session. The shell-job-control version — background
 * setup, run the CLI, `fg` — needs job control a child process does not own.
 *
 * So setup spawns the login itself with the TTY inherited. The vendor CLI
 * takes over the terminal, does whatever it does, exits, and setup re-probes.
 *
 * ## Verified against the shipped CLIs, not assumed
 *
 * The ruling allowed for "a direct login subcommand if one exists, else
 * interactive plus a `/exit` instruction". Both have one, which is better than
 * the fallback in every way — it exits by itself when the login finishes,
 * rather than depending on somebody typing the right thing to come back:
 *
 *     claude   claude auth login     (also: claude auth status, JSON)
 *     codex    codex login           (also: codex login status)
 *
 * Checked by running them, per the FIXED_ARGV precedent. `claude login` is not
 * a command; `claude auth login` is. Guessing the first would have produced a
 * gate that always failed, on the path a new person meets first.
 *
 * ## Except on Windows, where the spawn cannot work — ruled 2026-09-04
 *
 * An npm-installed `claude` on Windows is `claude.cmd`, and Node will not
 * spawn a `.cmd` without a shell: since the CVE-2024-27980 fix (18.20/20.12)
 * it throws EINVAL, and before that ENOENT. {@link runLogin} is built to
 * swallow that — "cannot spawn" and "exited nonzero" are the same outcome to
 * the caller — so Kevin got three rounds of "Opening Claude's sign-in now"
 * followed by "Still cannot answer", with nothing opening and no error ever
 * printed. Two defensible designs composing into a silent loop.
 *
 * Todd ruled: on Windows do not spawn at all. Print the command, prominently,
 * and let the person run it. {@link loginPlan} is where that decision lives,
 * so it is made once and is testable without a platform to run on.
 */

/** How a backend's CLI is signed in, when it has a way. */
export interface LoginCommand {
  readonly argv: readonly [string, ...string[]];
  /** What to tell somebody before the terminal stops being ours. */
  readonly says: string;
}

/**
 * The login invocation per backend, or `undefined` for one that has none.
 *
 * `undefined` is not "cannot log in" — Ollama's cloud models authenticate
 * elsewhere entirely — it is "this module has nothing to spawn", and the
 * caller falls back to asking rather than inventing a command.
 */
export function loginCommandFor(id: BackendId): LoginCommand | undefined {
  switch (id) {
    case "claude-cli":
      return {
        argv: ["claude", "auth", "login"],
        says:
          "Opening Claude's sign-in now. Finish it there and this picks\n" +
          "  straight back up.",
      };
    case "codex-cli":
      return {
        argv: ["codex", "login"],
        says:
          "Opening Codex's sign-in now. Finish it there and this picks\n" +
          "  straight back up.",
      };
    default:
      return undefined;
  }
}

/**
 * Run it, with this terminal.
 *
 * `stdio: "inherit"` is the whole mechanism: the child gets our stdin, stdout
 * and stderr, so a browser prompt, a device code or a password field all work
 * exactly as they do when somebody runs the command themselves. Nothing is
 * captured, because capturing is what would break them.
 *
 * Resolves to whether the child exited cleanly. It never throws: a CLI that
 * cannot be spawned at all is the same outcome to the caller as one that
 * exited nonzero — the person is not signed in, and the next thing to do is
 * ask them rather than crash the wizard they are halfway through.
 *
 * **It reports before it swallows.** The never-throws contract is about
 * control flow, and it had quietly become a contract about information too:
 * the spawn failure carried the word EINVAL and nobody ever saw it, so three
 * identical rounds looked like three identical nothings. `report` gets the
 * error's own words before the `false` goes back. Same law as the supervisor
 * refusal, twice in one day — an interpretation is not the evidence, and
 * silence is not either.
 */
export async function runLogin(
  command: LoginCommand,
  report: (text: string) => void = () => undefined,
  spawnImpl: typeof spawn = spawn,
): Promise<boolean> {
  const [file, ...args] = command.argv;
  const failed = (error: unknown): void => {
    report(
      `  \`${command.argv.join(" ")}\` could not be started: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
  };
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawnImpl(file, args, { stdio: "inherit" });
      child.on("error", (error) => {
        failed(error);
        resolve(false);
      });
      child.on("close", (code) => {
        resolve(code === 0);
      });
    } catch (error) {
      failed(error);
      resolve(false);
    }
  });
}

/**
 * Spawn it, or tell them to run it — the one place that decides.
 *
 * Windows gets `print` for the reason in the module note above: the spawn
 * cannot work there, and a wizard that says "Opening Claude's sign-in now"
 * and opens nothing is worse than one that hands over the command.
 */
export function loginPlan(
  command: LoginCommand,
  platform: NodeJS.Platform,
):
  | { readonly kind: "spawn" }
  | { readonly kind: "print"; readonly say: string } {
  if (platform !== "win32") return { kind: "spawn" };
  return {
    kind: "print",
    say:
      `  Run this in another window, then come back:\n\n` +
      `      ${command.argv.join(" ")}\n\n` +
      `  (Windows cannot open it for you from here.)`,
  };
}

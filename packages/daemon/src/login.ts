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
 */
export async function runLogin(
  command: LoginCommand,
  spawnImpl: typeof spawn = spawn,
): Promise<boolean> {
  const [file, ...args] = command.argv;
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawnImpl(file, args, { stdio: "inherit" });
      child.on("error", () => {
        resolve(false);
      });
      child.on("close", (code) => {
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
  });
}

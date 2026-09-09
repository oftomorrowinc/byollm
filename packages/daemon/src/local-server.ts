import { spawn } from "node:child_process";
import type { BackendId } from "@byollm/protocol";

/**
 * Starting a local model server when a job needs it — B050.
 *
 * Ruled by Todd on the third pass, and the ruling is smaller than the two
 * drafts before it: "they should call the models to start them as needed, not
 * keep them running when they aren't." Nothing is pre-warmed, nothing is kept
 * resident for byollm's sake, and cleanup is the runtime's own business —
 * ollama unloads models after `keep_alive` without being asked, and the
 * server process left behind is light.
 *
 * ## Only loopback, and the reason is not tidiness
 *
 * A configured `baseUrl` can point anywhere. Starting a process because a
 * *remote* endpoint did not answer is nonsense at best: the thing that is
 * down is on another machine, and the local command would either fail or —
 * worse — succeed and serve a different model than the one the owner
 * configured, on a port that happens to match. So the start is gated on the
 * url being loopback, which is the only case where "this server is not
 * running" and "this machine can start it" are the same sentence.
 *
 * ## One command, and the rest say nothing
 *
 * `ollama serve` is here because it is stable and well known. The other
 * local servers each have a start command and this module does not guess
 * them: `login.ts` set the precedent — the commands there were checked by
 * running them, and guessing one would have produced a gate that always
 * failed on the path a new person meets first. An id with no entry simply
 * does not get started, which is exactly the behaviour before this existed.
 */

/** How a local server is started, for the ones we can say. */
export function startCommandFor(
  id: BackendId,
): readonly [string, ...string[]] | undefined {
  switch (id) {
    case "ollama":
      return ["ollama", "serve"];
    default:
      /* Not "cannot be started" — "this module has nothing to spawn". The
         caller falls back to the behaviour it had before, which is to report
         the server as down. Filling these in wants a machine with each of
         them on it, one at a time, the way the login commands were done. */
      return undefined;
  }
}

/**
 * Is this url on this machine?
 *
 * Hostname only, and deliberately not a DNS lookup: a name that resolves to
 * a loopback address today is a name somebody else controls tomorrow, and
 * this decides whether to run a program.
 */
export function isLoopback(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  /* IPv6 loopback arrives bracketed from `URL`, which strips the brackets
     into `[::1]` -> `::1` on some runtimes and not others. Both spellings. */
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]"
  );
}

export interface StartLocalInput {
  readonly id: BackendId;
  readonly baseUrl: string | undefined;
  /** Is it answering now? Asked again after the start, to know if it worked. */
  readonly answers: () => Promise<boolean>;
  /** Spawns and returns immediately — the server outlives this call. */
  readonly spawn: (command: readonly string[]) => void;
  readonly wait: (ms: number) => Promise<void>;
  readonly report: (line: string) => void;
  /** How long to give it before giving up. */
  readonly withinMs?: number;
  readonly pollMs?: number;
}

export type StartOutcome =
  "already-running" | "started" | "not-startable" | "gave-up";

/**
 * Make sure the local server behind this service is up, if we can.
 *
 * Returns what happened rather than a boolean, because the four cases lead to
 * four different sentences and a caller that only knew "false" would have to
 * invent one.
 */
export async function ensureLocalServer(
  input: StartLocalInput,
): Promise<StartOutcome> {
  /**
   * Startability first, and health only if there is something we could do.
   *
   * The other order reads better and costs a request per job on every
   * backend in the product — including the ones this module has no command
   * for and the remote endpoints it would never touch. Asking a question
   * whose answer cannot change what happens next is a request nobody
   * needed, on the hot path.
   */
  const command = startCommandFor(input.id);
  if (command === undefined) return "not-startable";
  if (input.baseUrl === undefined || !isLoopback(input.baseUrl)) {
    return "not-startable";
  }

  if (await input.answers()) return "already-running";

  input.report(`${input.id} is not answering — starting it`);
  input.spawn(command);

  const until = Date.now() + (input.withinMs ?? 20_000);
  /* Asked before the first wait as well as after: a server that was already
     coming up when the job arrived should not cost the job a full poll
     interval it did not need. */
  while (Date.now() < until) {
    await input.wait(input.pollMs ?? 250);
    if (await input.answers()) return "started";
  }
  /**
   * Given up, and the job proceeds to fail on its own terms.
   *
   * Deliberately not throwing: the caller was about to try the backend
   * anyway, and the backend's own failure sentence is better than ours — it
   * knows what it asked for and what came back. This adds a line saying we
   * tried, which is the part the backend cannot know.
   */
  input.report(`${input.id} did not come up in time`);
  return "gave-up";
}

/**
 * Can this machine start the server behind a service — B056 / D4.
 *
 * The advertising ruling: a configured-but-stopped local server should
 * advertise as available, because it IS available, one spawn away. First-job
 * latency pays the model load and the job's deadline bounds it.
 *
 * **"Installed and startable" is not the same as "configured".** A config
 * naming a server nobody ever installed must NOT advertise: the fleet would
 * claim work it cannot serve, and a site's job would go from a clean
 * no-runner silence to a claimed-then-failed job, which is strictly worse for
 * them. So the question is asked of the machine, not of the file.
 *
 * Three things have to hold, and each rules out a real configuration:
 *   · we know a start command for this backend  (not every local server has
 *     one this module can say)
 *   · the url is on this machine                (a remote endpoint that is
 *     down is not something a local spawn fixes)
 *   · the binary is actually on PATH            (the half that separates
 *     "installed" from "written in a config file")
 */
/**
 * Start a local model server, and let it go — B092.
 *
 * The production half of {@link ensureLocalServer}'s `spawn` seam. Extracted
 * from the daemon's Runner options so it can be run in a test: an inline
 * closure in `cli.ts` is a line nothing can exercise, and B092 exists because
 * a seam nobody passed sat unnoticed for four releases while its own comment
 * described the problem.
 *
 * **Detached, unreferenced, and no stdio.** A model server is not this
 * daemon's child in any sense that matters — it should outlive a daemon
 * restart exactly as it would if its owner had started it, and holding its
 * pipes would let a full output buffer block the process that is meant to be
 * serving jobs.
 *
 * **No shell, and nothing from a job reaches the argv.**
 * {@link startCommandFor} returns a hardcoded literal for a known backend id,
 * so there is nothing here to quote and nothing to smuggle.
 *
 * `onError` rather than a throw: an unhandled `error` on a child process
 * takes the whole daemon down, and "the binary went away between the PATH
 * check and now" has to be a job that fails, not a daemon that dies.
 */
export function spawnLocalServer(
  command: readonly string[],
  onError: (message: string) => void,
  spawnImpl: typeof spawn = spawn,
): void {
  const [program, ...args] = command;
  if (program === undefined) return;
  const child = spawnImpl(program, args, {
    detached: true,
    stdio: "ignore",
    shell: false,
  });
  child.on("error", (error: Error) => {
    onError(`could not start ${program}: ${error.message}`);
  });
  child.unref();
}

export async function isStartable(input: {
  readonly id: BackendId;
  readonly baseUrl: string | undefined;
  readonly onPath?: (binary: string) => Promise<boolean>;
}): Promise<boolean> {
  const command = startCommandFor(input.id);
  if (command === undefined) return false;
  if (input.baseUrl === undefined || !isLoopback(input.baseUrl)) return false;
  return await (input.onPath ?? binaryOnPath)(command[0]);
}

/**
 * Is this program on PATH?
 *
 * Resolved by looking, not by running it. `ollama --version` would answer the
 * question and would also start work on somebody's machine as a side effect
 * of an advertising decision — and this runs on a heartbeat.
 *
 * Windows executables carry their extension, so PATHEXT is consulted there;
 * everywhere else the file simply has to be executable by us.
 */
export async function binaryOnPath(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  const { join, delimiter } = await import("node:path");
  const { constants } = await import("node:fs");

  const dirs = (env["PATH"] ?? "").split(delimiter).filter((d) => d !== "");
  const suffixes =
    platform === "win32"
      ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  for (const dir of dirs) {
    for (const suffix of suffixes) {
      try {
        await access(join(dir, `${binary}${suffix}`), constants.X_OK);
        return true;
      } catch {
        // Not here, or not executable by us. Both mean keep looking.
      }
    }
  }
  return false;
}

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

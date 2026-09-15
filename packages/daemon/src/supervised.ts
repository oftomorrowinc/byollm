/**
 * Telling a supervisor that this device's configuration changed — B207.
 *
 * A running daemon reads its config once, at start, so a command that writes
 * config has changed a file and nothing else. On a laptop the answer is the
 * service pair (`byollm stop && byollm start`). **On a hosted box there is no
 * service**, and until now there was no other answer either: the box's
 * supervisor HANDLED `SIGHUP` and nothing in either repo ever sent it, so
 * B185's third duty was a listener with no speaker. The box worked only
 * because the supervisor retries a dead daemon every minute and the next retry
 * happened to read the new config.
 *
 * **Push, not poll, and the supervisor names itself rather than being
 * guessed at.** `BYOLLM_SUPERVISOR_PID` is set by the box supervisor in the
 * environment its console and daemon inherit. Off a box it is unset and every
 * function here says so and does nothing.
 *
 * Inferring instead would be the dangerous version: `process.ppid === 1` is
 * true for a console child on a box AND for anything run directly under init
 * on an ordinary Linux host, where `SIGHUP` to pid 1 is a signal to the
 * machine's init system. A caller states what it is; nobody deduces it.
 */

/** The supervisor to tell, if this process is running under one. */
export function supervisorPid(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env["BYOLLM_SUPERVISOR_PID"];
  if (raw === undefined) return undefined;
  const pid = Number(raw);
  /* A pid is a positive integer. Anything else is a variable somebody set by
     hand, and signalling a number we did not parse is how a typo becomes a
     signal to an unrelated process. */
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return pid;
}

/**
 * What happened when we tried to tell it — three outcomes, not two.
 *
 * `absent` (there was nobody to tell) and `gone` (there was, and it is not
 * there any more) are different facts about the machine, and a caller that
 * folded them together would print the same sentence for "you are on a laptop"
 * and "your box's supervisor has died".
 */
export type ToldSupervisor = "told" | "absent" | "gone";

/**
 * Signal the supervisor to reload, if there is one.
 *
 * `SIGHUP` because that is what the box supervisor already listens for, and
 * because the reload it performs drains in-flight jobs rather than killing
 * them — a person who just changed a service should not cost somebody else
 * the answer they were waiting on.
 */
export function tellSupervisor(
  /* Wrapped rather than passed as `process.kill` directly: detaching a method
     from its object is the shape lint objects to, and a test wants to hand in
     its own anyway. */
  kill: (pid: number, signal: string) => void = (pid, signal) => {
    process.kill(pid, signal);
  },
  env: NodeJS.ProcessEnv = process.env,
): ToldSupervisor {
  const pid = supervisorPid(env);
  if (pid === undefined) return "absent";
  try {
    kill(pid, "SIGHUP");
    return "told";
  } catch {
    /* ESRCH — it is gone. Not this command's job to fix, and not something to
       throw over either: the config WAS written, which is what the caller
       asked for. */
    return "gone";
  }
}

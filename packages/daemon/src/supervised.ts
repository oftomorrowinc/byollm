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
  /* Injected so the win32 branch is provable on the machines this is actually
     developed on. A branch that can only be exercised by the platform it
     guards against is a branch nobody checks. */
  platform: string = process.platform,
): ToldSupervisor {
  const pid = supervisorPid(env);
  if (pid === undefined) return "absent";

  /**
   * Windows has no `SIGHUP`, and asking for one there is not a no-op.
   *
   * `process.kill(pid, "SIGHUP")` on win32 does not deliver a signal — it
   * **terminates the target process**. A supervised box is Linux, so this
   * cannot arise from our own code; it would take somebody setting the
   * variable by hand on a Windows machine, and the cost of being wrong is
   * killing whatever process that number happens to name.
   *
   * So the platform that cannot be told is treated as one with nobody to
   * tell, which is exactly what it is.
   */
  if (platform === "win32") return "absent";
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

/**
 * Whether this daemon is supervised, and whether it may ask a human — B213.
 *
 * **`isTTY` lies inside a box.** The Pod sets `tty: true` so a person can type
 * at the console, which makes `process.stdout.isTTY` true for every process in
 * that container — including the daemon the supervisor starts, which has no
 * human anywhere near it. So `interactive = process.stdout.isTTY` read TRUE on
 * a box, `run` took the preflight path, and `ask("Sign in to X now?")` waited
 * for an answer that could never come. The event loop drained, Node exited 13,
 * the supervisor restarted it, and the box crash-looped — on the ordinary
 * onboarding order, setup then connect then sign in.
 *
 * The same line got `supervised` backwards for the same reason:
 * `!process.stdout.isTTY` is FALSE on a box, so the one daemon that certainly
 * IS supervised reported that it was not.
 *
 * **The supervisor already says so.** B207 has it state `BYOLLM_SUPERVISOR_PID`
 * into the environment of what it starts, so the answer is a fact rather than
 * an inference from a terminal that belongs to somebody else. `isTTY` remains
 * the answer where there is no supervisor — a person running `byollm run` in
 * their own shell.
 *
 * A function rather than two default parameters because the defaults were the
 * bug: every test passed `interactive` and `supervised` explicitly, so the
 * expressions that shipped were the one part nothing drove.
 */
export function howItRuns(
  env: NodeJS.ProcessEnv = process.env,
  isTty = process.stdout.isTTY,
): { readonly supervised: boolean; readonly interactive: boolean } {
  if (supervisorPid(env) !== undefined) {
    /* Told, not guessed. A supervised daemon never asks, whatever the tty
       says, and it is always supervised. */
    return { supervised: true, interactive: false };
  }
  return { supervised: !isTty, interactive: isTty };
}

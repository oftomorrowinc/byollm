import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the daemon keeps its state.
 *
 * One directory the owner can `ls`, `cat` and delete. The trust surface is
 * the product (byollm_002), and a trust surface you cannot find is not one.
 */
export interface DaemonPaths {
  /** `~/.byollm` — everything below lives here. */
  readonly root: string;
  /** Job routing and backend configuration, owner-authored. */
  readonly config: string;
  /** Paired servers: origin, runner id, token, owner. */
  readonly pairings: string;
  /** The local `team` allowlist — one file, every app. */
  readonly allowlist: string;
  /** Append-only JSONL: every prompt that has run on this machine. */
  readonly ingressLog: string;
  /** Community-job counters, for rate limits and the daily cap. */
  readonly budgets: string;
  /** Estimated money spent running other people's work on metered backends. */
  readonly spend: string;
  /**
   * Grant ids this device has already admitted — byollm-review 2026-08-27.
   *
   * On disk because a grant stays valid for two minutes and a supervised
   * restart takes about one, so an in-process set was empty exactly when it
   * was still needed. Holds only unexpired ids, so it stays small on its own.
   */
  readonly spentGrants: string;
  /**
   * This machine's device keypairs (byollm_009 §3). The most sensitive file
   * the daemon writes: it is the machine's identity, not a token a server can
   * revoke and reissue.
   */
  readonly keys: string;
  /**
   * What the last probe learned about each service — the owner's copy.
   *
   * Written by whoever ran the probe, read by `byollm status`, which is a
   * different process and must not spend a model call of its own to answer
   * "how are my services". A canary on a metered backend costs real money,
   * and `status` is a command people run often.
   *
   * Latest state only, never a history: this answers "where does this stand
   * now", and a log of every probe would be a log of when somebody's token
   * lapsed, which is nobody's business including ours.
   */
  readonly serviceStates: string;
  /**
   * How the daemon's last conversation with an upstream went.
   *
   * Written by the running daemon, read by `byollm status`, which otherwise
   * cannot ask it anything: the two are separate processes and `state:
   * running` was derived from a local flag alone. That sentence was true
   * for hours while every heartbeat this device sent was refused — the
   * daemon was running and reporting nothing, and the only surface that knew
   * was a log line nobody tails.
   *
   * A file rather than a socket because the question is small and the answer
   * survives a restart of either side.
   */
  readonly health: string;
  /** Liveness, rewritten every beat — B202. */
  readonly heartbeat: string;
  /**
   * What this machine calls itself when it pairs.
   *
   * Its own file rather than a field in `config.json`, because that file is
   * routing and backends — the things somebody edits when work is going
   * wrong — and a name is neither. A one-line file is also a thing a person
   * can `cat` when they are wondering why an approval screen said
   * `todd@Todds-Mac-Studio`.
   */
  readonly label: string;
  /**
   * Per-job scratch directories. A process-class backend runs with its `cwd`
   * set to an empty one of these and nothing else (byollm_004 §2).
   */
  readonly scratch: string;
}

/** Resolve the daemon's paths, rooted at `~/.byollm` unless overridden. */
export function daemonPaths(root = defaultRoot()): DaemonPaths {
  return {
    root,
    config: join(root, "config.json"),
    pairings: join(root, "pairings.json"),
    allowlist: join(root, "allow.json"),
    ingressLog: join(root, "ingress.log"),
    budgets: join(root, "budgets.json"),
    spend: join(root, "spend.json"),
    serviceStates: join(root, "services.json"),
    spentGrants: join(root, "spent-grants.json"),
    keys: join(root, "keys.json"),
    health: join(root, "health.json"),
    heartbeat: join(root, "heartbeat.json"),
    label: join(root, "label"),
    scratch: join(root, "scratch"),
  };
}

/** Where a real device keeps its state, with nothing overriding it. */
export function homeRoot(): string {
  return join(homedir(), ".byollm");
}

/**
 * `BYOLLM_HOME` is a TEST SEAM. Ruled 09-15 (B205): always or never, never
 * "sometimes" — and it stays, explicitly scoped and loud rather than silent.
 *
 * It exists so the conformance kit and the adversarial suite can run real
 * daemons without touching the developer's own `~/.byollm`; `edges.test.ts:48`
 * asserts exactly that. **On a person's own machine, a set `BYOLLM_HOME` is a
 * bug**, and {@link overriddenRootNotice} is what stops that being silent.
 *
 * One deliberate exception, and it is not a person's machine: the box
 * supervisor STATES this variable to the daemon it spawns (`boxDaemon`, B204's
 * rider) so that PID 1 and the daemon cannot disagree about where the heartbeat
 * file lives. It sets it to this same default, which is why the notice below
 * asks whether the root has actually MOVED rather than whether the variable
 * exists — see there.
 */
export function defaultRoot(): string {
  return process.env["BYOLLM_HOME"] ?? homeRoot();
}

/**
 * The one line a daemon says at startup when its state directory is not where
 * it should be — B205 item 2, *"make production LOUD, not silent"*.
 *
 * **Keyed on the root having MOVED, not on the variable being set**, and the
 * row's own reasoning is why. B205 justifies this notice as costing nothing
 * because `BYOLLM_HOME` is "never set in prod" — and that stopped being true
 * an hour before the row was written. `0c16de6` (which B205 cites, two
 * paragraphs up, as its consistency guarantee) has the box supervisor spawn
 * the daemon with `env: {...process.env, BYOLLM_HOME: home}`, unconditionally.
 * So a presence check would print this warning on **every hosted box, every
 * start, for ever** — a operator's first line in the box log, always false.
 *
 * A warning that is wrong every time is worse than no warning: it is the one
 * people learn to scroll past, and it would be doing that in the exact log
 * where a real fault has to be noticed. Asking whether the root has moved
 * keeps the notice silent on a box (the supervisor sets it to this very
 * default), silent on a normal machine, and loud in the case the row cares
 * about — somebody's real device pointed somewhere else.
 */
export function overriddenRootNotice(root = defaultRoot()): string | undefined {
  if (root === homeRoot()) return undefined;
  return `state directory is ${root}, not ${homeRoot()} — BYOLLM_HOME is a test seam and should not be set on a real device`;
}

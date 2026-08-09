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
  /** The local `named` allowlist — one file, every app. */
  readonly allowlist: string;
  /** Append-only JSONL: every prompt that has run on this machine. */
  readonly ingressLog: string;
  /** Community-job counters, for rate limits and the daily cap. */
  readonly budgets: string;
  /** Set while the owner has the daemon paused. */
  readonly pauseFlag: string;
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
    pauseFlag: join(root, "paused"),
    scratch: join(root, "scratch"),
  };
}

/**
 * `BYOLLM_HOME` exists so the conformance kit and the adversarial suite can
 * run real daemons without touching the developer's own `~/.byollm`.
 */
export function defaultRoot(): string {
  return process.env["BYOLLM_HOME"] ?? join(homedir(), ".byollm");
}

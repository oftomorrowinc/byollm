import { Buffer } from "node:buffer";
import type { ConsoleShell } from "./console-agent.js";

/**
 * A real terminal for a console session, over `node-pty` — RULED by Todd,
 * 2026-09-16: *"Why don't we add node-pty to the container build instead of a
 * 7th package? If we only need it for hosted that doesn't make sense to
 * publish."*
 *
 * ## Why there is no dependency entry anywhere for this
 *
 * `node-pty` is a NATIVE module, and `byollm` is the package every user
 * installs. Three shapes were weighed: `optionalDependencies` plus a lazy
 * import (mine), a seventh published package (CW's), and this. Todd's is
 * smaller than both, and it is the only one where a broken `npm install
 * byollm` is impossible **by construction** rather than by a mechanism
 * behaving as designed — there is no entry in any manifest to go wrong.
 *
 * The box's Dockerfile installs `node-pty` globally beside `byollm`, and
 * Node's resolution walks ancestors until it reaches the global
 * `lib/node_modules`, so a global `byollm` finds a global sibling. **Measured
 * before this was written**, from an unrelated working directory, because the
 * whole shape rests on it.
 *
 * Everywhere else it is simply absent, and this says so in one line rather
 * than failing with a module-resolution stack trace at the moment somebody
 * opens a console.
 */

/** The subset of `node-pty` used here. Typed locally: there is no dependency
 *  to take types from, and inventing one would be the entry we just avoided. */
interface PtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface NodePty {
  spawn(
    file: string,
    args: readonly string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ): PtyProcess;
}

export const NO_PTY_MESSAGE =
  "byollm console-agent needs node-pty, which is a hosted-box feature and is " +
  "not installed here.\nIf you are self-hosting a box, install it beside " +
  "byollm: npm i -g node-pty";

/** Why {@link openPtyShell} could not start. */
export class NoPtyError extends Error {
  constructor() {
    super(NO_PTY_MESSAGE);
    this.name = "NoPtyError";
  }
}

export interface PtyShellOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly cols?: number;
  readonly rows?: number;
  /** Injected in tests; production takes the real module. */
  readonly load?: () => Promise<NodePty>;
}

const loadNodePty = async (): Promise<NodePty> => {
  // A dynamic import, and a variable specifier so no bundler or static
  // analyser turns this into a hard dependency on the way past.
  const id = "node-pty";
  const loaded: unknown = await import(id);
  return loaded as NodePty;
};

/** Is this "the module is not here", as opposed to "it is here and broken"? */
const isMissingModule = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
};

export async function openPtyShell(
  options: PtyShellOptions,
): Promise<ConsoleShell> {
  /**
   * The wrapping lives HERE rather than inside the production loader, so the
   * injected and real paths behave identically — a test that exercised a
   * different error path from production was how this was found.
   *
   * And only a MISSING module becomes {@link NoPtyError}. A node-pty that is
   * present but unloadable — a native build against the wrong ABI, the
   * classic — must not be reported as "not installed": that sentence sends
   * somebody to install what they already have.
   */
  let pty: NodePty;
  try {
    pty = await (options.load ?? loadNodePty)();
  } catch (error) {
    if (isMissingModule(error)) throw new NoPtyError();
    throw error;
  }

  const child = pty.spawn(options.command, options.args, {
    name: "xterm-256color",
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    cwd: options.cwd,
    env: options.env,
  });

  return {
    write(data: Buffer) {
      // node-pty speaks strings. utf8 round-trips what a terminal sends, and
      // the console's traffic is typing and escape sequences.
      child.write(data.toString("utf8"));
    },
    resize(cols: number, rows: number) {
      try {
        child.resize(cols, rows);
      } catch {
        // A pty that has already gone refuses to be resized, and a console
        // session ending is not a reason to throw out of a resize frame.
      }
    },
    onData(handler: (chunk: Buffer) => void) {
      child.onData((data) => {
        handler(Buffer.from(data, "utf8"));
      });
    },
    onExit(handler: (reason: string) => void) {
      child.onExit(({ exitCode, signal }) => {
        handler(
          signal !== undefined && signal !== 0
            ? `the shell was stopped (signal ${String(signal)})`
            : `the shell exited (${String(exitCode)})`,
        );
      });
    },
    kill() {
      try {
        child.kill();
      } catch {
        // Already gone. Killing twice is how a session ends cleanly when the
        // shell exited first — `finish()` kills regardless of the reason.
      }
    },
  };
}

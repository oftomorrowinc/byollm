import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { NO_PTY_MESSAGE, NoPtyError, openPtyShell } from "./pty-shell.js";

function fakePty() {
  const written: string[] = [];
  const sizes: [number, number][] = [];
  let killed = 0;
  let onData: (d: string) => void = () => undefined;
  let onExit: (e: { exitCode: number; signal?: number }) => void = () =>
    undefined;
  let resizeThrows = false;
  let killThrows = false;
  const spawned: unknown[] = [];

  return {
    written,
    sizes,
    spawned,
    get killed() {
      return killed;
    },
    emit: (d: string) => {
      onData(d);
    },
    exit: (e: { exitCode: number; signal?: number }) => {
      onExit(e);
    },
    breakResize: () => {
      resizeThrows = true;
    },
    breakKill: () => {
      killThrows = true;
    },
    load: () =>
      Promise.resolve({
        spawn: (file: string, args: readonly string[], opts: unknown) => {
          spawned.push({ file, args, opts });
          return {
            onData: (cb: (d: string) => void) => {
              onData = cb;
            },
            onExit: (
              cb: (e: { exitCode: number; signal?: number }) => void,
            ) => {
              onExit = cb;
            },
            write: (d: string) => {
              written.push(d);
            },
            resize: (c: number, r: number) => {
              if (resizeThrows) throw new Error("gone");
              sizes.push([c, r]);
            },
            kill: () => {
              if (killThrows) throw new Error("gone");
              killed += 1;
            },
          };
        },
      }),
  };
}

const open = async (pty: ReturnType<typeof fakePty>) =>
  openPtyShell({
    command: "/bin/rsh",
    args: ["--restricted"],
    cwd: "/home/box",
    env: { HOME: "/home/box" },
    load: pty.load,
  });

describe("a console's terminal", () => {
  it("spawns the command it was given, with a real terminal type", async () => {
    const pty = fakePty();
    await open(pty);
    expect(pty.spawned).toEqual([
      {
        file: "/bin/rsh",
        args: ["--restricted"],
        opts: {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: "/home/box",
          env: { HOME: "/home/box" },
        },
      },
    ]);
  });

  it("carries bytes both ways as utf8", async () => {
    const pty = fakePty();
    const shell = await open(pty);
    const seen: Buffer[] = [];
    shell.onData((c) => seen.push(c));

    shell.write(Buffer.from("café\n", "utf8"));
    pty.emit("naïve\n");

    expect(pty.written).toEqual(["café\n"]);
    expect(Buffer.concat(seen).toString("utf8")).toBe("naïve\n");
  });

  it("survives a resize on a pty that has already gone", async () => {
    /** A resize frame can arrive in the instant after the shell exits, and a
     *  session ending is not a reason to throw out of frame handling. */
    const pty = fakePty();
    const shell = await open(pty);
    pty.breakResize();
    expect(() => {
      shell.resize(10, 5);
    }).not.toThrow();
  });

  it("survives killing a shell that already exited", async () => {
    /** The session's `finish()` kills regardless of WHY it is ending, so the
     *  shell-exited path always kills something already dead. */
    const pty = fakePty();
    const shell = await open(pty);
    pty.breakKill();
    expect(() => {
      shell.kill();
    }).not.toThrow();
  });

  it("tells a signalled shell apart from one that exited", async () => {
    const pty = fakePty();
    const shell = await open(pty);
    const reasons: string[] = [];
    shell.onExit((r) => reasons.push(r));

    pty.exit({ exitCode: 0, signal: 9 });
    pty.exit({ exitCode: 3 });

    expect(reasons).toEqual([
      "the shell was stopped (signal 9)",
      "the shell exited (3)",
    ]);
  });

  it("treats signal 0 as no signal, not as a stop", async () => {
    /** node-pty reports `signal: 0` for an ordinary exit on some platforms,
     *  and "stopped (signal 0)" would be a sentence about nothing. */
    const pty = fakePty();
    const shell = await open(pty);
    const reasons: string[] = [];
    shell.onExit((r) => reasons.push(r));
    pty.exit({ exitCode: 0, signal: 0 });
    expect(reasons).toEqual(["the shell exited (0)"]);
  });
});

/** What Node throws when a module genuinely is not on disk. */
const missing = (): Error =>
  Object.assign(new Error("Cannot find package 'node-pty'"), {
    code: "ERR_MODULE_NOT_FOUND",
  });

describe("when node-pty simply is not here", () => {
  it("says so in one line instead of a resolution stack trace", async () => {
    /**
     * The shape Todd ruled: no dependency entry anywhere, so `byollm` on an
     * ordinary machine has no pty and must not pretend otherwise. This is the
     * sentence a self-hoster reads.
     */
    await expect(
      openPtyShell({
        command: "/bin/sh",
        args: [],
        cwd: "/",
        env: {},
        load: () => Promise.reject(missing()),
      }),
    ).rejects.toThrow(NoPtyError);

    expect(NO_PTY_MESSAGE).toContain("hosted-box feature");
    expect(NO_PTY_MESSAGE).toContain("npm i -g node-pty");
  });

  it("does NOT say 'not installed' when it is installed and broken", async () => {
    /**
     * The classic native-module failure is a build against the wrong ABI: the
     * module is right there and will not load. Reporting that as "not
     * installed" sends somebody to install what they already have, which is
     * the worst kind of error message — confidently wrong.
     */
    const abi = new Error(
      "was compiled against a different Node.js version (NODE_MODULE_VERSION 115)",
    );
    await expect(
      openPtyShell({
        command: "/bin/sh",
        args: [],
        cwd: "/",
        env: {},
        load: () => Promise.reject(abi),
      }),
    ).rejects.toThrow(abi);
  });
});

describe("what the shell says before anyone is listening", () => {
  /**
   * The console opens the shell, THEN dials a socket, THEN builds the session
   * that consumes it — deliberately, so a box with no pty never dials. The
   * shell greets and prompts in that window, and the first prompt is the
   * whole signal that it is safe to type.
   */
  it("keeps the greeting and the first prompt for whoever attaches", async () => {
    const pty = fakePty();
    const shell = await open(pty);

    pty.emit("this is your byollm box.\r\n");
    pty.emit("byollm> ");

    const seen: string[] = [];
    shell.onData((chunk) => seen.push(chunk.toString("utf8")));

    expect(seen.join("")).toBe("this is your byollm box.\r\nbyollm> ");
  });

  it("keeps them in order, and does not repeat them to a later chunk", async () => {
    const pty = fakePty();
    const shell = await open(pty);
    pty.emit("one ");
    pty.emit("two ");

    const seen: string[] = [];
    shell.onData((chunk) => seen.push(chunk.toString("utf8")));
    pty.emit("three");

    expect(seen.join("")).toBe("one two three");
  });

  it("tells a consumer about an exit that already happened", async () => {
    /* A shell that dies before the session exists — a bad command, a missing
       binary — would otherwise leave the session waiting on an exit it had
       already missed. */
    const pty = fakePty();
    const shell = await open(pty);
    pty.exit({ exitCode: 127 });

    let reason: string | undefined;
    shell.onExit((why) => {
      reason = why;
    });

    expect(reason).toBe("the shell exited (127)");
  });

  it("stops holding rather than growing without limit", async () => {
    /* "Nobody ever attaches" is reachable, and a shell left talking to itself
       must not become a leak. The bound keeps the beginning — the greeting and
       the prompt — which is the part that had to survive. */
    const pty = fakePty();
    const shell = await open(pty);

    pty.emit("byollm> ");
    for (let at = 0; at < 200; at += 1) pty.emit("x".repeat(1024));

    const seen: string[] = [];
    shell.onData((chunk) => seen.push(chunk.toString("utf8")));

    const all = seen.join("");
    expect(all.startsWith("byollm> ")).toBe(true);
    expect(all.length).toBeLessThanOrEqual(64 * 1024);
  });
});

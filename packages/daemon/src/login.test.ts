import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loginCommandFor, runLogin } from "./login.js";

/**
 * Handing the terminal to somebody else's CLI.
 *
 * Every branch here is a way the handover fails, and each one has to end the
 * same way for the caller: not signed in, ask them. A throw would take down a
 * wizard somebody is halfway through, for the sake of a login that is allowed
 * to fail.
 */

/** A child that behaves however the case needs, without spawning anything. */
const fakeSpawn = (behave: (child: EventEmitter) => void): typeof spawn =>
  ((): unknown => {
    const child = new EventEmitter();
    queueMicrotask(() => {
      behave(child);
    });
    return child;
  }) as unknown as typeof spawn;

describe("running a vendor CLI's sign-in", () => {
  const claude = loginCommandFor("claude-cli");

  it("is true when the login exited cleanly", async () => {
    expect(claude).toBeDefined();
    const ok = await runLogin(
      claude!,
      fakeSpawn((child) => child.emit("close", 0)),
    );
    expect(ok).toBe(true);
  });

  it("is false when the person abandoned it", async () => {
    // Ctrl-C in the middle of a browser handoff. Not an error — a decision.
    const ok = await runLogin(
      claude!,
      fakeSpawn((child) => child.emit("close", 130)),
    );
    expect(ok).toBe(false);
  });

  it("is false, not a throw, when the binary cannot be spawned", async () => {
    // ENOENT arrives as an `error` event rather than an exception. A wizard
    // that crashed here would lose a config somebody had just answered five
    // questions to build.
    const ok = await runLogin(
      claude!,
      fakeSpawn((child) => child.emit("error", new Error("ENOENT"))),
    );
    expect(ok).toBe(false);
  });

  it("is false when spawn itself throws", async () => {
    // The synchronous path — a bad argv, a platform that refuses. Same
    // outcome to the caller: they are not signed in, so ask them.
    const ok = await runLogin(claude!, () => {
      throw new Error("EPERM");
    });
    expect(ok).toBe(false);
  });
});

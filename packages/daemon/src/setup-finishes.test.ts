import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetup, type Detected, type SetupIo } from "./setup.js";
import { loginCommandFor } from "./login.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { removeTemp } from "./test-support.js";

/**
 * The wizard that finishes the job, and the gate that stops it.
 *
 * Two onboardings ended one step short. `byollm setup` printed "Next: byollm
 * connect …" — a correct sentence, and four verbs from a working device. One
 * person ran connect in a window they later closed; one never ran it. The gap
 * is not knowledge, it is that a wizard stopping one step from done reads as
 * done.
 *
 * And underneath it, the other half: a CLI that is installed but signed out
 * produced a *note* in a wizard that kept going and finished by saying it had
 * worked. Two machines sat in "we thought it wasn't working" on that note.
 */

let home: string;
let paths: DaemonPaths;
let out: string;
let err: string;
let asked: string[];

const answering = (answers: readonly string[]): SetupIo => {
  const queue = [...answers];
  return {
    interactive: true,
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    ask: (question) => {
      asked.push(question);
      return Promise.resolve(queue.shift() ?? "");
    },
  };
};

/** Only claude is on this machine, and it is the one under test. */
const onlyClaude = (id: string): Promise<boolean> =>
  Promise.resolve(id === "claude-cli");

const noServers = () => Promise.resolve([]);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-finishes-"));
  paths = daemonPaths(home);
  out = "";
  err = "";
  asked = [];
});

afterEach(async () => {
  await removeTemp(home);
});

describe("the sign-in gate", () => {
  const signedOut: Detected = {
    installed: true,
    answers: false,
    detail: "Invalid API key · Please run /login",
  };
  const signedIn: Detected = { installed: true, answers: true };

  it("stops rather than writing a config nothing can route to", async () => {
    /**
     * The behaviour this replaces printed four lines and carried on, and the
     * config it wrote was *correct* — nothing routes until the backend
     * answers. What was wrong is that the person met it as a note inside a
     * wizard that then said it was done.
     *
     * Refusing both offers has to end the wizard, not annotate it.
     */
    const result = await runSetup(
      paths,
      answering(["studio", "n", "n", "n", "n"]),
      onlyClaude,
      noServers,
      () => Promise.resolve(signedOut),
      () => Promise.resolve(false),
    );

    expect(result.wrote).toBe(false);
    expect(err).toContain("is installed and not signed in");
    // The remedy is the verified command, not a guess at one.
    expect(err).toContain("claude auth login");
    // And nothing was left behind to confuse the re-run it invites.
    await expect(readFile(paths.config, "utf8")).rejects.toThrow();
    /**
     * The assertion that actually holds the gate.
     *
     * `wrote: false` is true for a second reason — nothing was enabled — so a
     * test asserting only that passes with the gate removed, which this one
     * did until a mutation said so. What the *stop* produces, and the
     * fall-through does not, is that the wizard never gets to the question
     * after it.
     */
    expect(
      asked.some((question) => question.includes("your own jobs")),
      "the wizard carried on past the gate and offered to enable it anyway",
    ).toBe(false);
  });

  it("carries on when the sign-in worked", async () => {
    // The probe decides, not the exit code: `claude auth login` exiting 0
    // means the command finished, which is not the same as this machine
    // being able to answer a prompt. Believing the exit code would put the
    // whole point of the gate back where it started.
    let probes = 0;
    const result = await runSetup(
      paths,
      answering(["studio", "y", "y", "n", "n"]),
      onlyClaude,
      noServers,
      () => {
        probes += 1;
        return Promise.resolve(probes === 1 ? signedOut : signedIn);
      },
      () => Promise.resolve(true),
    );

    expect(result.wrote).toBe(true);
    expect(result.services).toEqual(["claude"]);
    expect(probes).toBeGreaterThan(1);
  });

  it("re-probes rather than trusting a login that exited cleanly", async () => {
    // A login command can exit 0 having done nothing — the person closed the
    // browser tab, or picked the wrong account. Three rounds, then it stops.
    const result = await runSetup(
      paths,
      answering(["studio", "y", "y", "y", "n"]),
      onlyClaude,
      noServers,
      () => Promise.resolve(signedOut),
      () => Promise.resolve(true),
    );

    expect(result.wrote).toBe(false);
    expect(err).toContain("not signed in");
    expect(
      asked.some((question) => question.includes("your own jobs")),
      "three failed rounds and the wizard still offered to enable it",
    ).toBe(false);
  });

  it("says the CLI's own words, which are the ones that name the fix", async () => {
    await runSetup(
      paths,
      answering(["studio", "n", "n", "n", "n"]),
      onlyClaude,
      noServers,
      () => Promise.resolve(signedOut),
      () => Promise.resolve(false),
    );
    expect(out).toContain("Invalid API key");
  });
});

describe("the two questions at the end", () => {
  const working = () =>
    Promise.resolve<Detected>({ installed: true, answers: true });

  it("pairs and installs, and says so as one fact", async () => {
    const ran: string[][] = [];
    const result = await runSetup(
      paths,
      answering(["studio", "y", "y", "y"]),
      onlyClaude,
      noServers,
      working,
      () => Promise.resolve(true),
      (argv) => {
        ran.push([...argv]);
        return Promise.resolve(0);
      },
    );

    expect(ran).toEqual([["connect", "--name", "studio"], ["install"]]);
    expect(result.connected).toBe(true);
    expect(result.running).toBe(true);
    // The ending is a true sentence and somewhere to prove it, not a list of
    // commands somebody has already been spared.
    expect(out).toContain("paired, and running in the background");
    expect(out).toContain("test.byollm.cloud");
  });

  it("treats a no as a decision, and hands over the one command", async () => {
    // Not a warning. Somebody who declines has chosen; what they need is the
    // line that finishes it later, not to be told they should have said yes.
    const ran: string[][] = [];
    const result = await runSetup(
      paths,
      answering(["studio", "y", "n"]),
      onlyClaude,
      noServers,
      working,
      () => Promise.resolve(true),
      (argv) => {
        ran.push([...argv]);
        return Promise.resolve(0);
      },
    );

    expect(ran).toEqual([]);
    expect(result.wrote).toBe(true);
    expect(result.connected).toBe(false);
    expect(out).toContain("byollm connect --name");
  });

  it("hands over both commands when somebody declines the background", async () => {
    // A person who pairs and says no to the service has chosen to run it
    // themselves, and needs the two ways to do that — not a warning that they
    // should have said yes.
    const ran: string[][] = [];
    const result = await runSetup(
      paths,
      answering(["studio", "y", "y", "n"]),
      onlyClaude,
      noServers,
      working,
      () => Promise.resolve(true),
      (argv) => {
        ran.push([...argv]);
        return Promise.resolve(0);
      },
    );

    expect(ran).toEqual([["connect", "--name", "studio"]]);
    expect(result.connected).toBe(true);
    expect(result.running).toBe(false);
    expect(out).toContain("Paired, and not running");
    expect(out).toContain("byollm install");
    expect(out).toContain("byollm run");
  });

  it("says the device is paired even when the service would not install", async () => {
    /**
     * The half-done state, said as two facts rather than one failure.
     *
     * `install` can fail for reasons that have nothing to do with pairing — a
     * launch agent directory that is not writable, a Windows box without the
     * permission. Reporting that as "setup failed" would send somebody back
     * to redo a pairing that is already good.
     */
    const result = await runSetup(
      paths,
      answering(["studio", "y", "y", "y"]),
      onlyClaude,
      noServers,
      working,
      () => Promise.resolve(true),
      (argv) => Promise.resolve(argv[0] === "install" ? 1 : 0),
    );

    expect(result.connected).toBe(true);
    expect(result.running).toBe(false);
    expect(out).toContain("Paired, and could not install");
  });

  it("does not offer to run in the background before it is paired", async () => {
    /**
     * Order is the point. Pairing can fail for reasons this wizard cannot fix
     * — no network, a draining hub, a code that expired while somebody found
     * their phone — and installing a service for a device that is not paired
     * produces a background process with nothing to do and no way to say so.
     */
    const ran: string[][] = [];
    const result = await runSetup(
      paths,
      answering(["studio", "y", "y", "y"]),
      onlyClaude,
      noServers,
      working,
      () => Promise.resolve(true),
      (argv) => {
        ran.push([...argv]);
        return Promise.resolve(argv[0] === "connect" ? 1 : 0);
      },
    );

    expect(ran).toEqual([["connect", "--name", "studio"]]);
    expect(result.running).toBe(false);
    expect(out).toContain("Pairing did not finish");
  });
});

describe("two servers of the same kind", () => {
  it("gives the second its own key rather than replacing the first", async () => {
    /**
     * A plain assignment would have written both under `ollama`, and the
     * second would have silently replaced the first — one server in the
     * config, one of them unreachable, and nothing on screen saying which.
     *
     * `defaults` and `byollm offer` refer to services by these keys, so they
     * also have to be typeable: "Ollama" becomes `ollama`, and the collision
     * gets a suffix rather than a hash.
     */
    const result = await runSetup(
      paths,
      answering(["studio", "1,2", "n"]),
      () => Promise.resolve(false),
      () =>
        Promise.resolve([
          { label: "Ollama", baseUrl: "http://127.0.0.1:11434", models: ["a"] },
          { label: "Ollama", baseUrl: "http://127.0.0.1:11435", models: ["b"] },
        ]),
      () => Promise.resolve<Detected>({ installed: true, answers: true }),
      () => Promise.resolve(true),
      () => Promise.resolve(0),
    );

    expect(result.services).toEqual(["ollama", "ollama-2"]);
  });
});

describe("the login invocations, which were verified rather than assumed", () => {
  /**
   * `claude login` is not a command. `claude auth login` is.
   *
   * Checked by running both against the shipped CLIs before this was written
   * — the FIXED_ARGV precedent — because a guessed subcommand produces a gate
   * that always fails, on the path a new person meets first.
   */
  it("knows how each CLI signs in", () => {
    expect(loginCommandFor("claude-cli")?.argv).toEqual([
      "claude",
      "auth",
      "login",
    ]);
    expect(loginCommandFor("codex-cli")?.argv).toEqual(["codex", "login"]);
  });

  it("has nothing to spawn for a backend with no login of its own", () => {
    // `undefined` is "this module has nothing to run", not "cannot log in" —
    // the caller falls back to asking rather than inventing a command.
    expect(loginCommandFor("ollama")).toBeUndefined();
  });
});

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { writeServiceStates } from "./service-states.js";
import { removeTemp } from "./test-support.js";

/**
 * `start` names a service that cannot sign in — B036b, rebuilt as B047.
 *
 * Kevin's daemon started cleanly on Windows and served nothing, because
 * `claude` was signed out. Everything was working: the task registered, the
 * process ran, `status` was honest — and the one screen he was watching said
 * the install had succeeded.
 *
 * ## Why the first version of this was still silent for him
 *
 * It read services.json — what the daemon's own probe had recorded — and
 * that is the right source for a passive line and the wrong one here.
 * `installService` waits for the daemon to be ALIVE, not for its first probe
 * to have finished and been written; a probe is a real network call. So on a
 * machine he had just signed out of, the file still said healthy, and on a
 * fresh machine there was no file at all. "Absent is not signed-out" then
 * correctly said nothing, twice.
 *
 * So the check asks the backend NOW, and REPLACES the read-back rather than
 * joining it. The tests below keep both halves honest: the live answer is
 * used, and a stale file cannot speak over it in either direction.
 */
let home: string;
let paths: DaemonPaths;
let out: string;
let err: string;
let asked: string[];

const io = (): Partial<CliIo> => ({
  out: (text) => {
    out += text;
  },
  err: (text) => {
    err += text;
  },
  confirm: () => Promise.resolve(false),
});

/** A supervisor that agrees to everything and reports the daemon running. */
const service = () => ({
  platform: "linux" as const,
  execPath: process.execPath,
  scriptPath: join(home, "byollm"),
  home,
  uid: 0,
  run: (command: readonly string[]) =>
    Promise.resolve({
      code: 0,
      output: command.includes("is-active") ? "active" : "",
    }),
  wait: () => Promise.resolve(),
});

/** One `claude` service, which is the backend with a sign-in to offer. */
async function configWithClaude(): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  await writeFile(
    paths.config,
    JSON.stringify({
      services: {
        claude: {
          model: "sonnet",
          kinds: ["llm.generate"],
          type: "claude-cli",
        },
      },
    }),
  );
}

const signedOut = () =>
  Promise.resolve({
    answers: false as const,
    detail: "the claude CLI is not signed in",
  });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-startsays-"));
  paths = daemonPaths(home);
  out = "";
  err = "";
  asked = [];
});

afterEach(async () => {
  await removeTemp(home);
});

describe("byollm start, when a backend is signed out", () => {
  it("says which, and how to fix it, without calling the start a failure", async () => {
    await configWithClaude();

    const code = await runCli(["start"], {
      paths,
      io: io(),
      service: service(),
      interactive: true,
      platform: "linux",
      verify: signedOut,
      login: () => Promise.resolve(false),
      ask: () => Promise.resolve("n"),
    });

    expect(err).toContain("claude");
    expect(err).toContain("needs sign-in");
    expect(err, "the remedy the backend itself supplies").toContain(
      "run `claude`",
    );
    /* The start worked. Reporting it as a failure would send somebody to
       re-run an install that has nothing wrong with it. */
    expect(code).toBe(0);
    expect(out).toContain("TEST YOUR DEVICE");
  });

  /**
   * Kevin's case, exactly: the daemon's record says healthy because it was
   * healthy when the record was written, and the person signed out after.
   *
   * This is the test the old design could not pass. It is written against the
   * stale file rather than an absent one deliberately — absent was already
   * covered by "say nothing", and a stale file is the failure that looked
   * like working software.
   */
  it("believes the backend, not a file written before the sign-out", async () => {
    await configWithClaude();
    await writeServiceStates(
      paths.serviceStates,
      new Map([
        ["claude", { state: { kind: "answers" as const, model: "sonnet" } }],
      ]),
    );

    await runCli(["start"], {
      paths,
      io: io(),
      service: service(),
      interactive: true,
      platform: "linux",
      verify: signedOut,
      login: () => Promise.resolve(false),
      ask: () => Promise.resolve("n"),
    });

    expect(err).toContain("needs sign-in");
  });

  it("says nothing when the backend answers", async () => {
    await configWithClaude();
    await runCli(["start"], {
      paths,
      io: io(),
      service: service(),
      interactive: true,
      platform: "linux",
      verify: () => Promise.resolve({ answers: true as const }),
      login: () => Promise.resolve(false),
    });
    /* Nothing at all, not merely no sign-in line. Without the filter this
       prints a row for every healthy service on every start — noise on the
       screen whose whole job is to say the one thing that is wrong, and an
       assertion that only looked for "needs sign-in" would not have noticed. */
    expect(err.trim()).toBe("");
  });

  it("says nothing when there was no way to ask", async () => {
    /**
     * The control, and the rule it protects: **`undefined` is not `false`.**
     * A local model server with no canary has not failed a check; it has not
     * had one. Rendering that as signed-out would put "needs sign-in" on
     * every Ollama user in the product.
     */
    await configWithClaude();
    await runCli(["start"], {
      paths,
      io: io(),
      service: service(),
      interactive: true,
      platform: "linux",
      verify: () => Promise.resolve({ answers: undefined }),
      login: () => Promise.resolve(false),
    });
    expect(err.trim()).toBe("");
  });

  it("spends nothing and asks nothing under a supervisor", async () => {
    /**
     * The preflight is a terminal feature for a person at a terminal. A
     * supervisor respawning the daemon at logon cannot answer a prompt, and
     * a canary costs real money on a metered backend — so a machine that
     * restarts ten times overnight must not verify ten times.
     *
     * Asserting the SPEND, not only the silence: a version that verified and
     * then declined to print would pass a silence-only check while quietly
     * spending on every restart.
     */
    await configWithClaude();
    let verifications = 0;
    await runCli(["start"], {
      paths,
      io: io(),
      service: service(),
      interactive: false,
      platform: "linux",
      verify: () => {
        verifications += 1;
        return signedOut();
      },
      login: () => Promise.resolve(false),
    });
    expect(verifications).toBe(0);
    expect(err).not.toContain("needs sign-in");
  });

  it("offers the sign-in, and takes no for an answer", async () => {
    await configWithClaude();
    let logins = 0;
    await runCli(["start"], {
      paths,
      io: {
        ...io(),
        confirm: () => Promise.resolve(false),
      },
      service: service(),
      interactive: true,
      platform: "linux",
      verify: signedOut,
      login: () => {
        logins += 1;
        return Promise.resolve(true);
      },
      ask: (question) => {
        asked.push(question);
        return Promise.resolve("n");
      },
    });
    expect(asked.join("")).toContain("Sign in to claude now?");
    expect(logins, "declining is a decision, not a round to repeat").toBe(0);
  });

  it("on Windows prints the command rather than offering to open it", async () => {
    /* B049's ruling, on this surface too: Node cannot spawn an npm `.cmd`
       without a shell, so the offer would be one it could not keep. */
    await configWithClaude();
    let logins = 0;
    await runCli(["start"], {
      paths,
      io: io(),
      service: service(),
      interactive: true,
      platform: "win32",
      verify: signedOut,
      login: () => {
        logins += 1;
        return Promise.resolve(true);
      },
      ask: (question) => {
        asked.push(question);
        return Promise.resolve("y");
      },
    });
    expect(logins).toBe(0);
    expect(asked, "nothing to ask when there is nothing to offer").toEqual([]);
    expect(err).toContain("claude auth login");
  });
});

/**
 * And `run`, which had no signed-out surface at all — B047.
 *
 * `signedOutLines` had exactly one caller and it was `start`. Somebody
 * running the foreground daemon — on Windows, the path that reliably works —
 * saw a serving line and nothing else, for services that could not serve.
 */
describe("byollm run, when a backend is signed out", () => {
  it("says so before it says it is serving", async () => {
    await configWithClaude();
    const code = await runCli(["run"], {
      paths,
      io: io(),
      service: service(),
      interactive: true,
      supervised: false,
      platform: "linux",
      verify: signedOut,
      login: () => Promise.resolve(false),
      ask: () => Promise.resolve("n"),
    });

    expect(err).toContain("needs sign-in");
    /* Before, not after. A warning printed under the line that says
       everything is fine is a warning somebody scrolls past. */
    const warned = err.indexOf("needs sign-in");
    expect(warned).toBeGreaterThan(-1);
    /* Nothing is paired, so `run` exits 2 having said so — that is this
       machine's honest answer and not what is under test here. What matters
       is that the sign-in line was reached at all, which it never was. */
    expect(code).toBe(2);
  });

  it("spends nothing when a supervisor started it", async () => {
    await configWithClaude();
    let verifications = 0;
    await runCli(["run"], {
      paths,
      io: io(),
      service: service(),
      interactive: false,
      supervised: true,
      platform: "linux",
      verify: () => {
        verifications += 1;
        return signedOut();
      },
      login: () => Promise.resolve(false),
    });
    expect(verifications).toBe(0);
  });
});

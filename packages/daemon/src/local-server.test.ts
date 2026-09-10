import type { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { removeTemp } from "./test-support.js";
import {
  binaryOnPath,
  ensureLocalServer,
  isStartable,
  isLoopback,
  spawnLocalServer,
  startability,
  startCommandFor,
} from "./local-server.js";

/**
 * B050 — start a local model server when a job needs it, and only then.
 *
 * The ruling's shape: nothing pre-warmed, nothing kept resident, cleanup left
 * to the runtime. So the cases worth testing are the ones where this must
 * NOT run a program.
 */
describe("which servers this knows how to start", () => {
  it("knows ollama", () => {
    expect(startCommandFor("ollama")).toEqual(["ollama", "serve"]);
  });

  it("says nothing for the ones it has not verified", () => {
    /**
     * Not "cannot be started" — "this module has nothing to spawn". The
     * login commands set the precedent: they were checked by running them,
     * and a guessed one would have produced a gate that always failed on the
     * path a new person meets first. An id with no entry behaves exactly as
     * it did before this existed.
     */
    for (const id of ["vllm", "jan", "localai", "llamacpp"] as const) {
      expect(startCommandFor(id), id).toBeUndefined();
    }
  });

  it("says nothing for a backend that is not a local server at all", () => {
    expect(startCommandFor("claude-cli")).toBeUndefined();
    expect(startCommandFor("openai")).toBeUndefined();
  });
});

describe("whether a url is on this machine", () => {
  it("accepts the loopback spellings", () => {
    for (const url of [
      "http://127.0.0.1:11434/v1",
      "http://localhost:11434/v1",
      "http://[::1]:11434/v1",
    ]) {
      expect(isLoopback(url), url).toBe(true);
    }
  });

  it("refuses anything else, including a name that might resolve here", () => {
    /* Hostname only, and deliberately not a DNS lookup: a name that resolves
       to a loopback address today is a name somebody else controls tomorrow,
       and this decides whether to run a program. */
    for (const url of [
      "http://192.168.1.10:11434/v1",
      "https://models.example.com/v1",
      "http://ollama.internal/v1",
      "not a url",
    ]) {
      expect(isLoopback(url), url).toBe(false);
    }
  });
});

function harness(over: { answers?: boolean[]; baseUrl?: string } = {}) {
  const spawned: string[][] = [];
  const said: string[] = [];
  const answers = over.answers ?? [false, true];
  let asked = 0;
  return {
    spawned,
    said,
    asked: () => asked,
    input: {
      id: "ollama" as const,
      baseUrl: over.baseUrl ?? "http://127.0.0.1:11434/v1",
      answers: () => {
        const answer = answers[Math.min(asked, answers.length - 1)] ?? false;
        asked += 1;
        return Promise.resolve(answer);
      },
      spawn: (command: readonly string[]) => spawned.push([...command]),
      wait: () => Promise.resolve(),
      report: (line: string) => said.push(line),
      withinMs: 50,
      pollMs: 1,
    },
  };
}

describe("starting one on demand", () => {
  it("does nothing at all when it is already answering", async () => {
    /* The case that runs every time in production. Spawning here would mean
       a second server process on every job. */
    const h = harness({ answers: [true] });
    expect(await ensureLocalServer(h.input)).toBe("already-running");
    expect(h.spawned).toEqual([]);
    expect(h.said).toEqual([]);
  });

  it("does not even ask when there is nothing it could do about it", async () => {
    /**
     * Startability is checked before health, and the order is the point: the
     * other way round costs a request per job on every backend in the
     * product, including the ones this has no command for and the remote
     * endpoints it would never touch. A question whose answer cannot change
     * what happens next is a request nobody needed, on the hot path.
     */
    const remote = harness({
      answers: [false, true],
      baseUrl: "https://models.example.com/v1",
    });
    expect(await ensureLocalServer(remote.input)).toBe("not-startable");
    expect(remote.asked(), "a remote endpoint must not be probed").toBe(0);

    const unknown = harness({ answers: [false, true] });
    expect(await ensureLocalServer({ ...unknown.input, id: "vllm" })).toBe(
      "not-startable",
    );
    expect(unknown.asked()).toBe(0);
  });

  it("starts it, then waits for it to answer", async () => {
    const h = harness({ answers: [false, true] });
    expect(await ensureLocalServer(h.input)).toBe("started");
    expect(h.spawned).toEqual([["ollama", "serve"]]);
    expect(h.said.join("")).toContain("starting it");
  });

  it("never starts anything for a remote endpoint", async () => {
    /**
     * The refusal that matters most. A configured baseUrl can point
     * anywhere, and running a local command because a REMOTE endpoint is
     * down is nonsense at best — at worst it succeeds and serves a different
     * model than the one configured, on a port that happens to match.
     */
    const h = harness({
      answers: [false, true],
      baseUrl: "https://models.example.com/v1",
    });
    expect(await ensureLocalServer(h.input)).toBe("not-startable");
    expect(h.spawned).toEqual([]);
  });

  it("never starts anything for a backend it has no command for", async () => {
    const h = harness({ answers: [false, true] });
    expect(await ensureLocalServer({ ...h.input, id: "vllm" })).toBe(
      "not-startable",
    );
    expect(h.spawned).toEqual([]);
  });

  it("gives up rather than waiting forever, and says it tried", async () => {
    /* The job then fails on the backend's own terms, which is the better
       sentence: the backend knows what it asked for and what came back. This
       adds only the part the backend cannot know. */
    const h = harness({ answers: [false] });
    expect(await ensureLocalServer(h.input)).toBe("gave-up");
    expect(h.spawned).toHaveLength(1);
    expect(h.said.join("")).toContain("did not come up");
  });

  it("spawns once, however long it takes to answer", async () => {
    /* A retry loop that re-spawned would leave a pile of half-started
       servers on a machine that is merely slow. */
    const h = harness({ answers: [false, false, false, true] });
    expect(await ensureLocalServer(h.input)).toBe("started");
    expect(h.spawned).toHaveLength(1);
  });
});

describe("the runner's own guard on starting servers", () => {
  /**
   * Read from the source, because the property is an absence and the thing
   * that would break it is a line somebody deletes — B050.
   *
   * `spawnServer` is absent by default and only the job-running daemon
   * passes one. Without that, `connect`, `services` and `status` — which all
   * build a Runner to ask a question — could start a model server as a side
   * effect of being run.
   */
  const runner = readFileSync(
    fileURLToPath(new URL("./runner.ts", import.meta.url)),
    "utf8",
  );

  it("does nothing when no spawn seam was given", () => {
    const guard = runner.slice(
      runner.indexOf("async #ensureLocalServer("),
      runner.indexOf("async runJob("),
    );
    expect(guard).toContain("spawnServer === undefined) return");
    /* First, before the class check and before anything is asked. */
    expect(guard.indexOf("spawnServer === undefined")).toBeLessThan(
      guard.indexOf("backendClass"),
    );
  });

  it("only asks about HTTP-class services", () => {
    /* A process backend has no url to start and no server behind it. */
    const guard = runner.slice(
      runner.indexOf("async #ensureLocalServer("),
      runner.indexOf("async runJob("),
    );
    expect(guard).toContain('route.backendClass !== "http"');
  });

  it("is called at all, before the backend is asked to execute", () => {
    /**
     * Presence first, and that is not belt-and-braces — it is the bug this
     * test had. `indexOf` returns -1 for a call that is not there, and -1 is
     * less than every real index, so an ordering assertion on its own passes
     * most convincingly when the thing has been deleted.
     */
    const body = runner.slice(runner.indexOf("async #runOnBackend("));
    const ensure = body.indexOf("#ensureLocalServer(route, backend)");
    const execute = body.indexOf("backend.execute(");
    expect(ensure, "the call is gone").toBeGreaterThan(-1);
    expect(execute).toBeGreaterThan(-1);
    /* After would be a start that helps the next job and not this one. */
    expect(ensure).toBeLessThan(execute);

    /**
     * And both are on the far side of the memory guard — B080.
     *
     * They were moved into `#runOnBackend` for exactly that reason: starting
     * a server and asking it are the two expensive halves, and the gate has
     * to precede both. This test found the move, correctly, by the call not
     * being where it looked.
     *
     * The ordering itself is proven behaviourally in `memory-caller.test.ts`
     * — a refused job never spawns, with the control that a job with room
     * does — which is stronger than reading source. This line only holds the
     * two calls together so they cannot drift back apart onto opposite sides
     * of the guard.
     */
    const caller = runner.slice(runner.indexOf("async runJob("));
    const gate = caller.indexOf("#memoryDecision(route, job.id)");
    const runOn = caller.indexOf("#runOnBackend(");
    expect(gate, "the guard is gone").toBeGreaterThan(-1);
    expect(runOn).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(runOn);
  });
});

describe("whether a stopped server may still be advertised", () => {
  /**
   * B056 / D4. The ruling: a configured-but-stopped LOCAL server advertises,
   * because it is available one spawn away and B050 starts it at job time.
   *
   * The line it must not cross is a config that names a server nobody
   * installed. Advertising that turns a site's clean no-runner silence into a
   * claimed-then-failed job — strictly worse for them than saying nothing —
   * so "installed and startable" has to be answerable about the MACHINE, not
   * about the file.
   */
  const present = () => Promise.resolve(true);
  const absent = () => Promise.resolve(false);

  it("advertises ollama that is installed and merely stopped", async () => {
    expect(
      await isStartable({
        id: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        onPath: present,
      }),
    ).toBe(true);
  });

  it("refuses a config naming a server this machine does not have", async () => {
    /* The whole point of asking PATH. Without it, `type: "ollama"` in a
       config file is enough to claim work forever. */
    expect(
      await isStartable({
        id: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        onPath: absent,
      }),
    ).toBe(false);
  });

  it("refuses a remote endpoint, however installed we are locally", async () => {
    /* A local `ollama serve` does not fix a server on another machine, and
       starting one would serve a DIFFERENT model than the config names. */
    expect(
      await isStartable({
        id: "ollama",
        baseUrl: "https://models.example.com/v1",
        onPath: present,
      }),
    ).toBe(false);
  });

  it("refuses a backend whose start command we have not verified", async () => {
    expect(
      await isStartable({
        id: "vllm",
        baseUrl: "http://127.0.0.1:8000/v1",
        onPath: present,
      }),
    ).toBe(false);
  });
});

describe("finding a binary on PATH", () => {
  /**
   * Against a directory this test makes, never against the host's own.
   *
   * The first version looked for `/bin/sh`, which is a POSIX assumption
   * wearing a `platform` argument — that argument only chooses PATHEXT, and
   * Windows CI has no `/bin/sh` to find. Caught by the one platform I cannot
   * run here, which is the second time this week.
   */
  let bin: string;
  beforeEach(async () => {
    bin = await mkdtemp(join(tmpdir(), "byollm-onpath-"));
    await writeFile(join(bin, "probe"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "probe"), 0o755);
    /* Executable too: POSIX checks the execute bit and Windows has none, so
       without the chmod this passes on CI and fails on a laptop — the same
       host-dependence in the other direction. */
    await writeFile(join(bin, "winonly.EXE"), "");
    await chmod(join(bin, "winonly.EXE"), 0o755);
  });

  it("finds one that is there, by looking rather than by running it", async () => {
    /* `ollama --version` would answer this and would also start work on
       somebody's machine as a side effect of an advertising decision — and
       this runs on a heartbeat. */
    expect(await binaryOnPath("probe", { PATH: bin }, "linux")).toBe(true);
  });

  it("does not find one that is not", async () => {
    expect(
      await binaryOnPath("definitely-not-here-9x", { PATH: bin }, "linux"),
    ).toBe(false);
  });

  it("says no rather than throwing when PATH is empty", async () => {
    expect(await binaryOnPath("probe", {}, "linux")).toBe(false);
  });

  it("consults PATHEXT on Windows", async () => {
    /* A Windows executable carries its extension, so looking for a bare name
       finds nothing — which would report every Windows machine as having no
       model server installed. */
    expect(
      await binaryOnPath("winonly", { PATH: bin, PATHEXT: ".EXE" }, "win32"),
    ).toBe(true);
  });

  it("does not match a bare name on Windows", async () => {
    /* The control on the case above: `probe` exists with no extension, and
       on Windows that is not an executable name. */
    expect(
      await binaryOnPath("probe", { PATH: bin, PATHEXT: ".EXE" }, "win32"),
    ).toBe(false);
  });
});

describe("starting a local server for real — B092", () => {
  /**
   * The production spawn, run rather than described.
   *
   * `spawnServer` sat unpassed for four releases with its own comment saying
   * the daemon that runs jobs passes one — while none did. The seam is now
   * wired, and the thing on the end of it is exercised here: an inline
   * closure in `cli.ts` would be a line nothing could reach.
   */
  it("actually runs the command it is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "byollm-spawn-"));
    try {
      const marker = join(dir, "started");
      const errors: string[] = [];
      spawnLocalServer(
        [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "up")`,
        ],
        (message) => errors.push(message),
      );

      /* Waited for rather than slept on: the child is detached, so there is
         no exit to await, and a fixed sleep would encode a guess about how
         fast a process starts on a loaded CI runner. */
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !existsSync(marker)) {
        await new Promise((wake) => setTimeout(wake, 20));
      }
      expect(
        existsSync(marker),
        "the spawned command never ran — the seam is wired to nothing",
      ).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await removeTemp(dir);
    }
  });

  it("survives a binary that is not there, rather than taking the daemon down", async () => {
    /**
     * `isStartable` checked PATH a moment earlier; this is the race between
     * then and now — an uninstall, a PATH change, a package manager mid-swap.
     * An unhandled `error` on a child process ends the process that is
     * supposed to be serving jobs, so "ollama went away" has to be a job that
     * fails and not a daemon that dies.
     */
    const errors: string[] = [];
    expect(() => {
      spawnLocalServer(["byollm-no-such-program-exists", "serve"], (message) =>
        errors.push(message),
      );
    }).not.toThrow();

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && errors.length === 0) {
      await new Promise((wake) => setTimeout(wake, 20));
    }
    expect(errors[0], "the failure was swallowed silently").toContain(
      "could not start byollm-no-such-program-exists",
    );
  });

  it("detaches, unreferences, ignores stdio, and never uses a shell", () => {
    /**
     * The three properties that make a spawned server safe to leave running,
     * asserted on the options rather than inferred from behaviour — each has
     * a failure that only shows up later. `shell: false` is the one that
     * would matter if `startCommandFor` ever returned something with a space
     * in it; the other two decide whether a daemon restart kills the server
     * and whether a chatty server can block the daemon.
     */
    const seen: Record<string, unknown>[] = [];
    let unreferenced = false;
    const noop = () => {
      /* The double never has to do anything — the call is the subject. */
    };
    spawnLocalServer(["ollama", "serve"], noop, ((
      _program: string,
      _args: string[],
      options: Record<string, unknown>,
    ) => {
      seen.push(options);
      return {
        on: noop,
        unref: () => {
          unreferenced = true;
        },
      };
    }) as unknown as typeof spawn);
    expect(seen[0]).toMatchObject({
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    /**
     * `unref`, and CW's mutation walked straight through its absence — all
     * 28 tests stayed green with the call deleted.
     *
     * `detached` and `unref` sound like one idea and are two. Detached puts
     * the child in its own process group so it survives its parent; unref
     * takes it off this process's event loop so **byollm can exit at all**
     * while the server it started keeps running. Without it a daemon told to
     * stop stays alive holding a handle to a model server, which is the
     * opposite of the property the doc claims — and the doc said
     * "unreferenced" while nothing checked it.
     */
    expect(
      unreferenced,
      "the child was never unref'd — byollm cannot exit while it runs",
    ).toBe(true);
  });

  it("is passed by the daemon that runs jobs, and by nothing else", () => {
    /**
     * The assertion B092 exists for. The seam being absent by default is a
     * safety property — `status`, `connect` and `services` each build a
     * Runner to ANSWER something and must not launch a process as a side
     * effect. What was missing was passing it in the one place that should:
     * the long-running daemon.
     *
     * Read from the source, because the property is "exactly one call site"
     * and the failure it guards is a line nobody adds. Its absence was noted
     * in a comment for four releases and noticed by nobody, which is the
     * argument for a check rather than a note.
     */
    const cli = readFileSync(
      fileURLToPath(new URL("./cli.ts", import.meta.url)),
      "utf8",
    );
    const passes = [...cli.matchAll(/^\s*spawnServer:/gm)];
    expect(passes, "nothing passes spawnServer — B092 regressed").toHaveLength(
      1,
    );
    /* And it is the daemon's Runner, not one of the question-answering ones:
       the same options object that carries `readMemory`, which only the
       job-running daemon gets. */
    const daemonOptions = cli.slice(
      cli.indexOf("readMemory: readHostMemory"),
      cli.indexOf(
        "onEvent: (event) => {",
        cli.indexOf("readMemory: readHostMemory"),
      ),
    );
    expect(daemonOptions).toContain("spawnServer:");
  });
});

describe("why a service cannot be started — B098", () => {
  /**
   * Three facts, one boolean, and the surface asserted whichever it had a
   * sentence for.
   *
   * On Todd's machine that produced a FALSE INSTRUCTION. His services are
   * `openai-http` at loopback addresses; `startCommandFor` knows a command
   * for `ollama` only, so they were unstartable — and `byollm status` told
   * him to **install** Ollama and MLX, both of which were installed and
   * serving. An afternoon spent on a fix that was never the problem.
   *
   * Same shape as B105 one row earlier: one bucket for two facts, and the
   * bucket names the wrong one.
   */
  const present = () => Promise.resolve(true);
  const absent = () => Promise.resolve(false);

  it("says no command, for a backend this module cannot start", async () => {
    /* Todd's case exactly: an OpenAI-compatible service at Ollama's own
       loopback port. The program is there; we simply have no command for
       that id. */
    expect(
      await startability({
        id: "openai-http",
        baseUrl: "http://127.0.0.1:11434/v1",
        onPath: present,
      }),
    ).toEqual({ startable: false, why: "no-start-command" });
  });

  it("says not installed only when the binary is really absent", async () => {
    /* The one case where "install it" is the right thing to say. */
    expect(
      await startability({
        id: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        onPath: absent,
      }),
    ).toEqual({ startable: false, why: "not-installed" });
  });

  it("says not local for a remote address, which no local spawn fixes", async () => {
    expect(
      await startability({
        id: "ollama",
        baseUrl: "https://ollama.example.com/v1",
        onPath: present,
      }),
    ).toEqual({ startable: false, why: "not-local" });
  });

  it("still says yes when it can, which is the control", async () => {
    /* Without this, "always refuse" satisfies every case above. */
    expect(
      await startability({
        id: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        onPath: present,
      }),
    ).toEqual({ startable: true });
  });

  it("keeps the boolean answering the same question it always did", async () => {
    /* `isStartable` decides what the fleet OFFERS, and B098 changed what the
       surface SAYS. A reason threaded into the advertising decision would be
       an invitation to branch on it there. */
    for (const [id, url, onPath, expected] of [
      ["openai-http", "http://127.0.0.1:11434/v1", present, false],
      ["ollama", "http://127.0.0.1:11434/v1", absent, false],
      ["ollama", "https://ollama.example.com/v1", present, false],
      ["ollama", "http://127.0.0.1:11434/v1", present, true],
    ] as const) {
      expect(
        await isStartable({ id, baseUrl: url, onPath }),
        `${id} ${url}`,
      ).toBe(expected);
    }
  });
});

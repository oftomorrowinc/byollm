import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ensureLocalServer,
  isLoopback,
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
    const body = runner.slice(runner.indexOf("async runJob("));
    const ensure = body.indexOf("#ensureLocalServer(route, backend)");
    const execute = body.indexOf("await backend.execute(");
    expect(ensure, "the call is gone").toBeGreaterThan(-1);
    expect(execute).toBeGreaterThan(-1);
    /* After would be a start that helps the next job and not this one. */
    expect(ensure).toBeLessThan(execute);
  });
});

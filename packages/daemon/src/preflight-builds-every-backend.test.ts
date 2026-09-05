import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendDescriptor, BACKENDS } from "@byollm/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { removeTemp } from "./test-support.js";

/**
 * The preflight can build a backend for every service somebody can configure.
 *
 * CW's rider on B047, and the reason for it is the interesting part: the
 * first version of the preflight built backends from the id alone, and an
 * HTTP-class transport throws in its constructor without a `baseUrl`. That
 * crashed `byollm run` outright for anybody serving Ollama — on the ordinary
 * path, not an edge — and what caught it was a test about revocation that
 * happened to run `run` with an openai-http service in its config.
 *
 * Luck. The comment and the type that replaced it are not a check, so this
 * is the check: the DEFAULT verify path, no seam injected, over every
 * backend id the registry knows.
 *
 * It asserts the absence of a crash, which is a shape worth being careful
 * about — an absence-shaped assertion passes when the thing under test never
 * ran. So the config is real, the ids come from the registry rather than a
 * list here (a new backend joins this test by existing), and the urls point
 * at a closed port so the verification actually happens and actually fails,
 * which is a different outcome from never being attempted.
 */
let home: string;
let paths: DaemonPaths;
const io = (): Partial<CliIo> => ({
  out: () => undefined,
  err: () => undefined,
  confirm: () => Promise.resolve(false),
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-preflight-"));
  paths = daemonPaths(home);
});

afterEach(async () => {
  await removeTemp(home);
});

describe("the preflight's default verify path", () => {
  const ids = Object.keys(BACKENDS) as (keyof typeof BACKENDS)[];

  it("knows about more than one backend, or this proves nothing", () => {
    /* The control on the control. If the registry import ever resolves to
       an empty object, every it.each below silently becomes zero tests and
       this file passes by running nothing at all. */
    expect(ids.length).toBeGreaterThan(1);
    expect(ids.some((id) => backendDescriptor(id).class === "http")).toBe(true);
    expect(ids.some((id) => backendDescriptor(id).class === "process")).toBe(
      true,
    );
  });

  it.each(ids)("builds %s without throwing", async (id) => {
    await mkdir(paths.root, { recursive: true });
    await writeFile(
      paths.config,
      JSON.stringify({
        services: {
          only: {
            model: "m",
            kinds: ["llm.generate"],
            type: id,
            /* Meaningless to a process backend and required by an HTTP one.
               Port 1 is closed, so the HTTP canary makes a real attempt and
               fails, rather than being skipped. */
            baseUrl: "http://127.0.0.1:1/v1",
          },
        },
      }),
    );

    /* No `verify` and no `login` — the defaults are the thing under test.
       `ask` is injected because a signed-out answer would otherwise reach
       for a terminal that is not there. */
    const code = await runCli(["run"], {
      paths,
      io: io(),
      interactive: true,
      supervised: false,
      platform: "linux",
      ask: () => Promise.resolve("n"),
    });

    /* Nothing is paired, so `run` refuses with 2 — reached only by getting
       through the preflight, which is the whole assertion. A throw would
       come out of runCli, not as an exit code. */
    expect(code).toBe(2);

    /**
     * Deliberately NOT asserting that a line was printed.
     *
     * The first draft of this asserted the signed-out line for HTTP-class
     * services and failed, and the code was right: HTTP backends have no
     * canary, so `backendVerifier` returns `answers: undefined` — "there was
     * no way to ask", which the tri-state exists to keep distinct from "it
     * said no". A local model server is not signed out; it is unasked. So
     * the preflight is silent for every HTTP service by design, and an
     * assertion that it spoke would have been an assertion that the
     * tri-state was broken.
     *
     * What keeps this from being a test that passes by running nothing is
     * not an assertion here. It is the registry control above, and the
     * mutation on the record: reverting to `createBackend(id, {})` reddens
     * six of these cases.
     */
  });
});

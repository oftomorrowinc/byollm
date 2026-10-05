import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readServiceStates, writeServiceStates } from "./service-states.js";

/**
 * The probe writes; a different process reads.
 *
 * `byollm status` cannot run the canary itself. It is a separate process, the
 * canary is a real model call, and on a metered backend that is real money —
 * on a command people run repeatedly while something is wrong. So the daemon
 * records what it found and `status` reads it.
 */
const where = async () =>
  join(await mkdtemp(join(tmpdir(), "byollm-states-")), "services.json");

describe("what the probe leaves behind", () => {
  it("round-trips a service that needs signing in", async () => {
    const path = await where();
    await writeServiceStates(
      path,
      new Map([
        [
          "claude",
          {
            state: { kind: "signed-out" as const, detail: "token expired" },
            signIn: "run `claude` in a terminal",
          },
        ],
      ]),
    );
    const back = await readServiceStates(path);
    expect(back.get("claude")).toEqual({
      state: { kind: "signed-out", detail: "token expired" },
      signIn: "run `claude` in a terminal",
    });
  });

  /**
   * B098's offer has to survive the file, or `status` never sees it.
   *
   * The daemon decides the offer and a different process prints it, so a
   * schema that dropped the field would leave the runner right, the renderer
   * right, and the owner reading "start it yourself" exactly as before.
   */
  it("round-trips the type byollm would start, for the unstartable line", async () => {
    const path = await where();
    const report = {
      state: {
        kind: "unstartable" as const,
        model: "glm-5.2:cloud",
        startableAs: "ollama" as const,
      },
    };
    await writeServiceStates(path, new Map([["glm-5.2", report]]));
    expect((await readServiceStates(path)).get("glm-5.2")).toEqual(report);
  });

  /* An id this build does not know costs the offer, never the file: one
     service's unreadable suggestion must not blank every other line. */
  it("drops an offer it cannot read and keeps the service", async () => {
    const path = await where();
    await writeFile(
      path,
      JSON.stringify({
        local: {
          state: { kind: "unstartable", model: "m", startableAs: "vllm-9" },
        },
      }),
      "utf8",
    );
    const back = (await readServiceStates(path)).get("local");
    expect(back?.state).toMatchObject({ kind: "unstartable", model: "m" });
    expect(back?.state).not.toHaveProperty("startableAs", "vllm-9");
  });

  /**
   * Absent is not signed-out.
   *
   * A machine that has never probed has not discovered anything, and `status`
   * must print what it always printed. Reading a missing file as a finding is
   * the same defect as reading an empty variable as a configured one.
   */
  it("says nothing at all when nothing has probed", async () => {
    expect((await readServiceStates(await where())).size).toBe(0);
  });

  it("says nothing at all when the file is unreadable", async () => {
    const path = await where();
    await writeFile(path, "{ this is not json", "utf8");
    expect((await readServiceStates(path)).size).toBe(0);
  });

  /* A shape this build does not understand is not a state either — the same
     rule, one layer down. A future version writing a fourth kind must not make
     an older `status` invent a finding from it. */
  it("ignores a state it cannot read", async () => {
    const path = await where();
    await writeFile(
      path,
      JSON.stringify({ claude: { state: { kind: "on-fire" } } }),
      "utf8",
    );
    expect((await readServiceStates(path)).size).toBe(0);
  });

  /* Latest only. A history here would be a record of the day somebody's
     subscription lapsed and every day it stayed lapsed. */
  it("keeps only what the last probe found", async () => {
    const path = await where();
    await writeServiceStates(
      path,
      new Map([["claude", { state: { kind: "signed-out" as const } }]]),
    );
    await writeServiceStates(
      path,
      new Map([
        ["claude", { state: { kind: "answers" as const, model: "x" } }],
      ]),
    );
    const back = await readServiceStates(path);
    expect(back.get("claude")?.state).toEqual({ kind: "answers", model: "x" });
    expect(back.size).toBe(1);
  });

  /* A probe that cannot write its notes has still probed. */
  it("does not fail when it cannot write", async () => {
    await expect(
      writeServiceStates("/nope/nowhere/services.json", new Map()),
    ).resolves.toBeUndefined();
  });
});

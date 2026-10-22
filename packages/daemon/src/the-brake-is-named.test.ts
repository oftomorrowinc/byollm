/**
 * The community job-count brake, named and movable — 10-22.
 *
 * Lis's writing-assistant jobs on Todd's shared glm-5.2 stopped. `byollm
 * status` showed the metered ceiling at $0.80 of $25.00 and *"20 in the last
 * hour (cap 20)"*, and nothing on the screen said which of those had refused
 * her or how to change it; the cap lived only in a JSON key. These are the
 * three things that were missing: status naming the brake, a command that
 * moves it, and that command reaching the running daemon.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { IngressLog } from "./ingress.js";
import { daemonPaths, type DaemonPaths } from "./paths.js";
import { noSupervisor, removeTemp } from "./test-support.js";

let home: string;
let paths: DaemonPaths;
let out: string;
let err: string;

const run = (argv: string[], env: NodeJS.ProcessEnv = {}) =>
  runCli(argv, {
    paths,
    io: {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
    service: noSupervisor(),
    env,
  });

const METERED_TEAM = {
  services: {
    "glm-5.2": {
      type: "openai",
      model: "glm-5.2",
      kinds: ["llm.generate"],
      offer: "team",
      spend: { acknowledged: true, dailyCapCents: 2500 },
    },
  },
};

const community = async () =>
  (
    JSON.parse(await readFile(paths.config, "utf8")) as {
      community: Record<string, unknown>;
    }
  ).community;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "byollm-brake-"));
  paths = daemonPaths(home);
  out = "";
  err = "";
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.config, JSON.stringify(METERED_TEAM));
});

afterEach(async () => {
  await removeTemp(home);
});

describe("byollm status names the brake", () => {
  const refuse = async (brake: "hourly-cap" | "daily-cap", n: number) => {
    const ingress = new IngressLog({
      path: paths.ingressLog,
      communityPromptDays: 7,
      keepSelfPrompts: true,
    });
    for (let i = 0; i < n; i += 1) {
      await ingress.recordOutcome({
        at: Date.now(),
        jobId: `job_${String(i)}`,
        outcome: "refused",
        detail: "already ran 20 community jobs in the last hour",
        brake,
      });
    }
  };

  it("after an hourly-cap refusal, with the count, the cap and the command", async () => {
    await refuse("hourly-cap", 21);
    expect(await run(["status"])).toBe(0);
    expect(out).toContain(
      "refused 21 in the last hour: hourly cap (20) — raise it: " +
        "byollm budget community --per-hour N",
    );
  });

  it("names the daily cap by its own flag", async () => {
    await refuse("daily-cap", 1);
    await run(["status"]);
    expect(out).toContain(
      "refused 1 in the last hour: daily cap (100) — raise it: " +
        "byollm budget community --per-day N",
    );
  });

  it("says nothing about a brake that has not fired", async () => {
    await run(["status"]);
    expect(out).not.toMatch(/refused \d+ in the last hour/);
    expect(out).not.toContain("raise it");
  });

  it("says team jobs on a metered service are bounded by its ceiling, not the count", async () => {
    // owl #15096: an owner watching this count stop rising must not read it
    // as the thing still protecting them.
    await run(["status"]);
    expect(out).toContain(
      "your team's jobs on glm-5.2 are not counted here — its daily spend " +
        "ceiling bounds them",
    );
  });

  it("drops that sentence when the owner counts team jobs", async () => {
    await writeFile(
      paths.config,
      JSON.stringify({ ...METERED_TEAM, community: { countTeamJobs: true } }),
    );
    await run(["status"]);
    expect(out).not.toContain("daily spend ceiling bounds them");
  });
});

describe("byollm budget community", () => {
  it.each([["0"], ["-1"], ["1.5"], ["abc"], [""], ["1e2"]])(
    "refuses --per-hour %j, and writes nothing",
    async (value) => {
      const before = await readFile(paths.config, "utf8");
      expect(await run(["budget", "community", "--per-hour", value])).toBe(2);
      expect(err).toContain("greater than zero");
      expect(await readFile(paths.config, "utf8")).toBe(before);
    },
  );

  it("refuses a flag with no number after it", async () => {
    expect(await run(["budget", "community", "--per-day"])).toBe(2);
    expect(err).toContain("--per-day takes a whole number");
  });

  it("refuses anything but community", async () => {
    expect(await run(["budget"])).toBe(2);
    expect(await run(["budget", "metered"])).toBe(2);
    expect(err).toContain("usage: byollm budget community");
  });

  it("writes the caps, and leaves the rest of the file as it was", async () => {
    expect(
      await run([
        "budget",
        "community",
        "--per-hour",
        "60",
        "--per-day",
        "400",
      ]),
    ).toBe(0);
    expect(await community()).toMatchObject({
      maxJobsPerHour: 60,
      maxJobsPerDay: 400,
      countTeamJobs: false,
    });
    expect(out).toContain("up to 60 an hour, 400 a day");
    const written = JSON.parse(await readFile(paths.config, "utf8")) as {
      services: Record<string, { offer?: string }>;
    };
    expect(written.services["glm-5.2"]?.offer).toBe("team");
  });

  it("turns team-job counting on and off", async () => {
    await run(["budget", "community", "--count-team-jobs", "yes"]);
    expect((await community())["countTeamJobs"]).toBe(true);
    await run(["budget", "community", "--count-team-jobs", "no"]);
    expect((await community())["countTeamJobs"]).toBe(false);
    expect(await run(["budget", "community", "--count-team-jobs", "1"])).toBe(
      2,
    );
  });

  it("with no flags, says what the caps are and writes nothing", async () => {
    const before = await readFile(paths.config, "utf8");
    expect(await run(["budget", "community"])).toBe(0);
    expect(out).toContain("up to 20 an hour, 100 a day");
    expect(out).toContain("do not count toward");
    expect(await readFile(paths.config, "utf8")).toBe(before);
  });

  it("tells the running daemon, through the supervisor seam", async () => {
    // A pid no machine hands out, so the signal finds nobody: "gone" is the
    // branch that can be driven without signalling a real process.
    await run(["budget", "community", "--per-hour", "60"], {
      BYOLLM_SUPERVISOR_PID: "2147483646",
    });
    expect(out).toContain("supervisor is not answering");
  });
});

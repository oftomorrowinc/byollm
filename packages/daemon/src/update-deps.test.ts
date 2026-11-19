import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DAEMON_VERSION, formatVersion } from "./index.js";
import { spawnCommand } from "./install.js";
import { POSIX_HOST } from "./test-support.js";
import {
  byollmCommand,
  npmCommand,
  realUpdateDeps,
  type Host,
} from "./update-deps.js";

/**
 * The four commands behind the updater — B053.
 *
 * Small on purpose: everything here shells out, so the ordering, the canary
 * and the rollback live in `update.ts` where they can be run. What is worth
 * testing here is the seam where this module reads something another module
 * writes, because that is where it can silently stop working.
 */
function recorder(host: Host = POSIX_HOST) {
  const ran: string[][] = [];
  const said: string[] = [];
  return {
    ran,
    said,
    deps: (
      answer: (command: readonly string[]) => {
        code: number;
        output: string;
      },
    ) =>
      realUpdateDeps({
        run: (command) => {
          ran.push([...command]);
          return Promise.resolve(answer(command));
        },
        drain: () => Promise.resolve({ finished: 0, stillRunning: 0 }),
        report: (line) => said.push(line),
        host,
      }),
  };
}

describe("installing a version", () => {
  it("names an exact version and never a tag", async () => {
    const r = recorder();
    await r.deps(() => ({ code: 0, output: "" })).install("0.1.0-alpha.83");
    expect(r.ran[0]).toEqual([
      "npm",
      "install",
      "--global",
      "--ignore-scripts",
      "--registry=https://registry.npmjs.org",
      "byollm@0.1.0-alpha.83",
    ]);
  });

  it("passes the version as an argument, never through a shell", async () => {
    /* The second of two fences — `exactVersion` has already refused anything
       that is not a literal version. A version string is the argument an
       attacker would most like to see concatenated into a command line, and
       argv means there is nothing left to quote. */
    const r = recorder();
    await r.deps(() => ({ code: 0, output: "" })).install("0.1.0-alpha.83");
    for (const part of r.ran[0] ?? []) {
      expect(part).not.toContain(" ");
      expect(part).not.toContain(";");
    }
  });

  it("keeps npm's own words when the install fails", async () => {
    /* A permissions problem on a system prefix reads nothing like a registry
       outage, and both are somebody's to fix. Our reading of it would throw
       away the line that tells them apart — the same rider the supervisor
       refusal took. */
    const r = recorder();
    const ok = await r
      .deps(() => ({ code: 243, output: "npm ERR! EACCES: permission denied" }))
      .install("0.1.0-alpha.83");
    expect(ok).toBe(false);
    expect(r.said.join("")).toContain("EACCES");
    expect(r.said.join("")).toContain("243");
  });
});

describe("asking the installed binary what it is", () => {
  it("reads the version out of what `--version` actually prints", () => {
    /**
     * The coupling worth a test. This reads a string another module writes,
     * and if `formatVersion` is reworded into a shape the pattern misses,
     * the canary reports `undefined` on a perfectly good install — so every
     * update in the fleet rolls back, and nothing anywhere says why.
     *
     * So the fixture is the real function's real output, not a string typed
     * here to match the regex.
     */
    const printed = formatVersion();
    const found = /^byollm (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/m.exec(printed);
    expect(found?.[1], `pattern missed: ${JSON.stringify(printed)}`).toBe(
      DAEMON_VERSION,
    );
  });

  it("finds it through the deps, from the same output", async () => {
    const r = recorder();
    const reported = await r
      .deps(() => ({ code: 0, output: formatVersion() }))
      .installedVersion();
    expect(reported).toBe(DAEMON_VERSION);
  });

  it("says nothing when the binary will not run", async () => {
    /* `undefined` here is a failed canary, not a third state: this runs
       immediately after an install, so "cannot say" means the thing just
       installed does not answer. */
    const r = recorder();
    const reported = await r
      .deps(() => ({ code: 127, output: "" }))
      .installedVersion();
    expect(reported).toBeUndefined();
  });

  it("says nothing when the output carries no version at all", async () => {
    const r = recorder();
    const reported = await r
      .deps(() => ({ code: 0, output: "byollm (development build)\n" }))
      .installedVersion();
    expect(reported).toBeUndefined();
  });

  it("never mistakes another version on the line for byollm's", async () => {
    /**
     * Found by mutation. The first draft took the first semver-shaped token
     * anywhere in the output, so a reworded first line made it match `node
     * 24.18.0` from the SECOND line — and report node's version as the
     * daemon's. That is not a failed canary but a confidently wrong one:
     * every machine rolls back, and the message says the binary reports
     * 24.18.0.
     */
    const r = recorder();
    const reported = await r
      .deps(() => ({
        code: 0,
        output: "byollm build 0_1_0 (protocol 1)\ndarwin-arm64, node 24.18.0\n",
      }))
      .installedVersion();
    expect(reported).toBeUndefined();
  });
});

describe("re-registering", () => {
  it("runs start, because the entry point moved", async () => {
    const r = recorder();
    await r.deps(() => ({ code: 0, output: "" })).reregister();
    expect(r.ran[0]).toEqual(["byollm", "start"]);
  });

  it("fails when the supervisor refused", async () => {
    const r = recorder();
    expect(await r.deps(() => ({ code: 1, output: "" })).reregister()).toBe(
      "failed",
    );
  });

  it("registered when start registered (Linux, the box)", async () => {
    const r = recorder();
    expect(
      await r
        .deps(() => ({ code: 0, output: "byollm is running under systemd\n" }))
        .reregister(),
    ).toBe("registered");
  });

  it("handed off when start handed off — #9572, Owl on #9594", async () => {
    const r = recorder();
    expect(
      await r
        .deps(() => ({
          code: 0,
          output:
            "byollm start was run by the daemon it re-registers (pid 7); " +
            "it finishes once that daemon exits. See /x/service.log\n",
        }))
        .reregister(),
    ).toBe("handed-off");
  });
});

describe("on Windows, where npm and byollm are .cmd shims — #9726", () => {
  /**
   * Node will not start a `.cmd` without a shell, so `npm` and `byollm` by
   * name are ENOENT, reported as exit 127: every Windows daemon failed its
   * update at the install. The doubles above answer whatever argv they are
   * given, which is why this never failed. Here every command is checked for
   * what Windows would actually be asked to start.
   */
  const node = join("C:", "Program Files", "nodejs", "node.exe");
  const npmCli = join(
    "C:",
    "Program Files",
    "nodejs",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const root = join(
    "C:",
    "Users",
    "kevin",
    "AppData",
    "Roaming",
    "npm",
    "node_modules",
  );
  const bin = join(root, "byollm", "dist", "bin.js");
  const windows = (present: readonly string[], PATH = ""): Host => ({
    platform: "win32",
    env: { PATH },
    execPath: node,
    exists: (path) => present.includes(path),
  });
  const answer = (command: readonly string[]) =>
    command.includes("root")
      ? { code: 0, output: `${root}\n` }
      : command.includes("--version")
        ? { code: 0, output: formatVersion() }
        : { code: 0, output: "" };

  it("starts every command with this Node and a .js, never a bare shim", async () => {
    const r = recorder(windows([npmCli, bin]));
    const deps = r.deps(answer);
    expect(await deps.install("0.1.7")).toBe(true);
    expect(await deps.installedVersion()).toBe(DAEMON_VERSION);
    await deps.reregister();

    expect(r.ran.length).toBeGreaterThanOrEqual(3);
    for (const command of r.ran) {
      expect(command[0]).toBe(node);
      expect(command[1]).toMatch(/\.js$/);
      expect(command[0]).not.toMatch(/^(npm|byollm)(\.cmd)?$/);
    }
    expect(r.ran).toContainEqual([
      node,
      npmCli,
      "install",
      "--global",
      "--ignore-scripts",
      "--registry=https://registry.npmjs.org",
      "byollm@0.1.7",
    ]);
    expect(r.ran).toContainEqual([node, bin, "--version"]);
    expect(r.ran).toContainEqual([node, bin, "start"]);
  });

  it("finds npm on PATH when it is not beside node.exe", () => {
    const elsewhere = join("D:", "tools", "node");
    const cli = join(elsewhere, "node_modules", "npm", "bin", "npm-cli.js");
    expect(npmCommand(windows([cli], `C:\\Windows;${elsewhere}`))).toEqual([
      node,
      cli,
    ]);
  });

  it("says so, and runs nothing, when there is no npm to find", async () => {
    const r = recorder(windows([]));
    expect(await r.deps(answer).install("0.1.7")).toBe(false);
    expect(r.ran).toEqual([]);
    expect(r.said.join("")).toContain("npm-cli.js");
  });

  it("takes byollm from npm's own root, and only where it is", async () => {
    /* npm warns on stderr, which arrives in the same stream; the root is
       the line with byollm under it. A root without it is no binary. */
    const host = windows([npmCli, bin]);
    const npm = npmCommand(host);
    expect(
      await byollmCommand(host, npm, () =>
        Promise.resolve({ code: 0, output: `${root}\nnpm warn something\n` }),
      ),
    ).toEqual([node, bin]);
    expect(
      await byollmCommand(windows([npmCli]), npm, () =>
        Promise.resolve({ code: 0, output: `${root}\n` }),
      ),
    ).toBeUndefined();
  });

  it("is a failed canary when the installed byollm cannot be found", async () => {
    const r = recorder(windows([npmCli]));
    expect(await r.deps(answer).installedVersion()).toBeUndefined();
    expect(await r.deps(answer).reregister()).toBe("failed");
  });

  it("leaves macOS and Linux as they were", async () => {
    const r = recorder({ ...windows([npmCli, bin]), platform: "linux" });
    const deps = r.deps(answer);
    await deps.install("0.1.7");
    await deps.installedVersion();
    await deps.reregister();
    expect(r.ran.map((command) => command[0])).toEqual([
      "npm",
      "byollm",
      "byollm",
    ]);
  });
});

describe("the real runner starts the npm it resolves — #9726", () => {
  /**
   * On this machine, whichever of the three CI runs it on. The test above
   * proves the argv's shape; only Windows can say that Windows starts it.
   */
  it("npm --version exits 0", async () => {
    const npm = npmCommand({
      platform: process.platform,
      env: process.env,
      execPath: process.execPath,
      exists: (await import("node:fs")).existsSync,
    });
    expect(npm, "no npm found for this Node").toBeDefined();
    const result = await spawnCommand([...(npm ?? []), "--version"]);
    expect(result.code, result.output).toBe(0);
    expect(result.output.trim()).toMatch(/^\d+\.\d+\.\d+/m);
  }, 30_000);
});

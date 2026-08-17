import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resetClaudeLaunchCache,
  resolveClaudeLaunch,
} from "./backends/claude-cli.js";

/**
 * Claude Code 2.x ships a native `bin/claude.exe` where 1.x shipped `cli.js`.
 *
 * The Windows launcher exists because Node refuses to spawn a `.cmd` shim
 * without a shell, so it resolved the CLI to a JavaScript entry and handed that
 * to Node. A native executable needs none of that — and worse, applying it
 * would hand Node a 320MB binary and ask it to parse it as JavaScript.
 *
 * Nothing caught this, because the resolver looked for the 1.x layout and
 * quietly fell back to spawning `claude` bare when it did not find it. On
 * Windows that is the extensionless shim Node will not run, so every route went
 * unhealthy the day the CLI updated — with no error naming the cause.
 *
 * These run on every platform: the resolver takes its platform and environment
 * as arguments precisely so Windows behaviour is testable from Linux CI.
 */

function fixture(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("resolveClaudeLaunch against the 2.x layout", () => {
  it("spawns the native binary directly, with no Node in front", () => {
    const dir = fixture("byollm-claude2-");
    const bin = join(
      dir,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
    );
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude.exe"), "MZ");

    resetClaudeLaunchCache();
    expect(resolveClaudeLaunch("claude", "win32", { PATH: dir })).toEqual({
      command: join(bin, "claude.exe"),
      prefixArgs: [],
    });
  });

  it("prefers the native binary when a stale 1.x cli.js sits beside it", () => {
    // An in-place upgrade can leave both. The executable is what the shim
    // actually points at, so it is what should run.
    const dir = fixture("byollm-claudeboth-");
    const pkg = join(dir, "node_modules", "@anthropic-ai", "claude-code");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "cli.js"), "#!/usr/bin/env node");
    writeFileSync(join(pkg, "bin", "claude.exe"), "MZ");

    resetClaudeLaunchCache();
    expect(resolveClaudeLaunch("claude", "win32", { PATH: dir })).toEqual({
      command: join(pkg, "bin", "claude.exe"),
      prefixArgs: [],
    });
  });

  it("still runs a 1.x cli.js under Node when that is all there is", () => {
    const dir = fixture("byollm-claude1-");
    const pkg = join(dir, "node_modules", "@anthropic-ai", "claude-code");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "cli.js"), "#!/usr/bin/env node");

    resetClaudeLaunchCache();
    expect(resolveClaudeLaunch("claude", "win32", { PATH: dir })).toEqual({
      command: process.execPath,
      prefixArgs: [join(pkg, "cli.js")],
    });
  });

  it("reads an .exe out of a shim written with %dp0%", () => {
    // npm has used both spellings of the shim's own directory: the current
    // template writes %dp0%, the older one wrote %~dp0. Only the second was
    // matched before, which is a second way the same failure could arrive.
    const dir = fixture("byollm-shim-exe-");
    mkdirSync(join(dir, "tools"), { recursive: true });
    const target = join(dir, "tools", "claude.exe");
    writeFileSync(target, "MZ");
    writeFileSync(
      join(dir, "claude.cmd"),
      ["@ECHO off", '"%dp0%\\tools\\claude.exe"   %*', ""].join("\r\n"),
    );

    resetClaudeLaunchCache();
    expect(resolveClaudeLaunch("claude", "win32", { PATH: dir })).toEqual({
      command: target,
      prefixArgs: [],
    });
  });

  it("reads a .js out of a shim written with %~dp0, under Node", () => {
    const dir = fixture("byollm-shim-js-");
    mkdirSync(join(dir, "tools"), { recursive: true });
    const target = join(dir, "tools", "cli.js");
    writeFileSync(target, "#!/usr/bin/env node");
    writeFileSync(
      join(dir, "claude.cmd"),
      ["@ECHO off", 'node  "%~dp0\\tools\\cli.js" %*', ""].join("\r\n"),
    );

    resetClaudeLaunchCache();
    expect(resolveClaudeLaunch("claude", "win32", { PATH: dir })).toEqual({
      command: process.execPath,
      prefixArgs: [target],
    });
  });
});

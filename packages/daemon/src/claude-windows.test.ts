import { describe, expect, it } from "vitest";
import {
  childEnv,
  claudeArgv,
  resetClaudeLaunchCache,
  resolveClaudeLaunch,
} from "./backends/claude-cli.js";

/**
 * Windows launches the `claude` CLI differently, and must not launch it
 * *differently enough* to weaken byollm_004 §2.
 *
 * Everything here runs on every platform: the functions take the platform and
 * environment as arguments precisely so the Windows behaviour is testable from
 * CI on Linux, which is where this bug would have been caught.
 */
describe("resolveClaudeLaunch", () => {
  it("is the identity off Windows", () => {
    expect(resolveClaudeLaunch("claude", "darwin", {})).toEqual({
      command: "claude",
      prefixArgs: [],
    });
    expect(resolveClaudeLaunch("claude", "linux", {})).toEqual({
      command: "claude",
      prefixArgs: [],
    });
  });

  it("leaves a real executable alone on Windows", () => {
    const probe = "C:\\probe\\fake-claude.exe";
    expect(resolveClaudeLaunch(probe, "win32", {})).toEqual({
      command: probe,
      prefixArgs: [],
    });
  });

  it("runs a .js probe under Node on Windows", () => {
    // The adversarial suite writes a `#!/usr/bin/env node` script and relies on
    // the shebang. Windows has no shebang, so the script must be handed to Node
    // explicitly — this is what lets that suite run on Windows at all.
    expect(resolveClaudeLaunch("C:\\t\\probe.js", "win32", {})).toEqual({
      command: process.execPath,
      prefixArgs: ["C:\\t\\probe.js"],
    });
  });

  it("leaves a .js probe alone off Windows, where the shebang works", () => {
    // Mac and Linux must be untouched: the script is executable there, and
    // rewriting the command would change what the suite is testing.
    expect(resolveClaudeLaunch("/tmp/probe.js", "darwin", {})).toEqual({
      command: "/tmp/probe.js",
      prefixArgs: [],
    });
  });

  it("falls back to the bare name when nothing is found on PATH", () => {
    // Not a silent success: health() then reports the CLI as not installed,
    // which is the honest answer when we genuinely cannot find it.
    expect(
      resolveClaudeLaunch("claude", "win32", { PATH: "C:\\nowhere" }),
    ).toEqual({ command: "claude", prefixArgs: [] });
  });

  it("keeps the CLI's own argv frozen regardless of platform", () => {
    // prefixArgs is an argument to Node, never to the model's command line.
    const argv = claudeArgv("claude-opus-5");
    expect(argv).toEqual([
      "--print",
      "--output-format",
      "text",
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--no-session-persistence",
      "--model",
      "claude-opus-5",
    ]);
  });
});

describe("childEnv on Windows", () => {
  const source = {
    PATH: "C:\\bin",
    USERPROFILE: "C:\\Users\\Kevin",
    APPDATA: "C:\\Users\\Kevin\\AppData\\Roaming",
    SystemRoot: "C:\\Windows",
    SECRET_TOKEN: "must-not-leak",
  };

  it("passes through the profile variables the CLI authenticates with", () => {
    // The Windows counterpart of the documented HOME compromise: without
    // these the child starts and then cannot find its subscription.
    const env = childEnv(source, "win32");
    expect(env["USERPROFILE"]).toBe("C:\\Users\\Kevin");
    expect(env["APPDATA"]).toBe("C:\\Users\\Kevin\\AppData\\Roaming");
    expect(env["SystemRoot"]).toBe("C:\\Windows");
  });

  it("passes USER through, which macOS authentication needs", () => {
    /**
     * Found on 2026-08-25, by the first cross-user job failing.
     *
     * On macOS the CLI keeps its credentials in the login Keychain rather than
     * under `HOME`, and reaching them needs `USER`. Without it every run
     * answers "Not logged in · Please run /login" and exits 1 — while the
     * health check, which runs `--version` and needs no credentials, goes on
     * reporting the backend healthy. Healthy backend, every job failing, is
     * the exact shape the Windows note in this file predicts, and it arrived
     * on the other platform first.
     *
     * Not Windows-only: this rides the base allowlist, so it is asserted on
     * the platforms that use it.
     */
    for (const platform of ["darwin", "linux"] as const) {
      const env = childEnv({ ...source, USER: "toddsampson" }, platform);
      expect(env["USER"], platform).toBe("toddsampson");
    }
  });

  it("does not take LOGNAME instead, which does not work", () => {
    // The same name under a different variable, and the CLI does not read it —
    // tested against the real binary rather than assumed. An allowlist entry
    // that fixes nothing is a widening with no story.
    expect(
      childEnv({ ...source, LOGNAME: "toddsampson" }, "darwin")["LOGNAME"],
    ).toBeUndefined();
  });

  it("still drops everything not on the allowlist", () => {
    expect(childEnv(source, "win32")["SECRET_TOKEN"]).toBeUndefined();
    expect(childEnv(source, "linux")["SECRET_TOKEN"]).toBeUndefined();
  });

  it("does not widen the allowlist off Windows", () => {
    const env = childEnv(source, "linux");
    expect(env["USERPROFILE"]).toBeUndefined();
    expect(env["APPDATA"]).toBeUndefined();
  });

  it("never leaks an API key to a subscription child on any platform", () => {
    // byollm_002: billing must not silently move from the subscription to a
    // metered key. Worth asserting on the widened path too.
    const withKey = { ...source, ANTHROPIC_API_KEY: "sk-ant-nope" };
    expect(childEnv(withKey, "win32")["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(childEnv(withKey, "linux")["ANTHROPIC_API_KEY"]).toBeUndefined();
  });
});

describe("resolution is memoized", () => {
  // It runs on every health probe and every job. On Windows that is a
  // synchronous PATH crawl on the dispatch path, which blocks the event loop
  // while other jobs are in flight.
  it("keys the memo on platform, binary and PATH", () => {
    resetClaudeLaunchCache();

    // Same inputs, same answer.
    const first = resolveClaudeLaunch("claude", "win32", { PATH: "C:\\a" });
    const second = resolveClaudeLaunch("claude", "win32", { PATH: "C:\\a" });
    expect(second).toEqual(first);

    // A different PATH is a different question, and must not be answered from
    // the memo — otherwise a cache would silently outlive the thing it
    // describes.
    const elsewhere = resolveClaudeLaunch("claude", "win32", {
      PATH: "C:\\b",
    });
    expect(elsewhere).toEqual({ command: "claude", prefixArgs: [] });

    // And platform is part of the identity, not an argument that gets lost.
    expect(resolveClaudeLaunch("claude", "linux", { PATH: "C:\\a" })).toEqual({
      command: "claude",
      prefixArgs: [],
    });
  });
});

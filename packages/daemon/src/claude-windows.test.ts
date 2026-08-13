import { describe, expect, it } from "vitest";
import {
  childEnv,
  claudeArgv,
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

  it("leaves an explicit path alone on Windows", () => {
    // The adversarial suite substitutes a probe binary by path. If that were
    // rewritten, the suite would stop testing what it believes it tests.
    const probe = "C:\\probe\\fake-claude.exe";
    expect(resolveClaudeLaunch(probe, "win32", {})).toEqual({
      command: probe,
      prefixArgs: [],
    });
    expect(resolveClaudeLaunch("./probe.js", "win32", {})).toEqual({
      command: "./probe.js",
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

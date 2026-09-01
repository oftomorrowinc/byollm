import { describe, expect, it } from "vitest";
import { serviceLine } from "./service-line.js";

/**
 * One sentence, three surfaces, and never a site.
 *
 * Your Devices, `byollm status` and the daemon's output answer the same
 * question — can this do its job, and if not what do I run. One template, so
 * they cannot drift into saying different things about one machine.
 *
 * The failure this exists for: a subscription token expired, `--version` kept
 * answering, the service kept being advertised, and the first person to find
 * out was whoever was waiting on a job. Nobody was told before a site asked.
 */
describe("what the owner is told about a service", () => {
  it("names the model when it answered", () => {
    expect(
      serviceLine({
        service: "claude",
        device: "tood-mbp",
        state: { kind: "answers", model: "claude-opus-5" },
      }).line,
    ).toBe("claude — claude-opus-5");
  });

  /* The remedy comes from the backend, because only the backend knows it.
     `claude` wants the bare command; `codex` wants `codex login`. A template
     that guessed would be wrong for one of them for ever. */
  it("names the machine and the backend's own sign-in", () => {
    expect(
      serviceLine({
        service: "claude",
        device: "tood-mbp",
        state: { kind: "signed-out" },
        signIn: "run `claude` in a terminal",
      }).line,
    ).toBe("claude — needs sign-in on tood-mbp: run `claude` in a terminal");

    expect(
      serviceLine({
        service: "codex",
        device: "tood-mbp",
        state: { kind: "signed-out" },
        signIn: "run `codex login`",
      }).line,
    ).toBe("codex — needs sign-in on tood-mbp: run `codex login`");
  });

  /* The device is in every sentence: somebody with three machines needs to
     know which terminal, and "run claude" is useless advice in the wrong one. */
  it("says which machine, always", () => {
    for (const state of [
      { kind: "signed-out" } as const,
      { kind: "missing" } as const,
    ]) {
      expect(
        serviceLine({ service: "claude", device: "the-laptop", state }).line,
      ).toContain("the-laptop");
    }
  });

  it("offers the way out when the binary is gone", () => {
    const said = serviceLine({
      service: "claude",
      device: "tood-mbp",
      state: { kind: "missing" },
      removeWith: "remove the service with `byollm services remove claude`",
    }).line;
    expect(said).toContain("not found on tood-mbp");
    expect(said, "a dead service with no way to remove it is a nag").toContain(
      "byollm services remove claude",
    );
  });

  /**
   * Not asked is not no.
   *
   * A backend with no canary — an HTTP model server — has no credentials of
   * its own to check. Rendering that as "cannot answer" would tell every
   * local-server owner their model was broken, which is the same defect as
   * reading an empty environment variable as a configured one.
   */
  it("says nothing about sign-in when there was nothing to ask", () => {
    const said = serviceLine({
      service: "qwen-2.5-14b",
      device: "tood-mbp",
      state: { kind: "unknown", model: "Qwen2.5-14B-Instruct-4bit" },
    });
    expect(said.line).toBe("qwen-2.5-14b — Qwen2.5-14B-Instruct-4bit");
    expect(said.line).not.toMatch(/sign|found|cannot/i);
    expect(said.detail).toBeUndefined();
  });

  /* The CLI's own words ride along for the owner, and only for the owner —
     they quote paths, usernames and account emails, and they name the
     backend. The site gets a class and a fixed sentence, elsewhere. */
  it("carries the backend's own words for the owner", () => {
    expect(
      serviceLine({
        service: "claude",
        device: "tood-mbp",
        state: {
          kind: "signed-out",
          detail: "401 OAuth access token has expired",
        },
        signIn: "run `claude` in a terminal",
      }).detail,
    ).toBe("401 OAuth access token has expired");
  });
});

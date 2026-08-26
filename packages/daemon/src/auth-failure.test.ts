import { describe, expect, it } from "vitest";
import { isAuthFailure } from "./backends/process-backend.js";

/**
 * "Healthy backend, every job fails" — closed on the free side.
 *
 * The claude CLI keeps its credentials in the macOS Keychain. When it cannot
 * reach them it prints prose and exits 1, and the health check — which runs
 * `--version` and needs no credentials — goes on reporting the backend
 * healthy. Todd's first cross-user job died exactly there.
 *
 * This match is what turns that into a typed `unauthorized`, which the runner
 * acts on by withdrawing the service. Text matching against vendor output
 * rots, so the corpus below is the real strings, and the negatives are the
 * reason it must stay narrow: the output being matched is a *model's answer*
 * as often as it is a tool's error.
 */
describe("recognising a signed-out CLI", () => {
  it.each([
    ["Not logged in · Please run /login", "claude, the line that found this"],
    ["Error: not authenticated", "a generic CLI"],
    ["authentication failed", "lower case"],
    ["AUTHENTICATION FAILED", "upper case"],
    ["Invalid API key provided", "a key that no longer works"],
    ["HTTP 401 Unauthorized", "an HTTP-shaped tool"],
  ])("matches %s (%s)", (text) => {
    expect(isAuthFailure(text)).toBe(true);
  });

  it.each([
    [
      "Here is how OAuth authentication works: first, the client...",
      "a model answering a question about auth",
    ],
    [
      "The user was not logged into the system in this fictional scene.",
      "a model writing prose that contains the phrase",
    ],
    ["claude exited with status 1", "a plain crash"],
    ["Error: ENOENT no such file or directory", "a missing file"],
    ["rate limit exceeded", "a different failure entirely"],
    ["", "no output at all"],
  ])("does not match %s (%s)", (text) => {
    // A false positive withdraws a working service, which is worse than the
    // silence this replaces — so the negatives matter more than the positives.
    expect(isAuthFailure(text)).toBe(false);
  });
});

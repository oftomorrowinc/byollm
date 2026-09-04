import { describe, expect, it } from "vitest";
import { observedQuotaCorpus, quotaBlock } from "./backends/quota.js";
import { serviceLine } from "./service-line.js";

/**
 * A quota block is its own failure, with its own remedy — byollm_019.
 *
 * Todd told Eric that a quota-blocked account is detected and easy to route
 * around. Two thirds of that was true: a signed-out CLI is caught by the auth
 * probe, an unmapped slot is refused at enqueue. A service that was healthy
 * this morning and blocked at 2pm took the slow path — claimed by a device
 * whose service would fail, failing, and telling the site nothing until the
 * job's TTL ran out. The fallback could not fire because the site was never
 * told anything to fall back from.
 */
const NOW = Date.parse("2026-09-03T06:00:00Z");

describe("the corpus", () => {
  it("holds only what a CLI actually printed", () => {
    /**
     * Ruled 2026-09-03: observed strings only, and empty is a legal state.
     *
     * The failure modes are not symmetric. A phrase we have not met changes
     * nothing — the service stays advertised and behaves as it does today. A
     * phrase we invented that matches something else withdraws a service that
     * works and tells its owner to wait out a block that does not exist.
     *
     * So every entry carries the evidence that somebody met it, and this
     * asserts the evidence rather than trusting the filing.
     */
    for (const seen of observedQuotaCorpus) {
      expect(seen.verbatim, seen.seenOn).not.toBe("");
      expect(seen.seenOn, seen.verbatim).toMatch(/\d/);
      expect(seen.seenAt, seen.verbatim).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The filing has to actually match the output it was filed from,
      // or the corpus is a list of claims rather than of observations.
      expect(seen.pattern.test(seen.verbatim), seen.verbatim).toBe(true);
    }
  });

  it("is reachable at all", () => {
    /* The positive control §4 asks for. Everything else here proves the
       classifier stays quiet; without this, a classifier wired to nothing
       would pass the whole file. */
    expect(observedQuotaCorpus.length).toBeGreaterThan(0);
    const seen = observedQuotaCorpus[0];
    expect(seen).toBeDefined();
    expect(quotaBlock(seen?.verbatim ?? "", NOW)).toBeDefined();
  });
});

describe("classifying one diagnostic", () => {
  it("says nothing about prose it has never met", () => {
    /* **The failure mode of the match is silence, not a wrong action.** Each
       of these is a real-looking failure that is not a quota block, and a
       classifier that guessed would withdraw a working service on any of
       them. */
    for (const message of [
      "the upstream connection closed",
      "Not logged in. Please log in to continue.",
      "Error: model gpt-5 is not available to this account",
      "request timed out after 30s",
      "",
    ]) {
      expect(quotaBlock(message, NOW), message).toBeUndefined();
    }
  });

  it("reads the clock the CLI gave it", () => {
    const block = quotaBlock(
      "You've hit your usage limit. Try again at Sep 3rd, 2026 8:28 AM.",
      NOW,
    );
    expect(block?.until).toBe(Date.parse("2026-09-03T08:28:00"));
  });

  it("takes no clock rather than a wrong one", () => {
    /**
     * A time already past is a time we read wrong — a block that ended before
     * we were told about it is not a block. And an unparseable one is worse
     * than none: it would have somebody come back to a machine that is still
     * blocked, having been told it would not be.
     */
    const stale = quotaBlock(
      "You've hit your usage limit. Try again at Sep 1st, 2020 8:28 AM.",
      NOW,
    );
    expect(stale).toBeDefined();
    expect(stale?.until).toBeUndefined();

    const unreadable = quotaBlock(
      "You've hit your usage limit. Try again at some point.",
      NOW,
    );
    expect(unreadable).toBeDefined();
    expect(unreadable?.until).toBeUndefined();
  });
});

describe("what the owner is told", () => {
  it("names a time, and never a thing to go and fix", () => {
    /**
     * The remedy must match the cause. Every other service sentence ends in
     * something to run; this one cannot, because the account is fine, the
     * credentials are fine, and the only thing that resolves it is a clock.
     * Telling somebody to sign in when their account is merely busy is the
     * same failure this class exists to stop.
     */
    const said = serviceLine({
      service: "claude",
      device: "Todd's MacBook",
      state: { kind: "blocked", until: Date.parse("2026-09-03T08:28:00") },
      signIn: "run `claude` in a terminal",
    });

    expect(said.line).toContain("out of quota");
    expect(said.line).not.toMatch(/sign|install|remove|config/i);
  });

  it("says it needs time when the CLI would not say when", () => {
    const said = serviceLine({
      service: "claude",
      device: "Todd's MacBook",
      state: { kind: "blocked" },
    });
    expect(said.line).toContain("needs time");
    expect(said.line).not.toMatch(/sign|install/i);
  });

  it("keeps a signed-out service saying sign in", () => {
    /* The control for the two above. If `blocked` had been folded into
       `signed-out` this would still pass while the new sentence was wrong,
       so it is here to prove the two states are still two. */
    const said = serviceLine({
      service: "claude",
      device: "Todd's MacBook",
      state: { kind: "signed-out" },
      signIn: "run `claude` in a terminal",
    });
    expect(said.line).toContain("needs sign-in");
    expect(said.line).not.toContain("out of quota");
  });
});

import { describe, expect, it } from "vitest";
import {
  observedQuotaCorpus,
  quotaBlock,
  type Observation,
} from "./backends/quota.js";
import { renderServices, serviceLine } from "./service-line.js";

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

/**
 * The strings this file tests with, owned by this file.
 *
 * §6.1 rules an empty corpus legal, and the suite quietly made that false:
 * six tests reddened when `OBSERVED` was emptied, because they asserted
 * behaviour through whichever strings we happened to have collected. That
 * couples "does the classifier work" to "what have we filed", and filing is
 * meant to change without ceremony.
 */
const FIXTURE: readonly Observation[] = [
  {
    pattern: /\busage limit\b/iu,
    seenOn: "fixture",
    seenAt: "2026-09-04",
    verbatim:
      "You've hit your usage limit. Try again at Sep 3rd, 2026 8:28 AM.",
  },
];

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
    /**
     * The positive control §4 asks for, decoupled from corpus size — CW's
     * note, 2026-09-04.
     *
     * This asserted `length > 0`, which made emptying the corpus fail CI
     * while §6.1 rules an empty corpus legal. Two different claims: "the
     * classifier is wired to something" is what a control must prove, and
     * "we currently hold observations" is a fact about our filing.
     *
     * So it drives a labelled fixture through the same function and asserts
     * the classifier agrees with its own corpus. If every observation were
     * retracted tomorrow this still proves the machinery runs — and what it
     * would then correctly say is that nothing matches.
     */
    /* Driven through a corpus this file owns, so it proves the machinery
       runs whether or not anything has been collected yet. */
    expect(quotaBlock(FIXTURE[0]?.verbatim ?? "", NOW, FIXTURE)).toBeDefined();
    expect(quotaBlock("nothing like it", NOW, FIXTURE)).toBeUndefined();

    // And the shipped corpus agrees with itself, whatever size it is.
    for (const seen of observedQuotaCorpus) {
      expect(quotaBlock(seen.verbatim, NOW), seen.verbatim).toBeDefined();
    }
  });

  it("is silent, not broken, when it holds nothing", () => {
    /* §6.1's legal state, asserted rather than assumed. Nothing waits on
       collection: machinery with an empty corpus classifies nothing, which is
       what every machine did before this existed. */
    expect(quotaBlock("You've hit your usage limit.", NOW, [])).toBeUndefined();
    expect(quotaBlock("anything at all", NOW, [])).toBeUndefined();
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
      expect(quotaBlock(message, NOW, FIXTURE), message).toBeUndefined();
    }
  });

  it("reads the clock the CLI gave it", () => {
    const block = quotaBlock(
      "You've hit your usage limit. Try again at Sep 3rd, 2026 8:28 AM.",
      NOW,
      FIXTURE,
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
      FIXTURE,
    );
    expect(stale).toBeDefined();
    expect(stale?.until).toBeUndefined();

    const unreadable = quotaBlock(
      "You've hit your usage limit. Try again at some point.",
      NOW,
      FIXTURE,
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

describe("the state a different process can read", () => {
  it("survives a rebuild of the probe's map", async () => {
    /**
     * S2, found by CW reading the code — 2026-09-04.
     *
     * `serviceStates` is rebuilt from scratch on every detection pass, and a
     * blocked service skips the probe that would fill its entry. So the state
     * existed for one pass and vanished, and `byollm status` — a *different
     * process*, reading a file — could never say a service was blocked, let
     * alone until when, though acceptance §4 names that surface by name. The
     * only place the time appeared was the daemon's own stderr.
     *
     * Asserted end to end through the writer and reader the two processes
     * actually share, because the bug was precisely that the in-memory map
     * and the file had stopped agreeing.
     */
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readServiceStates, writeServiceStates } =
      await import("./service-states.js");

    const dir = await mkdtemp(join(tmpdir(), "byollm-blocked-"));
    const path = join(dir, "services.json");
    try {
      await writeServiceStates(
        path,
        new Map([
          [
            "claude",
            {
              state: {
                kind: "blocked" as const,
                detail: "the claude CLI is out of quota",
                until: Date.parse("2026-09-03T08:28:00"),
              },
            },
          ],
        ]),
      );

      const read = await readServiceStates(path);
      expect(read.get("claude")?.state).toMatchObject({
        kind: "blocked",
        until: Date.parse("2026-09-03T08:28:00"),
      });

      // And the surface renders it as a time rather than as a fault.
      const lines = renderServices(read, "Todd's MacBook");
      expect(lines.join("\n")).toContain("out of quota");
      expect(lines.join("\n")).not.toMatch(/sign in|install/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

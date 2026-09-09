import { describe, expect, it } from "vitest";
import {
  formatPostureReport,
  unmeasured,
  type PostureReport,
} from "../src/deployment.js";

/**
 * The audit tells "nobody asked" apart from "somebody got in" — B065.
 *
 * B065 asked for one thing: prove the audit CAN go red, so that its
 * six-hourly green means something. It can — 2/11 against a wrong target.
 *
 * Proving it turned up this, which is the other half of the same worry. Three
 * of the eleven checks need the origin's address, and without it they did not
 * pass — correctly, because a gate that waves through what it could not look
 * at passes hardest when it is blindest. But they were printed as `FAIL` and
 * summarised as "a stranger got somewhere", which sends an operator looking
 * for a breach nobody reported.
 *
 * Unproven is a third state: the rule this project already applies to a poll
 * that cannot read an answer and to a release check that cannot read a
 * version, arriving on the surface that reports our security posture.
 */
const result = (
  id: string,
  passed: boolean,
  measured?: boolean,
): PostureReport["results"][number] => ({
  id,
  title: "t",
  detail: "d",
  cites: [],
  passed,
  ...(measured === undefined ? {} : { measured }),
});

const report = (results: PostureReport["results"]): PostureReport => ({
  origin: "https://example.test",
  passed: results.every((r) => r.passed),
  results,
});

describe("what the summary says", () => {
  it("says nobody got in when everything was measured and passed", () => {
    const said = formatPostureReport(
      report([result("A", true), result("B", true)]),
    );
    expect(said).toContain("a stranger got nowhere");
  });

  it("does not claim a breach when nothing was breached", () => {
    /* The defect. Two passes and one unasked question is not somebody
       getting somewhere, and saying so costs an operator an investigation. */
    const said = formatPostureReport(
      report([result("A", true), result("B", true), result("C", false, false)]),
    );
    expect(said).not.toContain("a stranger got somewhere");
    expect(said).toContain("nothing was breached");
    expect(said).toContain("could not be measured");
  });

  it("still says so plainly when something IS breached", () => {
    /* The control. A version that never says "got somewhere" would satisfy
       the assertion above perfectly. */
    const said = formatPostureReport(
      report([result("A", true), result("B", false)]),
    );
    expect(said).toContain("a stranger got somewhere");
  });

  it("names both when a run has a breach and an unasked question", () => {
    const said = formatPostureReport(
      report([result("A", false), result("B", false, false)]),
    );
    expect(said).toContain("a stranger got somewhere");
    expect(said).toContain("not measured");
  });

  it("marks an unmeasured check as neither ok nor FAIL", () => {
    const said = formatPostureReport(report([result("C", false, false)]));
    expect(said).toMatch(/^ {2}\?\s+C/m);
    expect(said).not.toMatch(/FAIL\s+C/);
  });

  it("never passes a report that could not measure something", () => {
    /**
     * Fail-closed, and this is the line that keeps the third state from
     * becoming a loophole. "Not measured" must not be a way to be green: a
     * posture gate that could not look is a gate that has not run.
     *
     * Asserted on the CONSTRUCTOR, not on a result object built here. The
     * first draft did the latter and survived a mutation that made
     * `unmeasured` pass — it was proving the formatter's arithmetic while
     * the thing it named was free to change underneath it.
     */
    const outcome = unmeasured("no origin address given");
    expect(outcome.passed, "unmeasured must never be a way to be green").toBe(
      false,
    );
    expect(outcome.measured).toBe(false);
  });
});

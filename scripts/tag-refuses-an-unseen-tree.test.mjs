import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A tag is not cut on a tree Windows and macOS have not seen — B344.
 *
 * A push to `main` runs the daemon suite on ubuntu only; the three-OS matrix
 * runs on a tag, a schedule, or a `workflow_dispatch` (B315, for the bill). So
 * the FIRST time Windows meets a commit is the release itself — and v0.1.1
 * found that out twice in one night. 87f26b7 was green on main and red on the
 * tag (`changelog.mjs` writing on import: byte-identical under LF, not under
 * CRLF). b712b49 was red the same way (`import()` given a path, which is only
 * a URL-scheme error on Windows). Two tags deleted and re-cut, because the tag
 * was doing a pre-tag check's work.
 */

const TAG = fileURLToPath(new URL("./tag.sh", import.meta.url));
const source = () => readFileSync(TAG, "utf8");
/** What it RUNS — these scripts print commands they do not execute. */
const code = () =>
  source()
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .filter((line) => !/^\s*echo\b/u.test(line))
    .join("\n");

describe("the three-OS gate", () => {
  it("is a numbered refusal, so the rehearsal has to cover it", () => {
    /* `rehearse-the-cut.test.mjs` derives its coverage from this numbering.
       An unnumbered check would be a surprise in the cut — which is the exact
       thing that file exists to prevent. */
    expect(source()).toMatch(/^# 7\. /mu);
  });

  it("accepts only the events that carry the matrix", () => {
    /**
     * Not "a green run". Green runs exist on `main` all day and are ubuntu
     * only — that is precisely what let v0.1.1 through twice. The EVENT is
     * what selects the matrix, so the event is what is asked.
     */
    const ran = code();
    expect(ran).toContain('.event == "schedule"');
    expect(ran).toContain('.event == "workflow_dispatch"');
    expect(ran).toMatch(/--commit/u);
  });

  it("drops cancelled runs", () => {
    /**
     * **The trap I set for myself.** Dispatching CI by hand at a sha that
     * already has a push run cancels the push run through the concurrency
     * group. `release.yml`'s `Wait for CI` then read that cancelled run as a
     * failure and refused to publish a release whose CI had passed on three
     * OSes, twice. A cancelled run is nobody answering the question, not an
     * answer — and this gate must not make the same mistake in reverse by
     * counting one as a pass either.
     */
    expect(code()).toContain('.conclusion != "cancelled"');
  });

  it("requires a COMPLETED success, not merely a started run", () => {
    const ran = code();
    expect(ran).toContain('.status == "completed"');
    expect(ran).toContain('.conclusion == "success"');
  });

  it("says so when it cannot ask, rather than passing quietly", () => {
    /**
     * Without `gh` there is no answer, and an unasked question that reads as a
     * pass is the fail-open this repository keeps finding in its own gates.
     * The third state is printed and the operator is told to confirm by hand.
     */
    const text = source();
    expect(text).toMatch(/command -v gh/u);
    expect(text).toMatch(/was NOT checked/u);
  });

  it("tells the operator not to race the push run", () => {
    /* The remedy has to carry the thing that went wrong last time, or it is
       an instruction to repeat it. */
    expect(source()).toMatch(/gh workflow run ci\.yml/u);
    expect(source()).toMatch(/concurrency group cancels it/u);
  });
});

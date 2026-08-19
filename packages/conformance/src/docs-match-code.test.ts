import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHECKS } from "./checks.js";

/**
 * The docs say what the code does — cloud_008 Tier 4, findings 29 and 34.
 *
 * `docs/protocol.md` is the public description of the wire, and it had drifted
 * to describe a protocol that no longer exists: bearer tokens on every
 * endpoint, `audienceAllow` on the claim, `leases` on the heartbeat. Somebody
 * implementing from it would have sent two fields that are now refused and
 * omitted two that are now required — the document was not merely stale, it
 * was instructions for building something incompatible.
 *
 * The conformance README quoted `16 checks passed` while the kit shipped 32.
 * A number in a README is a promise about scope, and a reader comparing their
 * own run against it would have concluded something was missing.
 *
 * Neither is checkable in general — prose is prose. What *is* checkable is the
 * part that goes wrong: names of things that were removed, names of things
 * that were added, and a count. Those are exactly the edits that get forgotten
 * when a wire changes.
 */

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("docs/protocol.md describes this protocol", () => {
  const doc = read("../../../docs/protocol.md");

  /**
   * Only the fenced blocks — the wire shapes.
   *
   * The first version of this forbade the removed names anywhere in the file
   * and failed on the document's own history: "`audienceAllow` was a stub
   * field until alpha.14" is exactly the sentence worth keeping, and a check
   * that deletes the record of a mistake to prove the mistake is gone has
   * traded one kind of dishonesty for another.
   *
   * A field name inside a code fence is a claim about what to send. In prose
   * it is usually a claim about what used to be.
   */
  const shapes = [...doc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .join("\n");

  it("finds wire shapes to read", () => {
    // Without this the assertions below pass against a document whose fences
    // were reformatted away — the vacuous-green shape, in the check written
    // to prevent it.
    expect(shapes.length).toBeGreaterThan(200);
  });

  it.each([
    ["runnerToken", "the bearer token, removed in alpha.18"],
    ["audienceAllow", "membership on the stub, removed in alpha.14"],
  ])("no wire shape carries %s (%s)", (removed) => {
    expect(shapes).not.toContain(removed);
  });

  it("does not tell an implementer to send a bearer token", () => {
    // This one is a normative sentence rather than a shape, so it is asked of
    // the prose — and phrased as the instruction it used to give.
    expect(doc).not.toContain("requires `Authorization: Bearer");
  });

  it.each([
    ["x-byollm-signature", "requests are signed, not bearer-authenticated"],
    ["site", "the stub names its site (Amendment A)"],
    ["leaseId", "the result names its grant"],
    ["duplicate", "a replay from the finishing device is told so"],
    ["ran:", "how a job ran is sealed with the answer"],
  ])("describes %s (%s)", (required) => {
    expect(doc).toContain(required);
  });

  it("does not promise a heartbeat field that no daemon reads", () => {
    // `leases` came off the response in alpha.16. The word still appears in
    // prose about leases generally, so this asks about the field.
    expect(doc).not.toContain("- `leases` —");
  });
});

describe("the conformance README counts what ships", () => {
  const readme = read("../README.md");

  it("quotes the number of checks the kit actually has", () => {
    // The sample output is what a reader compares their own run against, so a
    // stale number reads as "something did not run".
    const quoted = /(\d+) checks passed/.exec(readme)?.[1];
    expect(quoted, "no `N checks passed` line in the README").toBeDefined();
    expect(Number(quoted)).toBe(CHECKS.length);
  });
});

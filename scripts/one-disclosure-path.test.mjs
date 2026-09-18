import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * One place says how to report a vulnerability — B224.
 *
 * ## The drift this was written for
 *
 * Two files told a security researcher what to do, and they disagreed.
 *
 * `SECURITY.md` — the file GitHub surfaces on the security tab — offers **two**
 * channels, email and a private advisory, and says *"you should hear back
 * within a few days"*.
 *
 * `docs/security.md` §9 — the file our own README and issue templates link to
 * — said *"open a security advisory … rather than a public issue"*, mentioned
 * **no email at all**, and said *"there is no formal SLA"*.
 *
 * So which promise a reporter read, and whether they learned that email works,
 * depended on which door they came through. One door hid a working channel and
 * the two doors quoted different response times, on the disclosure path of a
 * product whose whole pitch is that your prompts stay on your machine.
 *
 * ## Why the check is about ABSENCE
 *
 * "Both files say the same thing" is the wrong repair and a worse check: it
 * licenses two copies and asks a test to keep them equal forever. The rule is
 * one source, so the check is that the other file does not explain — it points.
 *
 * `SECURITY.md` is the source because GitHub gives it a place no other file
 * can have: a reporter who has never read our docs still finds it.
 */
const ROOT_SECURITY = "SECURITY.md";
const THREAT_MODEL = "docs/security.md";

const read = (path) => readFileSync(path, "utf8");

describe("how to report a vulnerability", () => {
  it("is pointed at from CONTRIBUTING.md, not explained there", () => {
    /**
     * The third door, added with the file — B224.
     *
     * GitHub links `CONTRIBUTING.md` from the "new issue" and "new pull
     * request" screens, which is exactly where somebody with a security
     * finding might start. A contributing guide that explained reporting
     * would be a fourth copy of the instructions, and the two that already
     * existed had drifted apart.
     */
    const contributing = read("CONTRIBUTING.md");
    /**
     * **A route, not a mention — B242a, and it is my own law caught by CW
     * eight lines from where I applied it correctly.**
     *
     * This asserted `toContain("SECURITY.md")`, which prose about the file
     * satisfies. The assertion for the threat model, right above, already
     * required `](../SECURITY.md)` — a link — because I had just watched a
     * mutation walk through the substring version. Writing both in one file,
     * two hours after writing the law down, is the clearest evidence I have
     * that these do not work as knowledge.
     *
     * `CONTRIBUTING.md` carries a real link today, so the weak version was
     * green — and would have stayed green the day somebody rewrote that line
     * as prose, which is the only day it exists for.
     */
    expect(
      contributing,
      "CONTRIBUTING.md mentions SECURITY.md but does not link to it — a " +
        "mention is not a route, and this is the file somebody with a finding " +
        "reaches from the new-issue screen",
    ).toContain("](SECURITY.md)");
    expect(
      contributing,
      "CONTRIBUTING.md is explaining how to report — SECURITY.md is the one " +
        "place, and a guide that repeats it is the next copy to drift",
    ).not.toContain("security/advisories/new");
    expect(contributing).not.toContain("support@byollm.cloud");
  });

  it("is pointed at from CODE_OF_CONDUCT.md, not explained there", () => {
    /**
     * The fourth door — B270.
     *
     * GitHub surfaces a code of conduct from the community profile and from
     * the new-issue screen, and this one carries a reporting address of its
     * own. Two addresses in one paragraph is where somebody with a
     * vulnerability decides that the conduct inbox will do — so the file has
     * to send them somewhere else, by a route rather than a mention.
     *
     * The same law CW caught me breaking eight lines above: `toContain
     * ("SECURITY.md")` is satisfied by prose about the file, and prose is not
     * a route.
     */
    const conduct = read("CODE_OF_CONDUCT.md");
    expect(
      conduct,
      "CODE_OF_CONDUCT.md mentions SECURITY.md but does not link to it — and " +
        "it is the file GitHub puts in front of somebody opening an issue",
    ).toContain("](SECURITY.md)");
    expect(
      conduct,
      "CODE_OF_CONDUCT.md is explaining how to report a vulnerability — " +
        "SECURITY.md is the one place, and this is the next copy to drift",
    ).not.toContain("security/advisories");
    /* It DOES carry `support@byollm.cloud`, for conduct, and that is not a
       second disclosure door: the law is about instructions, not addresses.
       What it must not do is tell a researcher that this is where to send a
       vulnerability. */
    expect(conduct).toMatch(/different door/iu);
  });

  it("has a SECURITY.md at the root, where GitHub looks", () => {
    /* GitHub links this file from the security tab and from the "report a
       vulnerability" affordance. A project whose disclosure instructions live
       only in `docs/` is a project a researcher has to go hunting in. */
    expect(existsSync(ROOT_SECURITY)).toBe(true);
  });

  it("names both channels there, and only there", () => {
    const security = read(ROOT_SECURITY);
    expect(security).toContain("support@byollm.cloud");
    expect(security).toContain("security/advisories");
  });

  it("does not explain it a second time in the threat model", () => {
    /**
     * The assertion that catches the drift, and it is a NEGATIVE one on
     * purpose. The threat model is 465 lines about what is claimed and what is
     * not; a reporting section inside it is a copy nobody diffs, and this one
     * had already gone out of step in two directions at once.
     *
     * Matched on the instruction rather than the word "advisory", because the
     * document discusses disclosure as a subject perfectly legitimately — what
     * it must not do is tell somebody where to send a report.
     */
    const model = read(THREAT_MODEL);
    const section = model.slice(model.indexOf("## 9."));
    expect(
      section,
      "the threat model has no reporting section at all",
    ).not.toBe("");
    expect(
      section,
      "docs/security.md is explaining how to report again — that is the copy " +
        "that drifted, and SECURITY.md is the one place",
    ).not.toContain("security/advisories/new");
    expect(section).not.toContain("support@byollm.cloud");
  });

  it("sends the reader to the one place from the threat model", () => {
    /**
     * The control on the assertion above: a section that said nothing at all
     * would satisfy "does not explain", and would leave a reader who got here
     * from our own README with no next step.
     *
     * **A LINK, not the string.** The first version asserted the section
     * contained "SECURITY.md" — and a mutation replacing the pointer with
     * "Reporting is handled elsewhere." sailed through, because the prose
     * further down mentions the filename while explaining the drift. A mention
     * is not a route.
     */
    const model = read(THREAT_MODEL);
    const section = model.slice(model.indexOf("## 9."));
    expect(
      section,
      "the threat model mentions SECURITY.md but does not link to it",
    ).toContain("](../SECURITY.md)");
  });

  it("is the same repository the advisory link points at", () => {
    /**
     * A disclosure link to the wrong repository is a report that reaches
     * nobody, and it is the kind of thing a copy-paste does silently. The
     * package manifests already name the repository; this asserts the security
     * file agrees with them rather than with a memory.
     */
    const pkg = JSON.parse(read("packages/protocol/package.json"));
    const slug = /github\.com\/([^/]+\/[^/.]+)/u.exec(pkg.repository.url)?.[1];
    expect(
      slug,
      "the protocol manifest names no GitHub repository",
    ).toBeDefined();

    /**
     * **Every advisory URL, not "the slug appears somewhere".**
     *
     * The first version asked whether the file contained the right slug
     * anywhere — and a mutation pointing the link at another repository
     * passed, because a markdown link carries the address TWICE and only the
     * visible label had moved. A label is what a reader sees; the href is
     * where they go, and those are exactly the two that must not disagree.
     */
    const urls = [
      ...read(ROOT_SECURITY).matchAll(
        /github\.com\/([^/\s)]+\/[^/\s)]+)\/security\/advisories/gu,
      ),
    ].map((match) => match[1]);
    expect(urls.length, "SECURITY.md names no advisory link").toBeGreaterThan(
      0,
    );
    for (const named of urls) {
      expect(named, "an advisory link points at another repository").toBe(slug);
    }
  });
});

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Whatever goes into a sealed envelope is parsed by its schema first — B304.
 *
 * `runner.ts` sealed `{ outcome, ran }` under `satisfies SealedOutcome` for
 * months while `ran` carried two keys the protocol refuses. Every claude-cli
 * result on every site was dropped, silently, on both ends: the daemon
 * believed it had sent an answer and the page said "still going" until the
 * person gave up. It cost a screenshare to find.
 *
 * ## Why SEALED payloads specifically, and not every wire object
 *
 * Because nothing in between can catch them. A plain request body is parsed by
 * the relay or the hub, so a bad one comes back as a 400 that names the field —
 * loud, and addressed to the party that sent it. A sealed payload is opaque to
 * every intermediary by design; the only reader is the far end, which opens it,
 * fails `.strict()`, and has nowhere to put the complaint. **The property that
 * makes sealing valuable is the property that makes this class invisible.**
 *
 * That narrowness is also what keeps this check honest. It has two subjects in
 * the whole repository, and a checker that cried about every object crossing a
 * wire would be switched off inside a week.
 *
 * ## Why a type is not enough, which is the actual lesson
 *
 * `satisfies SealedOutcome` was there. TypeScript excess-property-checks a
 * **fresh literal** — so the console agent, whose two call sites pass literals,
 * is genuinely safe today. `runner.ts` was not: `ran` arrived as a variable
 * from another method whose return type was inferred, and a variable's extra
 * keys are invisible to structural typing.
 *
 * So the compiler protects one of these two and not the other, for a reason
 * neither call site states, and either could become the other in one refactor.
 * A `.parse` costs a microsecond and does not depend on where the value came
 * from.
 */

const PACKAGES = "packages";

/**
 * The two ends of a real job: the daemon that answers and the site that asks.
 *
 * **Measured before it was narrowed.** Across every shipped source the rule
 * flags five sites and four of them are correct as they stand:
 *
 *   - `conformance/src/checks.ts` seals a **deliberate forgery** — *"perfectly
 *     well-formed, perfectly openable, and signed by a key this daemon never
 *     pinned"* — to prove a daemon refuses it. A rule forbidding that would
 *     forbid the kit's entire job.
 *   - `conformance/src/harness.ts` and `server/src/testing.ts` build fixtures.
 *     `testing.ts` is published for other people's tests; constructing odd
 *     payloads is what it is for.
 *   - `server/src/app.ts` passes `parsed.data.payload`, which arrived through
 *     a schema on the way in. Accepted below by rule rather than by exclusion,
 *     because that is a real satisfaction of the law and not an exception to
 *     it.
 *
 * That leaves one true subject and one true finding, which is the shape a
 * check has to have to survive. Four flags out of five wrong is a checker
 * somebody switches off, and then the fifth goes with it.
 */
const SUBJECTS = [
  join(PACKAGES, "daemon", "src"),
  join(PACKAGES, "server", "src"),
];

/** Shipped source on those paths — tests and fixture builders excluded. */
function sources() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.includes(".test.")) continue;
      /* A published helper whose purpose is building payloads for somebody
         else's tests, including malformed ones. */
      if (entry.name === "testing.ts") continue;
      found.push([path, readFileSync(path, "utf8")]);
    }
  };
  for (const dir of SUBJECTS) if (existsSync(dir)) walk(dir);
  return found;
}

/**
 * The `plaintext:` argument of every `seal({ ... })`, with where it is.
 *
 * Read as text rather than parsed as TypeScript: the shape being looked for is
 * one line long and a parser would be a second dependency for the same answer.
 * The control below asserts the reader finds the known call sites, so a regex
 * that stopped matching cannot report a clean repository.
 */
function sealedPayloads() {
  const found = [];
  for (const [path, text] of sources()) {
    const lines = text.split("\n");
    lines.forEach((line, at) => {
      if (!/\bseal\(\{/u.test(line)) return;
      /**
       * Scanned to the call's own closing brace rather than a fixed window.
       *
       * The first version read twelve lines and missed `runner.ts` — because
       * the comment explaining B304 sits between `seal({` and `plaintext:`,
       * and it is twelve lines long. A check defeated by the length of the
       * note explaining the defect it exists for, in its first run. The
       * control above is what said so.
       */
      const end = lines.findIndex(
        (row, i) => i > at && /^\s*\}\);?\s*$/u.test(row),
      );
      const window = lines.slice(at, end === -1 ? at + 60 : end + 1).join("\n");
      const hit = /plaintext:\s*([^\n]+)/u.exec(window);
      if (hit === null) return;
      found.push({ where: `${path}:${String(at + 1)}`, plaintext: hit[1] });
    });
  }
  return found;
}

/**
 * Does one `plaintext:` argument satisfy the law?
 *
 * Hoisted so planted arguments go through **this** predicate and not a second
 * copy written to agree with it. Without that, a mutation making the rule
 * accept everything passed: the live subjects all satisfy it, so "accept
 * everything" and "the rule" are the same function on this tree. A check that
 * cannot be shown to reject anything has not been shown to do anything.
 */
function satisfied(plaintext) {
  /* A pass-through is not a construction. `reseal` and the cloud lane forward
     bytes somebody else already sealed and this repository never built, so
     there is no object here to validate — and parsing it would mean opening a
     payload we deliberately do not read. */
  if (/\bopened\.plaintext\b/u.test(plaintext)) return true;
  /* Already through a schema on the way in. `parsed.data.payload` is a value
     zod returned, so sealing it cannot smuggle a key past the far end's
     `.strict()` — which is the whole property being asked for. */
  if (/\bparsed\.data\b/u.test(plaintext)) return true;
  return /\.parse\(/u.test(plaintext);
}

describe("the rule, on arguments the repository does not contain", () => {
  it("rejects a payload built and sent unchecked", () => {
    expect(satisfied("JSON.stringify(frame),")).toBe(false);
    expect(satisfied("JSON.stringify({ outcome, ran }),")).toBe(false);
  });

  it("accepts one that names its schema", () => {
    expect(satisfied("JSON.stringify(ConsoleFrame.parse(frame)),")).toBe(true);
  });

  it("accepts a pass-through and a value zod already returned", () => {
    /* Both are satisfactions of the law rather than exceptions to it, and a
       rule that flagged them would be asking for a payload to be opened that
       this repository deliberately does not read. */
    expect(satisfied("opened.plaintext,")).toBe(true);
    expect(satisfied("JSON.stringify(parsed.data.payload),")).toBe(true);
  });

  it("exempts the pass-through, not the word", () => {
    /* `opened.plaintext` is exempt because nothing was built. A rule matching
       the bare word would exempt anything that happened to mention it, and a
       mutation widening it that far survived until this case existed. */
    expect(satisfied("JSON.stringify(makePlaintext()),")).toBe(false);
    expect(satisfied("JSON.stringify(theParsedThing),")).toBe(false);
  });
});

describe("what we seal", () => {
  it("is found at all, or this reports a clean repository having read none", () => {
    /* The fail-open this project keeps catching in its own gates: a reader
       that matches nothing satisfies "every payload is parsed" perfectly. */
    const found = sealedPayloads();
    expect(found.length).toBeGreaterThanOrEqual(2);
    expect(found.map((f) => f.where).join(" ")).toContain("runner.ts");
  });

  it("is parsed by its schema before it is stringified", () => {
    const unchecked = sealedPayloads().filter(
      ({ plaintext }) => !satisfied(plaintext),
    );
    expect(
      unchecked.map((u) => `${u.where}  ${u.plaintext.trim()}`),
      "a sealed payload is built and sent without being parsed. Nothing " +
        "between the two ends can see inside an envelope, so the far end " +
        "refuses it and has nowhere to say so — B304 lost every claude-cli " +
        "result on every site for months exactly this way.",
    ).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  CHECKS,
  certify,
  formatReport,
  miscoveredMusts,
  uncoveredMusts,
} from "../src/index.js";
import { MUSTS, MUST_IDS, kindsOf, mustsVerifiedBy } from "@byollm/protocol";
import { referenceTarget } from "./reference-target.js";

/**
 * The conformance kit against the reference server, on every PR.
 *
 * Each check is its own `it` so a failure names the MUST it broke rather than
 * reporting "conformance failed".
 */
describe("conformance — reference server", () => {
  for (const check of CHECKS) {
    it(`${check.id}: ${check.title} [${check.musts.join(", ")}]`, async () => {
      const target = referenceTarget();
      const report = await certify(target, { only: [check.id] });
      const result = report.results[0];
      expect(result?.error ?? "", result?.error ?? "").toBe("");
      expect(result?.passed).toBe(true);
    });
  }
});

describe("the kit is honest about its own coverage", () => {
  it("asserts every MUST it is able to assert", () => {
    // This used to check only that the result was an array, which is a thing
    // that cannot fail. It could not do better while the count mixed in
    // MUSTs the kit is structurally unable to test — a number that can never
    // reach zero gets ignored. Now that each MUST declares how it is
    // verified, this counts only `conformance`-kind gaps, and that number
    // must be zero.
    expect(uncoveredMusts()).toEqual([]);
  });

  it("never claims a MUST that conformance cannot verify", () => {
    // The opposite failure, and the quieter one: a check listing an
    // `operator`-kind MUST would put "verified" beside something no third
    // party can check from outside. That is how "byollm-compatible" comes to
    // cover claims the kit never touched.
    expect(miscoveredMusts()).toEqual([]);
  });

  it("gives every MUST at least one verification kind, and only real ones", () => {
    const KINDS = [
      "conformance",
      "adversarial",
      "construction",
      "operator",
      "pending",
    ];
    for (const id of MUST_IDS) {
      const kinds = kindsOf(MUSTS[id]);
      // At least one, because an empty list would pass a `every` check while
      // claiming nothing — the vacuity this file exists to refuse.
      expect(kinds.length, id).toBeGreaterThan(0);
      for (const kind of kinds) expect(KINDS, id).toContain(kind);
    }
  });

  it("gives every check a unique id and at least one MUST", () => {
    const ids = CHECKS.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const check of CHECKS) {
      expect(check.musts.length, check.id).toBeGreaterThan(0);
    }
  });
});

/**
 * MUSTs registered ahead of their checks — #7053, byollm_012 §12 and
 * byollm_021 §10.
 *
 * `pending` is the honest kind for a MUST whose checks are assigned and not
 * built. These hold it to the two things that keep it from becoming a place
 * a MUST can rest: its checks are named, and the day one is built the MUST
 * has to move.
 */
describe("pending MUSTs and their planned checks", () => {
  const numberOf = (id: string): number =>
    Number(/^C(\d+)/u.exec(id)?.[1] ?? Number.NaN);
  const built = new Set(CHECKS.map((check) => numberOf(check.id)));
  const planned = MUST_IDS.flatMap((id) => {
    const must: { planned?: { checks: readonly string[] } } = MUSTS[id];
    return (must.planned?.checks ?? []).map((check) => ({ id, check }));
  });

  // While anything is pending, there is something to read; the control on
  // the assertions below. Skipped, visibly, once the last MUST is promoted.
  const anyPending = MUST_IDS.some((id) =>
    kindsOf(MUSTS[id]).includes("pending"),
  );
  it.skipIf(!anyPending)("finds planned checks to read", () => {
    expect(planned.length).toBeGreaterThan(0);
  });

  it("says, for every pending MUST, how it will be verified and by what", () => {
    for (const id of MUST_IDS) {
      const must: {
        verifiedBy: unknown;
        planned?: { verifiedBy: unknown; checks: readonly string[] };
      } = MUSTS[id];
      if (!kindsOf(MUSTS[id]).includes("pending")) continue;
      // Alone: "pending and conformance" would claim the kit checks it.
      expect(must.verifiedBy, id).toBe("pending");
      expect(must.planned, id).toBeDefined();
      expect(must.planned?.checks.length ?? 0, id).toBeGreaterThan(0);
      const future =
        typeof must.planned?.verifiedBy === "string"
          ? [must.planned.verifiedBy]
          : [...((must.planned?.verifiedBy as string[] | undefined) ?? [])];
      expect(future.length, id).toBeGreaterThan(0);
      expect(future, id).not.toContain("pending");
    }
  });

  it("names only checks the kit does not have yet", () => {
    // So a planned record is removed with the check that replaces it: once
    // C033 exists, a MUST still listing it as planned fails here.
    const stale = planned
      .filter(({ check }) => built.has(numberOf(check)))
      .map(({ id, check }) => `${id}: ${check}`);
    expect(stale, "planned checks the kit already has").toEqual([]);
  });

  it("numbers planned checks after the kit's own, each once", () => {
    const highest = Math.max(...built);
    expect(Number.isFinite(highest)).toBe(true);
    const numbers = planned.map(({ check }) => numberOf(check));
    for (const n of numbers) expect(n).toBeGreaterThan(highest);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it.skipIf(!anyPending)(
    "refuses a check that claims a pending MUST until the MUST is promoted",
    () => {
      // The forcing function, shown working: the card that builds C033 and
      // lists TOOLS_RUN_AT_SITE in its `musts` is miscovered until it moves
      // the MUST from `pending` to `conformance` in the same commit.
      const pending = MUST_IDS.filter((id) =>
        kindsOf(MUSTS[id]).includes("pending"),
      );
      expect(pending.length).toBeGreaterThan(0);
      const [first] = pending;
      const imagined = { ...CHECKS[0]!, id: "C999_IMAGINED", musts: [first!] };
      expect(miscoveredMusts([...CHECKS, imagined])).toContain(first);
    },
  );
});

describe("the report names what nothing verifies yet — Owl, #55886 point 1", () => {
  const anyPending = mustsVerifiedBy("pending").length > 0;
  it.skipIf(!anyPending)(
    "prints every pending MUST under its own heading, with its checks",
    async () => {
      // A run that says "N checks passed — byollm-compatible" and names
      // BLOBS_SEALED nowhere would read as though BLOBS_SEALED were covered.
      const report = await certify(referenceTarget(), {
        only: [CHECKS[0]!.id],
      });
      const text = formatReport(report);
      const pending = mustsVerifiedBy("pending");
      expect(pending.length).toBeGreaterThan(0);
      const at = text.indexOf("Not yet verified");
      expect(at).toBeGreaterThan(-1);
      const section = text.slice(at);
      for (const id of pending) {
        expect(section, id).toContain(`- ${id} (`);
      }
      // And not under "Verified elsewhere", which would say the opposite.
      const elsewhere = text.slice(text.indexOf("Verified elsewhere"), at);
      for (const id of pending) expect(elsewhere, id).not.toContain(id);
    },
  );
});

import { describe, expect, it } from "vitest";
import { generateKeys } from "./keys.js";
import {
  GRANT_MAX_AGE_MS,
  GRANT_SIGNED_FIELDS,
  SignedGrant,
  grantStatement,
  signGrant,
  verifyGrant,
  type GrantClaims,
} from "./grant.js";

/**
 * Amendment J's grant, and every way it must refuse.
 *
 * A grant carries what consent, membership, admission and selection used to
 * carry separately, so a verifier that checked only "is this signature
 * genuine" would accept four different forgeries. Each negative below is one
 * of them.
 */
const NOW = 1_800_000_000_000;
const plane = generateKeys(NOW);
const other = generateKeys(NOW + 1);
const PUB = plane.identityPublic;

const claims = (over: Partial<GrantClaims> = {}): GrantClaims => ({
  grantId: "grant_1",
  jobId: "job_1",
  site: "site_demo",
  user: "bob",
  owner: "alice",
  purpose: "writing_assistant",
  kind: "llm.generate",
  service: "qwen",
  issuedAt: NOW,
  ...over,
});

const check = (
  grant: SignedGrant,
  over: { owner?: string; jobId?: string; now?: number; key?: string } = {},
) =>
  verifyGrant({
    grant,
    owner: over.owner ?? "alice",
    jobId: over.jobId ?? "job_1",
    controlPlanePublic: over.key ?? PUB,
    now: over.now ?? NOW,
  });

describe("a grant this device may act on", () => {
  it("verifies when everything agrees", () => {
    expect(check(signGrant(plane, claims()))).toBeNull();
  });

  it("still verifies at the edge of its window, and not past it", () => {
    const grant = signGrant(plane, claims());
    expect(check(grant, { now: NOW + GRANT_MAX_AGE_MS })).toBeNull();
    expect(check(grant, { now: NOW + GRANT_MAX_AGE_MS + 1 })).toBe("expired");
  });
});

describe("every field is inside the signature", () => {
  /**
   * The unsigned-field attack, closed mechanically rather than by review.
   *
   * A field on the document that is not in the signed bytes is a value an
   * intermediary can rewrite while every signature check passes — and the way
   * that happens is not carelessness, it is a hand-maintained list of fields
   * that does not grow when the schema does.
   *
   * So this test does not name the fields. It reads them off the schema and
   * mutates each one in turn, which means a field added tomorrow is covered
   * by a test written today. That is the only version of this check worth
   * having: the one that cannot be forgotten.
   */
  const different = (value: unknown): unknown =>
    typeof value === "number" ? value + 1 : `${String(value)}-tampered`;

  for (const field of GRANT_SIGNED_FIELDS) {
    it(`rejects a grant whose ${field} was changed after signing`, () => {
      const original = claims();
      const grant = signGrant(plane, original);
      const tampered: SignedGrant = {
        ...grant,
        [field]: different(original[field]),
      };

      // Compared at the bytes, so this is a statement about the encoding and
      // not about whichever check `verifyGrant` happens to run first.
      expect(grantStatement(tampered)).not.toEqual(grantStatement(original));
    });
  }

  it("covers every field the schema declares", () => {
    // The guard on the guard. `GRANT_SIGNED_FIELDS` is derived from
    // `SignedGrant.shape`, and a zod version that stopped exposing `shape`
    // would produce an empty list — a signature over nothing but the context
    // string, verifying for every document alike. That failure is silent
    // everywhere else, so it is asserted here.
    const declared = Object.keys(SignedGrant.shape).filter(
      (key) => key !== "signature",
    );
    expect(declared.length).toBeGreaterThan(5);
    expect([...GRANT_SIGNED_FIELDS].sort()).toEqual(declared.sort());
  });

  it("cannot be spelled by rearranging its own values", () => {
    // The separator attack. Joined with a newline, `site: "a"` +
    // `user: "b\nc"` and `site: "a\nb"` + `user: "c"` produce identical
    // bytes — two different grants, one signature. At least one of these
    // values comes from somebody else's namespace, so the encoding has to
    // escape its own separator rather than trust the inputs not to contain
    // it.
    const left = claims({ site: "a", user: "b\nc" });
    const right = claims({ site: "a\nb", user: "c" });
    expect(grantStatement(left)).not.toEqual(grantStatement(right));
  });
});

describe("the four forgeries", () => {
  it("refuses a genuine grant meant for another device's owner", () => {
    // The lifted grant. Everything about it is real; it is simply not ours,
    // and a verifier that read the owner out of the document would agree with
    // itself and admit it.
    expect(check(signGrant(plane, claims({ owner: "carol" })))).toBe(
      "wrong-owner",
    );
  });

  it("refuses a genuine grant lifted from another job", () => {
    expect(check(signGrant(plane, claims({ jobId: "job_other" })))).toBe(
      "wrong-job",
    );
  });

  it("refuses one signed by a key this device did not pin", () => {
    // The relay forging its own admission. It delivers grants and cannot
    // author them — RELAY_BLIND as arithmetic rather than as a promise.
    expect(check(signGrant(other, claims()))).toBe("bad-signature");
  });

  it("refuses one issued in the future", () => {
    // Not pedantry: an `issuedAt` ahead of now extends the grant's life past
    // the bound, which is the thing being enforced.
    expect(check(signGrant(plane, claims({ issuedAt: NOW + 60_000 })))).toBe(
      "from-the-future",
    );
  });
});

describe("which refusal a caller is told", () => {
  it("reports expiry before forgery, so the actionable one wins", () => {
    // An expired grant from an unknown key is both. "Your clock is wrong" and
    // "somebody is forging grants" send a person to very different places,
    // and only one of them is something they can fix.
    const grant = signGrant(other, claims());
    expect(check(grant, { now: NOW + GRANT_MAX_AGE_MS + 1 })).toBe("expired");
  });

  it("gives each failure its own name", () => {
    const refusals = [
      check(signGrant(plane, claims({ owner: "carol" }))),
      check(signGrant(plane, claims({ jobId: "job_other" }))),
      check(signGrant(other, claims())),
      check(signGrant(plane, claims()), { now: NOW + GRANT_MAX_AGE_MS + 1 }),
      check(signGrant(plane, claims({ issuedAt: NOW + 60_000 }))),
    ];
    expect(new Set(refusals).size).toBe(refusals.length);
  });
});

describe("the wire shape", () => {
  it("accepts what signGrant produces", () => {
    expect(SignedGrant.safeParse(signGrant(plane, claims())).success).toBe(
      true,
    );
  });

  it("refuses an unknown field rather than ignoring it", () => {
    // `.strict()`, and the reason it matters here more than anywhere: a field
    // this version does not know is a field it does not verify, and a
    // document carrying one has been written by something that believes it
    // said more than we read.
    const parsed = SignedGrant.safeParse({
      ...signGrant(plane, claims()),
      audience: "team",
    });
    expect(parsed.success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  Audience,
  BackendClass,
  BackendIdSchema,
  JobKind,
  OfferScope,
  PROTOCOL_VERSION,
  SizeClass,
} from "./index.js";
import { SignedGrant } from "./grant.js";
import { JobStub, Lease } from "./job.js";
import {
  Capability,
  HeartbeatRequest,
  HeartbeatResponse,
  ClaimRequest,
  ReleaseRequest,
} from "./wire.js";

/**
 * The wire's vocabulary, pinned against the version that describes it.
 *
 * byollm_016 removed `public` from `OfferScope`, turned `self|named` into
 * `private|team`, replaced `JobStub.service` with `purpose` and moved the
 * grant's site namespace — and `PROTOCOL_VERSION` stayed `"0"` through all of
 * it. A pre-rip daemon therefore passed the version handshake and failed
 * schema validation with a message naming nothing, once every ten seconds,
 * forever.
 *
 * That was caught by a review. This is so the next one is caught by a test.
 *
 * ## What it watches, and what it deliberately ignores
 *
 * **Enum membership and required fields.** Those are the two ways a body
 * stops parsing for somebody on the other version, in either direction:
 *
 * - a member *removed* breaks a client that still sends it (this rip), and
 * - a member *added* breaks a server that has not learned it (alpha.47,
 *   where one new backend id silenced a fleet for hours).
 *
 * **Optional fields are not watched**, and that exclusion is what keeps this
 * from being noise. Adding one is the ordinary additive change, it breaks
 * nobody, and a check that demanded a version bump for it would be routed
 * around within a month — which is worse than not having it.
 *
 * ## When it fails
 *
 * Change the vocabulary and this fails until `PROTOCOL_VERSION` moves *and*
 * the snapshot below is updated in the same commit. Both edits are the point:
 * the snapshot is the diff a reviewer reads to see exactly what moved, and
 * the version is the thing that makes the refusal actionable for whoever is
 * running the old build.
 */

/** Members of a closed vocabulary, sorted so order is never the difference. */
const members = (schema: { options: readonly string[] }): string[] =>
  [...schema.options].sort();

/**
 * The fields a body must carry, which is what an old sender fails to provide
 * and an old receiver fails to expect.
 */
const required = (schema: z.ZodObject<z.ZodRawShape>): string[] =>
  Object.entries(schema.shape)
    // A field that accepts `undefined` is optional, whatever spelling it used
    // to say so — `.optional()`, a default, or a union with undefined. Asking
    // the schema beats reading its constructor.
    .filter(([, field]) => !(field as z.ZodType).safeParse(undefined).success)
    .map(([name]) => name)
    .sort();

const VOCABULARY = {
  version: PROTOCOL_VERSION,
  enums: {
    audience: members(Audience),
    backendClass: members(BackendClass),
    backendId: members(BackendIdSchema),
    jobKind: members(JobKind),
    offerScope: members(OfferScope),
    sizeClass: members(SizeClass),
  },
  required: {
    Capability: required(Capability),
    ClaimRequest: required(ClaimRequest),
    HeartbeatRequest: required(HeartbeatRequest),
    HeartbeatResponse: required(HeartbeatResponse),
    JobStub: required(JobStub),
    Lease: required(Lease),
    ReleaseRequest: required(ReleaseRequest),
    SignedGrant: required(SignedGrant),
  },
};

/**
 * What the wire looked like when `PROTOCOL_VERSION` was last set.
 *
 * Updated **in the same commit as a version bump**, never on its own. A diff
 * that changes this and not the version is the bug this file exists for, and
 * one that changes neither is not a wire change at all.
 */
const PINNED = {
  version: "2",
  enums: {
    audience: ["private", "team"],
    backendClass: ["http", "process"],
    backendId: [
      "anthropic",
      "claude-cli",
      "codex-cli",
      "deepseek",
      "gemini",
      "grok",
      "groq",
      "jan",
      "llamacpp",
      "lmstudio",
      "localai",
      "mistral",
      "mlx",
      "ollama",
      "openai",
      "openai-http",
      "openrouter",
      "together",
      "vllm",
    ],
    jobKind: ["llm.chat", "llm.generate"],
    offerScope: ["private", "team"],
    sizeClass: ["large", "medium", "small", "unbounded"],
  },
  required: {
    Capability: [
      "backendClass",
      "backendId",
      "kind",
      "model",
      "offerScope",
      "service",
    ],
    ClaimRequest: ["capabilities", "max", "protocolVersion", "runnerId"],
    HeartbeatRequest: [
      "activeLeases",
      "capabilities",
      "daemonVersion",
      "protocolVersion",
      "runnerId",
    ],
    HeartbeatResponse: [
      "awaitingConsent",
      "cancel",
      "lost",
      "serverTime",
      "sites",
    ],
    JobStub: [
      "audience",
      "deadlineAt",
      "id",
      "kind",
      "owner",
      "site",
      "sizeClass",
      "streaming",
    ],
    Lease: ["expiresAt", "id", "runnerId"],
    ReleaseRequest: ["leases", "protocolVersion", "reason", "runnerId"],
    SignedGrant: [
      "grantId",
      "issuedAt",
      "jobId",
      "kind",
      "owner",
      "purpose",
      "service",
      "signature",
      "site",
      "user",
    ],
  },
};

/**
 * Members added under version `"2"` by ruling, and why each is not the
 * hazard this file exists for — byollm_021 §Rollout R1 (#6933, 2026-11-03).
 *
 * The rule above is that a member added is a body some old receiver cannot
 * parse, so the version moves. #6933 ruled that `PROTOCOL_VERSION` stays
 * `"2"` for the three 0.1.5 kinds, and gave the reason: each is a new value
 * that reaches only a party that advertised or declared it. A 0.1.4 daemon
 * never advertises one and so is never offered one
 * (`CLAIM_REQUIRES_CAPABILITY`); a 0.1.4 site never enqueues one. The one
 * direction that still breaks — a 0.1.5 daemon advertising a new kind to a
 * 0.1.4 upstream — is held by R2: the new kinds are off until an owner turns
 * one on, and the daemon's differential heartbeat retry (C060) keeps the
 * device serving everything else.
 *
 * Listed here rather than folded into `PINNED`, so the snapshot still says
 * what every version-2 party knows and this says what was added beside it,
 * with the ruling that allowed it. A member added here without a ruling is
 * the same mistake as editing `PINNED` alone.
 */
const ADDED_UNDER_VERSION_2 = {
  jobKind: {
    "llm.tools": "#6933 — byollm_021 §Rollout R1, byollm_012 §3",
    "llm.vision": "#6933 — byollm_021 §Rollout R1, byollm_021 §1",
    "llm.image": "#6933 — byollm_021 §Rollout R1, byollm_021 §1",
  },
} as const;

describe("the wire vocabulary and the version that describes it", () => {
  it("adds members under version 2 only by ruling, and only beside the pin", () => {
    // The control on the list itself: a member listed here that is ALSO in
    // the pin would be an addition nobody can see, and one listed here that
    // the enum does not have is a ruling about nothing.
    for (const [vocabulary, added] of Object.entries(ADDED_UNDER_VERSION_2)) {
      const pinned = PINNED.enums[vocabulary as keyof typeof PINNED.enums];
      const live = VOCABULARY.enums[vocabulary as keyof typeof PINNED.enums];
      for (const [member, ruling] of Object.entries(added)) {
        expect(pinned, member).not.toContain(member);
        expect(live, member).toContain(member);
        expect(ruling, member).toMatch(/^#\d+ — /);
      }
    }
    expect(PINNED.version).toBe("2");
  });

  it("has not changed without the version changing", () => {
    /**
     * If this fails, read the diff before touching anything.
     *
     * A member gone, or a required field added or renamed, is a body that
     * stops parsing for whoever is on the other build — and the refusal they
     * get is only actionable if `PROTOCOL_VERSION` moved, because that is the
     * one refusal that names both versions and the upgrade command.
     *
     * So: bump the version, update `PINNED` in the same commit, and the
     * handshake does the rest. Updating `PINNED` alone puts this back exactly
     * where byollm_016 left it.
     */
    const expected = structuredClone(PINNED);
    for (const [vocabulary, added] of Object.entries(ADDED_UNDER_VERSION_2)) {
      const key = vocabulary as keyof typeof PINNED.enums;
      expected.enums[key] = [
        ...expected.enums[key],
        ...Object.keys(added),
      ].sort();
    }
    expect(VOCABULARY).toEqual(expected);
  });

  it("watches every vocabulary the promotion gate asks the hub about", () => {
    /**
     * `/healthz` reports these so `ready-for-latest` can compare a deployed
     * hub against a version about to be promoted, and a vocabulary watched
     * here but not reported there is one nobody compares across the wire.
     *
     * All six now. Three were reported and three were not, so the gate
     * checked half the wire and said "safe to promote" — an `audience` the
     * hub does not know fails a whole stub, a `sizeClass` fails a whole
     * claim, and a `backendClass` fails every heartbeat carrying it.
     */
    expect(Object.keys(VOCABULARY.enums).sort()).toEqual([
      "audience",
      "backendClass",
      "backendId",
      "jobKind",
      "offerScope",
      "sizeClass",
    ]);
  });
});

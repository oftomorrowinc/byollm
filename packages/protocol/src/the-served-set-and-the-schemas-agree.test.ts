import { describe, expect, it } from "vitest";
import {
  HeartbeatRequest,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./index.js";

/**
 * What the server SAYS it serves and what its schemas ACCEPT — B291.
 *
 * Two different mechanisms decide whether a request's version is allowed, and
 * they are not the same shape:
 *
 *   - `checkProtocolVersion` asks whether the declared version is in
 *     **`SUPPORTED_PROTOCOL_VERSIONS`** — a set. The relay runs it first
 *     (`relay/src/index.ts:391`) and answers a 400 that says what to do.
 *   - Every request schema then pins **`protocolVersion: z.literal(
 *     PROTOCOL_VERSION)`** — one value. `PairStartRequest`, `PairPollRequest`,
 *     `ClaimRequest`, `HeartbeatRequest`, `ResultRequest`.
 *
 * They agree today for one reason only: the set is built from the version and
 * has a single element. **Widen it and they disagree**, in the direction the
 * release note promises out loud — *"Protocol 1 is stable, and additions ship
 * as version 2 served alongside it, routed by the version a daemon declares."*
 *
 * A v1 daemon reaching a v2 build would pass the friendly check, because 1 is
 * in the set, and then fail `z.literal("2")` — arriving as a schema error
 * about a field rather than the structured refusal written for exactly this.
 * `wire.ts` already names that outcome as the defect, four lines above the
 * constant: *"accepting its version only moves the refusal one layer down — to
 * the schema error that names nothing, which is the bug."*
 *
 * ## This does not choose how to serve two versions
 *
 * A union of literals, version-parameterised schemas, and a second endpoint
 * family are all real answers with different costs, and picking one is a
 * ruling rather than a test's business. What this refuses is the **silent**
 * divergence: the day the set grows without the schemas moving, this goes red
 * and says why, instead of a hub advertising a version its parser rejects.
 *
 * That matters beyond the daemon, because `/wire` now reports `supported` and
 * `ready-for-latest` promotes `latest` on the strength of it. A set wider than
 * the schemas would make that advertisement false and the gate would believe
 * it.
 */

describe("the served set and the schemas", () => {
  it("agree, because the schemas pin one literal", () => {
    /**
     * Asserted as equality rather than as `length === 1`, so the failure names
     * both sides. A reader meeting this red has widened the set, and the next
     * thing they need to know is which value the schemas still demand.
     */
    expect(
      SUPPORTED_PROTOCOL_VERSIONS,
      "the served set has outgrown the single version the request schemas " +
        "accept — a daemon on the extra version passes checkProtocolVersion " +
        "and then fails z.literal(PROTOCOL_VERSION), which is a schema error " +
        "where the structured refusal should be",
    ).toEqual([PROTOCOL_VERSION]);
  });

  it("is comparing a version that exists, not two copies of nothing", () => {
    /**
     * A mutation renaming `PROTOCOL_VERSION` away survived the case above: the
     * set is *derived from* the version, so both sides became `[undefined]`
     * and compared equal. **A differ pointed at itself always agrees** — the
     * equality is necessary and it is not sufficient.
     */
    expect(typeof PROTOCOL_VERSION).toBe("string");
    expect(PROTOCOL_VERSION.length).toBeGreaterThan(0);
  });

  it("is comparing the version the schemas actually pin", () => {
    /**
     * The control, and its first version was worthless.
     *
     * It built a near-empty body and asserted the parse failed — which it did,
     * on five unrelated fields (`daemonVersion`, `capabilities`,
     * `activeLeases`, `paused`, and a key the schema does not recognise). So
     * it passed while saying nothing about `protocolVersion`, and a mutation
     * replacing the literal with `z.string()` survived it.
     *
     * Two bodies now, **identical but for the version**, so the difference in
     * outcome can only be the field under test.
     */
    const good = {
      protocolVersion: PROTOCOL_VERSION,
      runnerId: "r",
      daemonVersion: "1.0.0",
      capabilities: [],
      activeLeases: [],
    };
    expect(
      HeartbeatRequest.safeParse(good).success,
      "the schema no longer accepts the current version",
    ).toBe(true);

    const other = HeartbeatRequest.safeParse({
      ...good,
      protocolVersion: `${PROTOCOL_VERSION}-not-this`,
    });
    expect(
      other.success,
      "the schema accepts a version other than PROTOCOL_VERSION, so it is no " +
        "longer a literal and this invariant is about nothing",
    ).toBe(false);
    /* And that it refused for THAT field, not for one of the others. */
    expect(
      other.success ? [] : other.error.issues.map((i) => i.path.join(".")),
    ).toEqual(["protocolVersion"]);
  });
});

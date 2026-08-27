import { describe, expect, it } from "vitest";
import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  UPGRADE_COMMAND,
  checkProtocolVersion,
} from "./wire.js";

/**
 * byollm_009 §1 listed "the connection is versionless" as a defect worth
 * fixing: a daemon and a server discovered they disagreed by failing, because
 * the version lived as a `z.literal` inside each endpoint's schema and a
 * mismatch came back as a generic `bad-request`.
 *
 * What these assert is not that a mismatch is *detected* — a literal detected
 * it — but that the refusal is **usable**: it names what the server speaks,
 * and it tells the reader what to do.
 */

describe("checkProtocolVersion", () => {
  it("passes the version this build speaks", () => {
    expect(checkProtocolVersion({ protocolVersion: PROTOCOL_VERSION })).toBe(
      null,
    );
  });

  it("refuses a version from the future, and says who needs upgrading", () => {
    const refusal = checkProtocolVersion({ protocolVersion: "99" });
    expect(refusal?.error).toBe("unsupported-protocol-version");
    // Getting this backwards sends the wrong person looking for a fix.
    expect(refusal?.message).toMatch(/server needs upgrading/);
  });

  it("refuses a version from the past, and points at the daemon", () => {
    const refusal = checkProtocolVersion({ protocolVersion: "-" });
    expect(refusal?.error).toBe("unsupported-protocol-version");
    expect(refusal?.message).toMatch(/npm i -g byollm/);
  });

  it.each([
    ["absent", {}],
    ["null", { protocolVersion: null }],
    ["a number", { protocolVersion: 0 }],
    ["empty", { protocolVersion: "" }],
    ["not an object", "protocolVersion=${PROTOCOL_VERSION}"],
    ["null body", null],
  ])("refuses a %s version the same way as a wrong one", (_label, body) => {
    // The important half: versionless is not a parse error, it is a version
    // error, and it gets the same actionable refusal.
    const refusal = checkProtocolVersion(body);
    expect(refusal?.error).toBe("unsupported-protocol-version");
    expect(refusal?.message.length).toBeGreaterThan(20);
  });

  it("always reports what it does support", () => {
    const refusal = checkProtocolVersion({ protocolVersion: "99" });
    expect(refusal?.supported).toEqual(SUPPORTED_PROTOCOL_VERSIONS);
    expect(refusal?.minimum).toBe(MIN_PROTOCOL_VERSION);
    expect(SUPPORTED_PROTOCOL_VERSIONS.length).toBeGreaterThan(0);
  });

  it("does not read a version off the prototype chain", () => {
    // `"protocolVersion" in body` walks the prototype, and a JSON body cannot
    // set one — but this module also takes objects built in-process.
    const body = Object.create({ protocolVersion: PROTOCOL_VERSION }) as object;
    expect(checkProtocolVersion(body)?.error).toBe(
      "unsupported-protocol-version",
    );
  });
});

describe("the upgrade command", () => {
  /**
   * It must never pin a prerelease tag.
   *
   * `@latest` is correct during a prerelease and after one, which is why it
   * was chosen over `@alpha` — the alternative is right today and silently
   * wrong the day the project ships stable, pinning everyone who followed it
   * to prereleases forever.
   *
   * Asserted rather than left to the docstring, because "helpfully" changing
   * this to `@alpha` during a beta is exactly the kind of edit that looks
   * correct in review.
   */
  it("does not pin a prerelease dist-tag", () => {
    expect(UPGRADE_COMMAND).toContain("byollm");
    expect(UPGRADE_COMMAND).not.toMatch(/@(alpha|beta|next|canary)\b/);
  });

  it("is the command every version refusal hands over", () => {
    // One home: a second copy in a message is a copy that keeps saying
    // `@alpha` after this one is fixed.
    const refusal = checkProtocolVersion({});
    expect(refusal?.message).toContain(UPGRADE_COMMAND);
  });

  it("refuses the vocabulary byollm_016 replaced, by name", () => {
    /**
     * byollm-review 2026-08-27, and the reason the number moved.
     *
     * The rip took `public` out of `OfferScope`, turned `self|named` into
     * `private|team`, replaced `JobStub.service` with `purpose`, and changed
     * the grant's site namespace — while `PROTOCOL_VERSION` stayed `"0"`. So
     * a pre-rip daemon passed this check and then failed whole-body schema
     * validation with "request failed schema validation": no field named, no
     * vocabulary named, no upgrade command, once every ten seconds, while its
     * owner watched a device go stale for no stated reason.
     *
     * That is the failure this function was written to prevent, arriving
     * around it — a mismatch surfacing as a generic bad-request. The fix is
     * not a better schema error; it is the version number moving when the
     * contract moves, so the refusal that already names the remedy is the one
     * that fires.
     */
    const refusal = checkProtocolVersion({ protocolVersion: "0" });

    expect(refusal).not.toBeNull();
    expect(refusal?.error).toBe("unsupported-protocol-version");
    // Names both sides of the disagreement and what to do about it. The
    // person reading this is usually the one who has to apply the fix.
    expect(refusal?.message).toContain("0");
    expect(refusal?.message).toContain(PROTOCOL_VERSION);
    expect(refusal?.message).toContain("Upgrade the daemon");
  });

  it("does not accept the old version as a migration courtesy", () => {
    /**
     * The list exists to carry two versions through a migration, and this is
     * the case where that is the wrong tool.
     *
     * A `0` daemon sends `offer: "public"` and a `service` on its stubs.
     * Accepting its version would only move the refusal one layer down, to
     * the schema error that names nothing — which is the bug. Refusing the
     * version is the point, because that refusal says what to do.
     */
    expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain("0");
  });
});

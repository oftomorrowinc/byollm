import { describe, expect, it } from "vitest";
import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
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
    ["not an object", "protocolVersion=0"],
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

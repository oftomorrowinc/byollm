import { verifyPublicIdentity, publicIdentityOf } from "@byollm/protocol";
import { describe, expect, it } from "vitest";
import { formatSiteKeys, generateSiteKeys, siteKeysFromEnv } from "./keys.js";

/**
 * A site's identity is generated once and supplied forever. Everything here is
 * about the failure that only appears under horizontal scale — keys made at
 * startup, so each instance is a different site — and about failing at boot,
 * loudly, rather than at the first pairing.
 */

describe("generateSiteKeys", () => {
  it("produces an internally consistent identity", () => {
    expect(verifyPublicIdentity(publicIdentityOf(generateSiteKeys()))).toBe(
      true,
    );
  });
});

describe("siteKeysFromEnv", () => {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64");

  it("round-trips what keygen prints", () => {
    const keys = generateSiteKeys();
    const printed = formatSiteKeys(keys);
    const line = printed
      .split("\n")
      .find((l) => l.startsWith("BYOLLM_SITE_KEYS="));
    const value = line?.slice("BYOLLM_SITE_KEYS=".length) ?? "";

    expect(
      siteKeysFromEnv("BYOLLM_SITE_KEYS", { BYOLLM_SITE_KEYS: value }),
    ).toEqual(keys);
  });

  it("prints a fingerprint alongside, and marks it as not secret", () => {
    const printed = formatSiteKeys(generateSiteKeys());
    expect(printed).toMatch(/BYOLLM(-[0-9A-HJKMNP-TV-Z]{4}){6}/);
    expect(printed).toMatch(/not secret/);
  });

  it("names the variable and the fix when it is unset", () => {
    // This throws at boot, and the person reading the log is the person who
    // can fix it — so the message has to carry the command, not just a
    // complaint.
    expect(() => siteKeysFromEnv("BYOLLM_SITE_KEYS", {})).toThrow(/keygen/);
    expect(() => siteKeysFromEnv("BYOLLM_SITE_KEYS", {})).toThrow(
      /BYOLLM_SITE_KEYS/,
    );
  });

  it("warns against generating at startup, where it fails only in production", () => {
    // The failure mode this exists to prevent: several instances, each with a
    // different identity, a daemon pinning one and being refused by another.
    expect(() => siteKeysFromEnv("BYOLLM_SITE_KEYS", {})).toThrow(
      /every instance would get a different identity/,
    );
  });

  it("refuses a value that is not base64 JSON", () => {
    expect(() =>
      siteKeysFromEnv("BYOLLM_SITE_KEYS", { BYOLLM_SITE_KEYS: "not-base64!!" }),
    ).toThrow(/base64/);
  });

  it("refuses well-formed JSON of the wrong shape, and says what it costs", () => {
    // Regenerating is not free: every paired daemon must pair again. The
    // error says so, because the obvious reaction to this message is to
    // regenerate.
    expect(() =>
      siteKeysFromEnv("BYOLLM_SITE_KEYS", {
        BYOLLM_SITE_KEYS: encode({ version: 1, identityPublic: "only-this" }),
      }),
    ).toThrow(/pair again/);
  });

  it("refuses an empty value the same as a missing one", () => {
    expect(() =>
      siteKeysFromEnv("BYOLLM_SITE_KEYS", { BYOLLM_SITE_KEYS: "" }),
    ).toThrow(/is not set/);
  });
});

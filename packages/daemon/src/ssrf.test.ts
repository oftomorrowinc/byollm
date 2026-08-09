import { describe, expect, it } from "vitest";
import { checkBaseUrl } from "./ssrf.js";

describe("checkBaseUrl — the addresses the product exists to reach", () => {
  it.each([
    ["http://127.0.0.1:11434/v1", "Ollama's default"],
    ["http://localhost:11434/v1", "Ollama by name"],
    ["http://[::1]:8080/v1", "loopback over IPv6"],
    ["http://192.168.1.50:8000/v1", "an MLX box on the LAN"],
    ["http://10.0.0.4:8000/v1", "a private-range GPU server"],
    ["https://models.internal.example.com/v1", "an internal hostname"],
  ])("allows %s (%s)", (url) => {
    // A generic SSRF filter would block every one of these, which would break
    // the primary path in exchange for no real protection: the base URL is
    // owner config and no payload can influence it.
    expect(checkBaseUrl(url).ok).toBe(true);
  });
});

describe("checkBaseUrl — what it actually refuses", () => {
  it.each([
    ["http://169.254.169.254/v1", "cloud-metadata"],
    ["http://metadata.google.internal/v1", "cloud-metadata"],
    ["http://169.254.170.2/v1", "cloud-metadata"],
    ["http://[fd00:ec2::254]/v1", "cloud-metadata"],
    ["http://169.254.1.1/v1", "link-local"],
    ["http://[fe80::1]/v1", "link-local"],
    ["http://0.0.0.0:11434/v1", "wildcard-address"],
    ["file:///etc/passwd", "bad-scheme"],
    ["ftp://example.com", "bad-scheme"],
    ["http://user:secret@example.com/v1", "credentials-in-url"],
    ["not a url at all", "not-a-url"],
    ["/relative/path", "not-a-url"],
  ])("refuses %s as %s", (url, refusal) => {
    const result = checkBaseUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe(refusal);
  });

  it("explains itself in words an owner can act on", () => {
    const result = checkBaseUrl("http://0.0.0.0:11434");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail.length).toBeGreaterThan(10);
  });
});

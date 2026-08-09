import { isIP } from "node:net";

/**
 * Why a base URL was refused.
 */
export type BaseUrlRefusal =
  | "not-a-url"
  | "bad-scheme"
  | "credentials-in-url"
  | "cloud-metadata"
  | "link-local"
  | "wildcard-address";

export type BaseUrlCheck =
  | { readonly ok: true; readonly url: URL }
  | {
      readonly ok: false;
      readonly refusal: BaseUrlRefusal;
      readonly detail: string;
    };

/**
 * Hostnames that resolve to a cloud instance's credential endpoint. Reaching
 * one from a machine running in a cloud VM hands out IAM credentials.
 */
const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "metadata",
]);

/** Literal addresses of the same endpoints. */
const METADATA_ADDRESSES = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "fd00:ec2::254",
]);

/**
 * Validate an owner-configured backend base URL
 * ({@link MUSTS.HTTP_BASE_URL_SAFE}).
 *
 * **What this is and is not.** byollm_004 Rev 1 calls the HTTP-class threat
 * surface "SSRF-shaped", and the shape matters: the base URL comes from the
 * machine owner's config and from nowhere else — no payload field can set it,
 * redirect it, or append to it. There is therefore no attacker-controlled
 * input channel into this value at all. What remains is an owner who
 * misconfigures their own machine, and the one case where that is genuinely
 * dangerous is a cloud metadata endpoint.
 *
 * So this deliberately **allows loopback and private LAN addresses**. Blocking
 * them, as a generic SSRF filter would, would refuse
 * `http://127.0.0.1:11434` — which is Ollama's default and the entire point of
 * the product. A filter that breaks the primary path in exchange for no real
 * protection is theatre, and byollm_004's honesty rule forbids claiming it as
 * a guarantee.
 *
 * Redirects are a separate matter and are refused outright by the HTTP
 * backend, so a permitted base URL cannot become a forbidden one in flight.
 */
export function checkBaseUrl(raw: string): BaseUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      refusal: "not-a-url",
      detail: "base URL is not a valid absolute URL",
    };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      refusal: "bad-scheme",
      detail: `base URL scheme ${url.protocol} is not http or https`,
    };
  }

  if (url.username !== "" || url.password !== "") {
    // Credentials in the URL would end up in logs and error messages.
    return {
      ok: false,
      refusal: "credentials-in-url",
      detail: "base URL must not embed a username or password",
    };
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (METADATA_HOSTS.has(host) || METADATA_ADDRESSES.has(host)) {
    return {
      ok: false,
      refusal: "cloud-metadata",
      detail: `${host} is a cloud metadata endpoint`,
    };
  }

  // 169.254.0.0/16 and fe80::/10 — link-local. The metadata addresses above
  // live here too; this catches the rest of the range.
  if (isIP(host) === 4 && host.startsWith("169.254.")) {
    return {
      ok: false,
      refusal: "link-local",
      detail: `${host} is link-local`,
    };
  }
  if (isIP(host) === 6 && /^fe[89ab]/.test(host)) {
    return {
      ok: false,
      refusal: "link-local",
      detail: `${host} is link-local`,
    };
  }

  // A wildcard address is a listening address, not a destination.
  if (host === "0.0.0.0" || host === "::" || host === "") {
    return {
      ok: false,
      refusal: "wildcard-address",
      detail: `${host || "(empty)"} is not a destination address`,
    };
  }

  return { ok: true, url };
}

/** Human-readable explanations for the trust UI and startup errors. */
export const BASE_URL_REFUSAL_MESSAGES: Readonly<
  Record<BaseUrlRefusal, string>
> = Object.freeze({
  "not-a-url": "that base URL could not be parsed",
  "bad-scheme": "a backend base URL must be http or https",
  "credentials-in-url":
    "put credentials in the backend's auth config, not in the URL",
  "cloud-metadata":
    "that address is a cloud metadata endpoint and would expose instance credentials",
  "link-local": "link-local addresses are refused",
  "wildcard-address":
    "that is an address to listen on, not one to connect to — use 127.0.0.1",
});

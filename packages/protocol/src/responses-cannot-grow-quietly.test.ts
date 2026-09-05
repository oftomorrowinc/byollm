import { describe, expect, it } from "vitest";
import * as protocol from "./index.js";

/**
 * A response schema may not gain a key without somebody deciding how — B019.
 *
 * The gate that exists (`wire-shapes` in the hub, read by
 * `ready-for-latest.mjs`) covers ONE direction: it refuses to promote a
 * daemon release whose requests carry keys the deployed hub does not accept.
 * That direction was built after `knownModels` took out pairing and every
 * heartbeat, and it works.
 *
 * The reverse has no gate, and it is the worse one. When the HUB gains a
 * response key, every daemon already in the field parses that response with
 * a `.strict()` schema that has never heard of it — so it does not ignore the
 * field, it rejects the whole message. One deploy, every device at once, and
 * the devices cannot be told to upgrade because the channel that would tell
 * them is the channel that is failing.
 *
 * This is not hypothetical. `updateTo` was added to `HeartbeatResponse` this
 * week for the auto-updater (B053), and the update offer would have been the
 * message that took the fleet down — the fix arriving as the outage.
 *
 * ## What this check is, and what it is not
 *
 * It is a stop sign, not a solution. It cannot know which daemons are in the
 * field. What it can do is make the hazard arrive at the moment somebody adds
 * the field, in the repository where both sides live, instead of at deploy
 * time in a repository where only one does.
 *
 * The two ways past it are both deliberate:
 *
 * 1. **Withhold by version.** The request already carries `daemonVersion`, so
 *    the sender can decline to say anything a given listener cannot hear —
 *    `mayOfferUpdate` is that, for `updateTo`.
 * 2. **Raise the floor** (B052), which makes "the oldest daemon we serve" a
 *    declared fact rather than an unknown, and only then is "every daemon
 *    understands this key" a sentence anybody can check.
 *
 * Updating the snapshot below without doing one of those is the mistake this
 * exists to make visible.
 */

/** The same walk the hub's `keyPaths` does, so both sides count keys alike. */
function keyPaths(schema: unknown): string[] {
  const found = new Set<string>();
  const def = (node: unknown): Record<string, unknown> | undefined =>
    (node as { _zod?: { def?: Record<string, unknown> } } | undefined)?._zod
      ?.def;
  const unwrap = (node: unknown): unknown => {
    const d = def(node);
    if (d === undefined) return node;
    for (const key of ["innerType", "type"] as const) {
      const inner = d[key];
      if (inner !== undefined && typeof inner === "object") {
        return unwrap(inner);
      }
    }
    return node;
  };

  const walk = (node: unknown, prefix: string, seen: Set<unknown>): void => {
    const resolved = unwrap(node);
    if (resolved === null || typeof resolved !== "object") return;
    if (seen.has(resolved)) return;
    const d = def(resolved);
    if (d === undefined) return;
    const nested = new Set(seen).add(resolved);
    const kind = d["type"];
    if (kind === "object") {
      for (const [key, child] of Object.entries(
        (d["shape"] as Record<string, unknown> | undefined) ?? {},
      )) {
        const path = prefix === "" ? key : `${prefix}.${key}`;
        found.add(path);
        walk(child, path, nested);
      }
      return;
    }
    if (kind === "array") return walk(d["element"], `${prefix}[]`, nested);
    if (kind === "union") {
      for (const option of (d["options"] as unknown[] | undefined) ?? []) {
        walk(option, prefix, nested);
      }
      return;
    }
    if (kind === "record" || kind === "map") {
      return walk(d["valueType"], `${prefix}[*]`, nested);
    }
    if (kind === "intersection") {
      walk(d["left"], prefix, nested);
      walk(d["right"], prefix, nested);
    }
  };

  walk(schema, "", new Set());
  return [...found].sort();
}

/**
 * Every schema a daemon PARSES — the ones where a new key is an outage.
 *
 * Derived from the exports by name rather than listed, for the reason the
 * hub's own walker gives: this repository has been bitten by hand-kept lists,
 * and one would go stale on the day somebody adds a schema, which is the day
 * it matters.
 */
function responseShapes(): Record<string, string[]> {
  const shapes: Record<string, string[]> = {};
  for (const [name, exported] of Object.entries(
    protocol as Record<string, unknown>,
  )) {
    if (!name.endsWith("Response")) continue;
    const paths = keyPaths(exported);
    if (paths.length > 0) shapes[name] = paths;
  }
  return shapes;
}

/**
 * What daemons parse today, and every entry is a promise to the field.
 *
 * Adding a key here is adding it to a message old daemons reject. See the
 * module note: withhold it by version, or raise the floor. Do not simply
 * paste the new list in.
 */
const AGREED: Readonly<Record<string, readonly string[]>> = {
  ClaimResponse: [
    "jobs",
    "jobs[].audience",
    "jobs[].deadlineAt",
    "jobs[].grant",
    "jobs[].grant.grantId",
    "jobs[].grant.issuedAt",
    "jobs[].grant.jobId",
    "jobs[].grant.kind",
    "jobs[].grant.owner",
    "jobs[].grant.purpose",
    "jobs[].grant.service",
    "jobs[].grant.signature",
    "jobs[].grant.site",
    "jobs[].grant.user",
    "jobs[].id",
    "jobs[].kind",
    "jobs[].lease",
    "jobs[].lease.expiresAt",
    "jobs[].lease.id",
    "jobs[].lease.runnerId",
    "jobs[].owner",
    "jobs[].purpose",
    "jobs[].site",
    "jobs[].sizeClass",
    "jobs[].streaming",
    "leaseMs",
  ],
  FetchResponse: [
    "envelope",
    "envelope.ciphertext",
    "envelope.deadlineAt",
    "envelope.direction",
    "envelope.recipientKeyId",
    "envelope.senderKeyId",
  ],
  HeartbeatResponse: [
    "awaitingConsent",
    "cancel",
    "cancel[].jobId",
    "cancel[].leaseId",
    "lost",
    "lost[].jobId",
    "lost[].leaseId",
    "serverTime",
    "sites",
    "sites[*].encryption",
    "sites[*].encryptionSig",
    "sites[*].identity",
    "successions",
    "successions[*].retiringUntil",
    "successions[*].succeeds",
    "successions[*].succeeds[].identity",
    "successions[*].succeeds[].identity.encryption",
    "successions[*].succeeds[].identity.encryptionSig",
    "successions[*].succeeds[].identity.identity",
    "successions[*].succeeds[].signature",
    "updateTo",
  ],
  PairPollResponse: [
    "controlPlanePublic",
    "owner",
    "ownerLabel",
    "runnerId",
    "sites",
    "sites[*].encryption",
    "sites[*].encryptionSig",
    "sites[*].identity",
    "status",
  ],
  PairStartResponse: [
    "deviceCode",
    "expiresAt",
    "pollIntervalMs",
    "userCode",
    "verificationUrl",
  ],
  ReleaseResponse: ["released"],
  ResultResponse: ["accepted", "duplicate", "state"],
};

describe("what a daemon parses", () => {
  it("finds the response schemas at all", () => {
    /* The control. Every assertion below is a comparison against a list, and
       an empty discovery compares nothing and passes. */
    const found = responseShapes();
    expect(Object.keys(found).length).toBeGreaterThan(0);
    expect(found).toHaveProperty("HeartbeatResponse");
  });

  it("has not grown a key since somebody last thought about it", () => {
    const found = responseShapes();
    for (const [name, agreed] of Object.entries(AGREED)) {
      const now = found[name] ?? [];
      const added = now.filter((path) => !agreed.includes(path));
      expect(
        added,
        `${name} gained ${added.join(", ")}.\n\n` +
          "Every daemon in the field parses this with a `.strict()` schema " +
          "that has\nnever heard of it, so it rejects the WHOLE message — " +
          "one deploy, every\ndevice at once, and they cannot be told to " +
          "upgrade because the channel\nthat would tell them is the one " +
          "failing.\n\n" +
          "Two ways forward, both deliberate:\n" +
          "  1. Withhold it by version. The request carries `daemonVersion`; " +
          "see\n     `mayOfferUpdate`, which is exactly this for `updateTo`.\n" +
          "  2. Raise the floor (B052), so 'the oldest daemon we serve' is a\n" +
          "     declared fact and the question becomes answerable.\n\n" +
          "Then update AGREED in this file, in the same commit.",
      ).toEqual([]);
    }
  });

  it("still covers every response schema the protocol exports", () => {
    /* A new `*Response` with no entry here is a schema nobody agreed to, and
       silence about it is how the list above stops meaning anything. */
    const uncovered = Object.keys(responseShapes()).filter(
      (name) => !(name in AGREED),
    );
    expect(
      uncovered,
      "a response schema with no agreed shape has never been checked " +
        "against what daemons in the field can parse",
    ).toEqual([]);
  });
});

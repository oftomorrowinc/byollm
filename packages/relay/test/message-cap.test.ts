import {
  MAX_ENVELOPE_BYTES,
  PROTOCOL_VERSION,
  cryptoReady,
  envelopeBytes,
  generateKeys,
  publicIdentityOf,
} from "@byollm/protocol";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Relay } from "../src/index.js";
import { SITE_ID, fixtureFor, siteHeaders } from "./harness.js";
import { tooLargeRefusal } from "../src/refusals.js";

/**
 * One message may not be larger than the relay will hold — ratified
 * 2026-08-28.
 *
 * A **relay-memory safety rail**, the same on every tier: differentiating
 * plans on it would be selling a safety limit as a benefit. What it bounds is
 * any single job, so no one message can make the relay hold an unbounded
 * amount of somebody else's memory.
 *
 * ## The property that makes it need no schema
 *
 * It is enforced **before acceptance**, on a value the relay already has in
 * hand, and nothing about the size is written down. That is not an
 * optimisation — recording a per-job size in order to enforce a limit against
 * it is exactly the figure the metering ruling exists to not keep, so a cap
 * implemented by storing sizes would have cost the ruling to gain nothing.
 */

describe("the per-message ceiling", () => {
  beforeAll(async () => {
    await cryptoReady();
  });

  it("is ten megabytes, on every plan", () => {
    // Written out rather than compared to itself. The number is a ruling, and
    // a check that derived it from the constant would pass whatever the
    // constant became.
    expect(MAX_ENVELOPE_BYTES).toBe(10 * 1024 * 1024);
  });

  it("measures what the store stores, so the cap and the bill agree", () => {
    /**
     * The rollup counts the serialised envelope, because that is what the
     * store holds and what its `HSTRLEN` reports. If the cap measured
     * anything else — the ciphertext alone, a decoded length — a job could be
     * small enough to accept and larger than it was charged as, and the two
     * numbers would be arguing about what a byte is.
     */
    const envelope = { ciphertext: "abc", recipientKeyId: "k" };
    expect(envelopeBytes(envelope)).toBe(JSON.stringify(envelope).length);
  });

  it("names the limit and the remedy", () => {
    // A ceiling somebody cannot see the height of is a ceiling they hit
    // twice. The remedy is the actionable half: this is a limit on one
    // message, not on how many.
    const body = tooLargeRefusal(MAX_ENVELOPE_BYTES + 1).body as {
      error: string;
      message: string;
    };
    expect(body.error).toBe("bad-request");
    expect(body.message).toContain("10.0 MB");
    expect(body.message).toMatch(/every plan has the same ceiling/i);
    expect(body.message).toMatch(/smaller jobs/i);
  });

  it("never says a message is exactly the size of the limit it exceeded", () => {
    /**
     * Found by rendering the sentence rather than asserting on it. `toFixed`
     * rounds to nearest, so one byte over printed "this message is 10.0 MB
     * and the limit is 10.0 MB" — a refusal that reads as a contradiction,
     * handed to somebody who now has no idea what to change.
     *
     * The size rounds up and only up, which is also the honest direction:
     * understating how far over a message is would send somebody to trim a
     * hundred bytes off something that needs to lose a megabyte.
     */
    for (const over of [1, 1024, 3 * 1024 * 1024]) {
      const body = tooLargeRefusal(MAX_ENVELOPE_BYTES + over).body as {
        message: string;
      };
      const [reported, limit] = [...body.message.matchAll(/([\d.]+) MB/g)].map(
        (m) => Number(m[1]),
      );
      expect(limit, "the limit stopped being stated").toBe(10);
      expect(
        reported,
        `a message ${String(over)} bytes over the line was reported as no ` +
          "larger than the line, so the refusal contradicts itself",
      ).toBeGreaterThan(limit!);
    }
  });

  it("refuses an oversized payload from a site", async () => {
    /**
     * The inbound half, end to end through the relay's own routing and
     * signature checks — so what is proven is that the ceiling applies to a
     * request that is otherwise entirely valid, rather than that a function
     * returns a refusal when called.
     */
    const siteKeys = generateKeys(Date.now());
    const relay = new Relay({
      fixture: fixtureFor(publicIdentityOf(siteKeys)),
    });

    const envelope = {
      ciphertext: "A".repeat(MAX_ENVELOPE_BYTES),
      recipientKeyId: "k",
      senderKeyId: "s",
      direction: "payload",
      deadlineAt: Date.now() + 60_000,
    };
    const payload = { siteId: SITE_ID, jobId: "job_big", envelope };
    const body = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      ...payload,
    });

    const response = await relay.handle(
      new Request("http://relay.test/relay/site/payload", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...siteHeaders(siteKeys, "payload", body),
        },
        body,
      }),
    );

    expect(response.status).toBe(400);
    const answer = (await response.json()) as { message?: string };
    expect(answer.message).toContain("10.0 MB");
  });

  it("lets an ordinary payload through, which is the control", async () => {
    /**
     * Without this the case above passes for any relay that refuses
     * everything — and a rail that refuses every message is not a rail, it is
     * an outage. The refusal here is `not-found`, because no such job was
     * enqueued: it got *past* the ceiling, which is the whole assertion.
     */
    const siteKeys = generateKeys(Date.now());
    const relay = new Relay({
      fixture: fixtureFor(publicIdentityOf(siteKeys)),
    });

    const payload = {
      siteId: SITE_ID,
      jobId: "job_small",
      envelope: {
        ciphertext: "A".repeat(1000),
        recipientKeyId: "k",
        senderKeyId: "s",
        direction: "payload",
        deadlineAt: Date.now() + 60_000,
      },
    };
    const body = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      ...payload,
    });

    const response = await relay.handle(
      new Request("http://relay.test/relay/site/payload", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...siteHeaders(siteKeys, "payload", body),
        },
        body,
      }),
    );

    const answer = (await response.json()) as { error?: string };
    expect(
      answer.error,
      "an ordinary payload was refused for size, so the rail is an outage",
    ).not.toBe("bad-request");
  });

  it("applies the same ceiling on the way back", () => {
    /**
     * Both directions count against the pool and both are refused by one
     * limit — a rail guarding only the inbound half would be a relay a device
     * could still fill.
     *
     * Asserted at the source rather than through a full claim-and-return
     * round trip: reaching the result endpoint honestly needs a paired
     * device, a granted lease and a sealed envelope, and a test that built
     * all of that to observe one comparison would be testing the harness. The
     * check is one expression and this is that it exists on that path.
     */
    const plane = new URL("../src/daemon-plane.ts", import.meta.url);
    const source = readFileSync(plane, "utf8");
    const result = source.slice(
      source.indexOf("  result("),
      source.indexOf("  heartbeat("),
    );
    expect(result, "the result handler has moved or changed shape").not.toBe(
      "",
    );
    expect(
      result.includes("MAX_ENVELOPE_BYTES"),
      "a device can return a result larger than the relay will accept from a " +
        "site, so the ceiling guards one direction and the pool counts two",
    ).toBe(true);
    // Before the store call, for the same reason the site plane's is: the
    // point of a memory rail is that the oversized thing is never held.
    expect(result.indexOf("MAX_ENVELOPE_BYTES")).toBeLessThan(
      result.indexOf("state.complete("),
    );
  });
});

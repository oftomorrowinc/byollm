import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  generateKeys,
  keyId,
  publicIdentityOf,
  sizeClassOf,
} from "@byollm/protocol";
import { Relay } from "../src/index.js";
import { SITE_ID, fixtureFor, siteHeaders } from "./harness.js";

/**
 * A site is told at enqueue when a slot cannot be satisfied.
 *
 * The README has promised this from the beginning — "it learns whether a slot
 * was satisfiable, and nothing else" — and nothing delivered it. An unmapped
 * purpose declined transiently, the job sat queued until it expired, and Kevin
 * lost an afternoon to a slot that could never be satisfied.
 *
 * These go through `new Relay({ satisfiable })` and then through an actual
 * enqueue, which is the part that matters. alpha.64 shipped this option on the
 * site plane's dependencies with no way to pass it from the constructor — a
 * dependency nothing could supply, and a feature nobody could reach. The first
 * test I wrote for it asserted that constructing a relay did not throw, which
 * passed with the wiring removed. A test that cannot fail is the bug it was
 * written about, one layer up.
 */
const siteKeys = generateKeys(1_700_000_000_000);

/**
 * Enqueue one job and return what the relay actually answered.
 *
 * Through `relay.handle` rather than the harness's `SiteConnector`, because
 * that helper drops the response — it returns the job it *meant* to create,
 * which is fine for the paths where enqueue succeeds and useless for the ones
 * where the whole point is the refusal.
 */
async function enqueueThrough(
  verdict: "ok" | "not-declared" | "unmapped" | "absent",
): Promise<{ status: number; body: { error?: string; message?: string } }> {
  const relay = new Relay({
    fixture: fixtureFor(publicIdentityOf(siteKeys)),
    ...(verdict === "absent"
      ? {}
      : { satisfiable: () => Promise.resolve({ verdict }) }),
  });
  const stub = {
    id: "job_1",
    kind: "llm.generate" as const,
    owner: "someone",
    // The real key id: the relay checks it against the site the signature
    // named, so a fixed string would test nothing and fail.
    site: keyId(publicIdentityOf(siteKeys).identity),
    audience: "private" as const,
    sizeClass: sizeClassOf(32),
    streaming: false,
    purpose: "fact-checker",
    deadlineAt: Date.now() + 300_000,
  };
  const rawBody = JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    siteId: SITE_ID,
    stub,
  });
  const response = await relay.handle(
    new Request("http://relay.test/relay/site/enqueue", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...siteHeaders(siteKeys, "enqueue", rawBody),
      },
      body: rawBody,
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as { error?: string; message?: string },
  };
}

describe("enqueueing a slot nobody can satisfy", () => {
  it("refuses a purpose the site does not declare", async () => {
    const said = await enqueueThrough("not-declared");
    expect(said.status).toBe(409);
    expect(said.body.error).toBe("purpose-not-declared");
    // The site's own manifest, so naming the purpose and the remedy tells a
    // developer what to fix and says nothing about any person.
    expect(said.body.message).toContain("fact-checker");
    expect(said.body.message).toContain("Developer Sites");
  });

  it("refuses an unmapped slot without saying why", async () => {
    const said = await enqueueThrough("unmapped");
    expect(said.status).toBe(409);
    expect(said.body.error).toBe("slot-unsatisfiable");
    expect(said.body.message).toMatch(/nobody has chosen/);
    /* One sentence, never why. Which service, whose device and whether one
       exists at all are the person's; a site learns only that the slot cannot
       be satisfied, and the opacity is the promise rather than a by-product. */
    for (const leak of ["service", "device", "qwen", "claude", "mapping"]) {
      expect(
        said.body.message?.toLowerCase(),
        `the refusal named ${leak}`,
      ).not.toContain(leak);
    }
  });

  it("accepts a slot that can be satisfied", async () => {
    expect((await enqueueThrough("ok")).status).toBe(200);
  });

  /* A relay with nothing to ask refuses nothing — the arrangement a
     self-hosted relay with no control plane is in, and the reason the mode is
     named at boot rather than left to be inferred from silence. */
  it("accepts everything when nothing can answer the question", async () => {
    expect((await enqueueThrough("absent")).status).toBe(200);
  });
});

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
  verdict: "ok" | "not-declared" | "unmapped" | "waiting" | "absent",
  /**
   * A control plane that cannot answer, for the transient cases.
   *
   * Passed as the rejection rather than as a whole relay, so every case in
   * this file goes through the same signed request and the same fixture — a
   * second construction is a second thing to keep in step, and the signature
   * is the part that is easy to get subtly wrong.
   */
  throws?: Error,
): Promise<{ status: number; body: { error?: string; message?: string } }> {
  const relay = new Relay({
    fixture: fixtureFor(publicIdentityOf(siteKeys)),
    ...(throws !== undefined
      ? { satisfiable: () => Promise.reject(throws) }
      : verdict === "absent"
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

  it("refuses a slot nothing can answer right now, and says only that", async () => {
    /**
     * The wait-bit — byollm_019 §6.3, ruled 2026-09-03.
     *
     * The one thing a site may learn beyond unsatisfiable: **does this need
     * the person, or only time.** Above, somebody has to go and choose a
     * model and no amount of waiting helps. Here the slot may recover with
     * nobody acting, so retrying later is the right fallback and sending the
     * person to a settings page is not.
     *
     * A separate code rather than a field, because this endpoint's 409 class
     * is already the refusal class: a site that has never heard of this code
     * still learns its job was refused, which is the fact it needs.
     */
    const said = await enqueueThrough("waiting");
    expect(said.status).toBe(409);
    expect(said.body.error).toBe("slot-waiting");
    expect(said.body.message).toMatch(/try again later/);

    /* No duration — it leaks which block was hit, and which block was hit
       says how much somebody has been working today. No cause: device
       asleep, service unhealthy and account blocked are one sentence here,
       and that is what makes the bit safe. */
    for (const leak of [
      "quota",
      "limit",
      "rate",
      "offline",
      "asleep",
      "unhealthy",
      "minute",
      "hour",
      "service",
      "device",
      "claude",
      "codex",
    ]) {
      expect(
        `${said.body.error ?? ""} ${said.body.message ?? ""}`.toLowerCase(),
        leak,
      ).not.toContain(leak);
    }
  });

  it("keeps the two refusals apart", async () => {
    /* The control. One bit is only a bit if the two states differ — folding
       waiting into unsatisfiable would pass every assertion above while
       telling a site to send somebody to a settings page for a slot that is
       going to fix itself. */
    const waiting = await enqueueThrough("waiting");
    const unmapped = await enqueueThrough("unmapped");
    expect(waiting.body.error).not.toBe(unmapped.body.error);
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

/**
 * When the control plane cannot answer — HIGH 16, 2026-09-02.
 *
 * `satisfiable` reaches the policy store. A blip there threw straight out of
 * `handle`, so a connection reset turned every cloud-lane enqueue into
 * `internal` for as long as the database was unhappy.
 *
 * The property that mattered already held — nothing turns a failed read into
 * `not-declared` or `unmapped`, so no job was refused for a reason nobody
 * could check. What was wrong is what the site was told.
 */
describe("a policy store that is having a moment", () => {
  it("says ask again, rather than saying we are broken", async () => {
    const answer = await enqueueThrough(
      "ok",
      new Error("connection reset by peer"),
    );

    // 503 and not a 409: the enqueue endpoint's 409 class is the *refusal*
    // class, and an unknown code there is read as `EnqueueRefused` — which
    // would tell a site to abandon a job the relay never evaluated.
    expect(answer.status).toBe(503);
    expect((answer.body as { error: string }).error).toBe("server-error");
  });

  it("says nothing about what failed", async () => {
    const answer = await enqueueThrough(
      "ok",
      new Error("FATAL: too many connections for role hub_reader"),
    );
    const message = JSON.stringify(answer.body).toLowerCase();

    // The upstream sentence names a role, a database and a limit. A site
    // learns that we could not answer, never that a database was the thing
    // that could not.
    for (const leaked of ["hub_reader", "connections", "fatal", "role"]) {
      expect(message, `the refusal leaked "${leaked}"`).not.toContain(leaked);
    }
  });
});

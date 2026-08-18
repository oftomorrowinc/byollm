import { cryptoReady, generateKeys, publicIdentityOf } from "@byollm/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Relay } from "../src/index.js";
import { SITE_ID, SiteConnector, fixtureFor, makeDaemon } from "./harness.js";

/**
 * A refusal, over the wire — cloud_008 §2.1.
 *
 * `REFUSAL_NOT_REOFFERED` was unimplemented on the relay, and the shape of
 * the miss is why this file exists rather than another case in the store
 * tests: the *store* could record a refusal all along. The **plane** read
 * every field of `ReleaseRequest` except `reason` and dropped it on the
 * floor.
 *
 * A store-level test of the same property passes with the plane still
 * dropping it — verified, and it is the reason this exists. The seam between
 * a handler and the store it calls is somewhere a property can be lost
 * without either side being wrong on its own.
 */

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of disposers) await d();
  disposers = [];
});

beforeAll(async () => {
  await cryptoReady();
});

async function routed() {
  const siteKeys = generateKeys(Date.now());
  const site = publicIdentityOf(siteKeys);
  const fixture = fixtureFor(site);
  const relay = new Relay({ siteId: SITE_ID, fixture });
  const connector = new SiteConnector(relay, siteKeys);
  const daemon = await makeDaemon(relay, fixture, { owner: "alice", site });
  disposers.push(daemon.dispose);
  return { relay, connector, daemon };
}

describe("release, through the plane a daemon actually calls", () => {
  it("stops offering a job to the runner that refused it", async () => {
    const { relay, connector, daemon } = await routed();
    const { jobId } = await connector.enqueue({
      prompt: "not for this machine",
      owner: "alice",
    });

    await daemon.runner.tick();
    const leaseId = (await relay.state.job(jobId))?.claimedBy?.leaseId;
    expect(leaseId).toBeDefined();

    const response = await daemon.signedFetch("release", {
      leases: [{ jobId, leaseId }],
      reason: "refused",
    });
    expect(response.status).toBe(200);

    // Back in the queue, and no longer this device's to take.
    expect((await relay.state.job(jobId))?.state).toBe("queued");
    await daemon.runner.tick();
    expect((await relay.state.job(jobId))?.state).toBe("queued");
    expect((await relay.state.job(jobId))?.claimedBy).toBeUndefined();
  });

  it("gives it back to a runner that only went away", async () => {
    // The positive control, and the failure it guards against is silent and
    // permanent: treating `shutdown` as a refusal would strand a daemon's own
    // work across a restart, and nothing would ever offer it again.
    const { relay, connector, daemon } = await routed();
    const { jobId } = await connector.enqueue({
      prompt: "back in a moment",
      owner: "alice",
    });

    await daemon.runner.tick();
    const leaseId = (await relay.state.job(jobId))?.claimedBy?.leaseId;

    await daemon.signedFetch("release", {
      leases: [{ jobId, leaseId }],
      reason: "shutdown",
    });
    expect((await relay.state.job(jobId))?.state).toBe("queued");

    await daemon.runner.tick();
    expect((await relay.state.job(jobId))?.claimedBy?.runnerId).toBe(
      daemon.runnerId,
    );
  });
});

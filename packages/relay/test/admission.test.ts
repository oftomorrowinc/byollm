import { cryptoReady, generateKeys, publicIdentityOf } from "@byollm/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Relay } from "../src/index.js";
import {
  SITE_ID,
  SiteConnector,
  controlPlane,
  makeDaemon,
  route,
} from "./harness.js";
import type { Runner } from "byollm";
import { RESERVED_PURPOSE } from "@byollm/protocol";

/**
 * Who this device will run work for — the invariant, end to end.
 *
 * Stated over the wire, through a real `Runner` against a real `Relay`,
 * because every other test of admission asks the mechanism directly and the
 * mechanism has never been the thing that broke. What broke, twice in a week,
 * was the wiring between a correct mechanism and the job that should have
 * reached it — and no unit test of a decision can see its own caller.
 *
 * The freeze gate already routes an *admitted* stranger's job (§6). The half
 * missing until now is the refusal: a relay that offers this device work for
 * somebody it does not admit, and the device declining it. That direction is
 * the one worth a standing test, because a broken admission check fails open
 * and every positive test keeps passing while it does.
 *
 * ## This file outlives the mechanism it currently uses
 *
 * byollm_016 Amendment J replaced the local allowlist and the held roster
 * with a claim-time signed grant. It landed, and this file is the receipt:
 * every assertion below is the one it was written with, and the only thing
 * that changed is {@link admit} — one line that used to write a local entry
 * and now tells a control plane to author grants. That is what naming the
 * property instead of the machinery buys.
 */

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of disposers) await d();
  disposers = [];
});

beforeAll(async () => {
  await cryptoReady();
});

/**
 * Bob's machine, on a relay that routes alice's work to it.
 *
 * Everything *upstream* of the device says yes: alice and bob have both
 * consented to the site, and alice is on bob's roster, so the relay will
 * offer alice's jobs here. Whether they run is then the device's decision
 * alone, which is the whole point — a test where the relay also refuses
 * cannot tell a working device check from a missing one.
 */
async function bobsMachine(
  over: {
    /** A clock the test moves, for the cases about waiting. */
    readonly now?: () => number;
    /** Called each time the control plane is asked, for the cases about cost. */
    readonly onAuthor?: () => void;
  } = {},
): Promise<{
  relay: Relay;
  connector: SiteConnector;
  daemon: Awaited<ReturnType<typeof makeDaemon>>;
  plane: ReturnType<typeof controlPlane>;
}> {
  const siteKeys = generateKeys(Date.now());
  const site = publicIdentityOf(siteKeys);
  const fixture = {
    sites: [{ siteId: SITE_ID, site }],
    consents: [
      { owner: "bob", siteId: SITE_ID, paused: false },
      { owner: "alice", siteId: SITE_ID, paused: false },
    ],
    devices: [],
    rosters: [{ id: "team_1", owner: "bob", members: ["alice"] }],
    revoked: [],
  };
  const plane = controlPlane(fixture);
  const relay = new Relay({
    fixture,
    controlPlanePublic: plane.relay.controlPlanePublic,
    authorGrant: (input) => {
      over.onAuthor?.();
      return plane.relay.authorGrant(input);
    },
    ...(over.now === undefined ? {} : { now: over.now }),
  });
  const connector = new SiteConnector(relay, siteKeys);
  // Offered to the team, not to the public. A publicly offered service
  // admits everyone by definition, which would make every assertion below
  // vacuous — see {@link makeDaemon}'s `offer`.
  const daemon = await makeDaemon(relay, fixture, {
    owner: "bob",
    site,
    offer: "team",
  });
  disposers.push(daemon.dispose);
  return { relay, connector, daemon, plane };
}

/**
 * Drive the loop without requiring the job to finish.
 *
 * {@link route} waits for `done`, which is exactly what a refused job never
 * reaches — using it here would turn "the device refused" into a timeout and
 * report it as a slow pass.
 */
async function settle(
  connector: SiteConnector,
  daemon: { runner: Runner },
): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await daemon.runner.tick();
    await connector.sealPending();
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("who this device will run work for", () => {
  it("always runs its owner's own work", async () => {
    // The constant every other rule is stated against. No list, no roster and
    // no grant is involved in the owner's own jobs, and none ever should be.
    const { relay, connector, daemon } = await bobsMachine();
    await connector.enqueue({ prompt: "bob's own work", owner: "bob" });
    await route(relay, connector, daemon);

    expect((await connector.collect())[0]?.outcome).toMatchObject({
      text: "echo: bob's own work",
    });
  });

  it("runs a stranger's work once the owner admits them", async () => {
    const { relay, connector, daemon, plane } = await bobsMachine();
    plane.admit("alice");
    await connector.enqueue({
      prompt: "alice's work",
      owner: "alice",
      audience: "team",
    });
    await route(relay, connector, daemon);

    expect((await connector.collect())[0]?.outcome).toMatchObject({
      text: "echo: alice's work",
    });
  });

  it("refuses a stranger's work the owner has not admitted", async () => {
    // The relay offers it — consent and roster both say yes upstream. The
    // device is the last word, and this is the direction that fails open: if
    // the check is skipped, unwired, or looking at the wrong key, every
    // positive test above still passes and only this one notices.
    const { connector, daemon } = await bobsMachine();
    await connector.enqueue({
      prompt: "alice's unadmitted work",
      owner: "alice",
      audience: "team",
    });
    await settle(connector, daemon);

    // The model is the assertion. Not the job's state, not a refusal code —
    // whether the prompt of somebody this device never admitted reached the
    // hardware it was aimed at.
    expect(daemon.backend.seen).toEqual([]);
    expect(await connector.collect()).toEqual([]);
  });

  it("names the device that ran a stranger's work [PROVENANCE_NAMES_DEVICE]", async () => {
    /**
     * The half of C014 that a direct conformance target can no longer show.
     *
     * A stranger's job cannot run against a direct server any more — nothing
     * there can author a grant — so the "a community result names the machine
     * that produced it" claim lost its end-to-end home. It lives here, where
     * a real control plane admits alice and a real device seals the answer.
     *
     * Asserted on the sealing key rather than on a label, because the key is
     * the part that cannot be forged: an app deciding whether to trust a
     * result is deciding whether it came from a machine it knows about, and
     * `runnerOwner` is only as good as the identity underneath it.
     */
    const { relay, connector, daemon, plane } = await bobsMachine();
    plane.admit("alice");
    await connector.enqueue({
      prompt: "alice's work, on bob's hardware",
      owner: "alice",
      audience: "team",
    });
    await route(relay, connector, daemon);

    const [result] = await connector.collect();
    expect(result?.outcome).toMatchObject({
      text: "echo: alice's work, on bob's hardware",
    });
    // Bob's device, not the relay's and not the site's.
    expect(result?.device.identity).toBe(daemon.keys.identityPublic);
  });

  /**
   * A declined job is released, and *how* it is released is a decision with
   * two answers — byollm_016 Phase 2a.
   *
   * `refused` means never offer this job to this device again. That is right
   * for a person removed from a team: removal stops queued claims (hole 1).
   * It is wrong for every other decline, and wrong in the direction nothing
   * reports — a job that can never reach the machine it was always meant for,
   * with no error anywhere.
   *
   * Observed by claiming again over the wire rather than through the Runner,
   * because the Runner catches, retries and translates: what is being checked
   * is what the *relay* was still willing to hand over.
   */
  describe("how a declined job is released", () => {
    const claimAgain = async (
      daemon: Awaited<ReturnType<typeof makeDaemon>>,
    ): Promise<string[]> => {
      const response = await daemon.signedFetch("claim", {
        capabilities: [
          {
            kind: "llm.generate",
            service: "primary",
            isDefault: true,
            backendId: "openai-http",
            backendClass: "http",
            model: "echo-model",
            offerScope: "team",
          },
        ],
        max: 8,
      });
      const { jobs } = (await response.json()) as { jobs: { id: string }[] };
      return jobs.map((job) => job.id);
    };

    it("never offers it again when the person was removed", async () => {
      const { connector, daemon, plane } = await bobsMachine();
      plane.admit("alice");
      const { jobId } = await connector.enqueue({
        prompt: "alice's work",
        owner: "alice",
        audience: "team",
      });

      // Removed between enqueue and claim — the case the grant exists for.
      plane.store.removeMember({ owner: "bob", user: "alice" });
      expect(await claimAgain(daemon)).not.toContain(jobId);

      /**
       * Re-admitted, and it still does not come back — which is the only way
       * to see the difference from here.
       *
       * While alice is removed, both release shapes look identical at this
       * endpoint: released plainly the job returns to the queue and is
       * declined again, so it is absent either way. The permanence is only
       * observable once the condition clears, and it is exactly what `refused`
       * means — this job, this device, never again. Hole 1 ruled that removal
       * stops queued claims; it did not rule that re-adding resumes them, and
       * the job remains claimable by another of the owner's devices.
       */
      plane.admit("alice");
      expect(await claimAgain(daemon)).not.toContain(jobId);
      expect(daemon.backend.seen).toEqual([]);
    });

    it("offers it again once the not-before has passed, and not before", async () => {
      /**
       * The bug this shape exists to prevent, and the rate it needs.
       *
       * Alice is a member and has consented; her mapping names a service this
       * machine does not offer — another of bob's devices does, or she is
       * about to fix it. Marking that permanently would take the job off this
       * device for ever. Releasing it plainly would let this device re-claim
       * at once and be declined again, for ever: a spin, and one control
       * plane read per turn of it.
       *
       * So it comes back, thirty seconds later. Both halves are asserted
       * here because either alone is a bug that passes.
       */
      let clock = Date.now();
      const { connector, daemon, plane, relay } = await bobsMachine({
        now: () => clock,
      });
      plane.admit("alice");
      plane.store.consent({
        siteId: SITE_ID,
        user: "alice",
        mappings: [
          {
            purpose: RESERVED_PURPOSE,
            kind: "llm.generate",
            service: "on-another-machine",
          },
        ],
      });
      const { jobId } = await connector.enqueue({
        prompt: "alice's work",
        owner: "alice",
        audience: "team",
      });

      expect(await claimAgain(daemon)).not.toContain(jobId);
      // Immediately after, it is still not on offer here — which is the half
      // that stops the spin.
      expect(await claimAgain(daemon)).not.toContain(jobId);
      // Another of bob's machines would get it now, though: this is a
      // not-here, not a refusal.
      expect((await relay.state.job(SITE_ID, jobId))?.state).toBe("queued");

      // She fixes the mapping, and the wait elapses.
      plane.admit("alice");
      clock += 31_000;
      expect(await claimAgain(daemon)).toContain(jobId);
    });

    it("asks the control plane a bounded number of times about a job it cannot run", async () => {
      /**
       * The measurement that found this, kept as the check.
       *
       * Before the not-before, twelve ticks produced twelve control-plane
       * reads — in a deployment, twelve database queries for a job that was
       * never going to run on that device, growing without limit. The number
       * below is not the point; that it does not grow with the tick count is.
       */
      const clock = Date.now();
      let asked = 0;
      const { connector, daemon, plane } = await bobsMachine({
        now: () => clock,
        onAuthor: () => {
          asked += 1;
        },
      });
      plane.admit("alice");
      plane.store.consent({
        siteId: SITE_ID,
        user: "alice",
        mappings: [
          {
            purpose: RESERVED_PURPOSE,
            kind: "llm.generate",
            service: "on-another-machine",
          },
        ],
      });
      await connector.enqueue({
        prompt: "alice's work",
        owner: "alice",
        audience: "team",
      });

      for (let i = 0; i < 12; i += 1) await daemon.runner.tick();
      expect(asked).toBe(1);
    });
  });

  it("refuses a stranger a different relay would admit", async () => {
    // Admission is per relay because owner ids are namespace local: `alice`
    // on one server is not `alice` on another. Under the allowlist this was a
    // rule about how entries were keyed. Under grants it is structural — a
    // grant verifies against the key pinned with *this* pairing, so another
    // relay's word about `alice` is not a document this device can even read.
    const { connector, daemon, plane } = await bobsMachine();
    plane.admit("alice-elsewhere");
    await connector.enqueue({
      prompt: "alice's work under another origin's grant",
      owner: "alice",
      audience: "team",
    });
    await settle(connector, daemon);

    expect(daemon.backend.seen).toEqual([]);
  });
});

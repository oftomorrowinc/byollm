import { cryptoReady, generateKeys, publicIdentityOf } from "@byollm/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Relay } from "../src/index.js";
import { SITE_ID, SiteConnector, makeDaemon, route } from "./harness.js";
import type { Runner } from "byollm";

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
 * byollm_016 Amendment J replaces the local allowlist and the held roster
 * with a claim-time signed grant. When it lands, the *assertions* below are
 * unchanged — a device runs work for whoever it admits and refuses everyone
 * else — and only {@link admit} changes, from a line that writes a local
 * entry to a line that has the control plane sign a grant. That is why the
 * describe blocks name the property and not the machinery.
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
async function bobsMachine(): Promise<{
  relay: Relay;
  connector: SiteConnector;
  daemon: Awaited<ReturnType<typeof makeDaemon>>;
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
    signedRosters: [],
    revoked: [],
  };
  const relay = new Relay({ fixture });
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
  return { relay, connector, daemon };
}

/**
 * Bob admits alice to his device.
 *
 * The one line that Amendment J rewrites. Today it is a local allowlist
 * entry; after J it is a signed grant from the control plane, and nothing
 * below this line changes.
 */
async function admit(
  daemon: Awaited<ReturnType<typeof makeDaemon>>,
  owner: string,
): Promise<void> {
  await daemon.allowlist.add(
    { origin: "http://relay.test", owner },
    Date.now(),
  );
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
    const { relay, connector, daemon } = await bobsMachine();
    await admit(daemon, "alice");
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

  it("refuses a stranger the owner admitted on a different site", async () => {
    // Admission is keyed by (origin, user) because owner ids are namespace
    // local: `alice` on one server is not `alice` on another. An entry that
    // matched on the name alone would let any relay this device pairs with
    // borrow every name it had ever been told to trust.
    const { connector, daemon } = await bobsMachine();
    await admit(daemon, "alice-elsewhere");
    await daemon.allowlist.add(
      { origin: "https://somewhere-else.test", owner: "alice" },
      Date.now(),
    );
    await connector.enqueue({
      prompt: "alice's work under another origin's grant",
      owner: "alice",
      audience: "team",
    });
    await settle(connector, daemon);

    expect(daemon.backend.seen).toEqual([]);
  });
});

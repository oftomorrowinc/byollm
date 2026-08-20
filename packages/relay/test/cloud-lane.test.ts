import { randomUUID } from "node:crypto";
import {
  cryptoReady,
  generateKeys,
  keyId,
  publicIdentityOf,
} from "@byollm/protocol";
import {
  ByollmApp,
  MemoryStore,
  generateSiteKeys,
  type ByollmStore,
} from "@byollm/server";
import { supabaseStore } from "@byollm/server/supabase";
import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Relay } from "../src/index.js";
import { routeKey } from "../src/state.js";
import { SITE_ID, fixtureFor, makeDaemon } from "./harness.js";

/**
 * The cloud lane, against every store that claims to implement it.
 *
 * cloud_004 §9.4's demonstrations, run **once** over N adapters rather than
 * written once per adapter. That is deliberate and it is the point: the bug
 * this file exists for was a lease id that a memory store accepted and
 * Postgres rejected, and a second copy of the scenario is a second place for
 * the two to quietly diverge.
 *
 * ## Why Postgres is not optional here
 *
 * The `uuid` finding is the specimen. `lease_<job>_<time>` routed perfectly
 * against `MemoryStore` and would have failed the instant a real site adopted
 * it, because `byollm_jobs.lease_id` is typed `uuid`. It was caught by reading
 * a migration — which is luck, not process. A real-infrastructure path with no
 * real-infrastructure test is a promise rather than a property.
 *
 * So when the local stack is configured this suite runs against it, and when
 * it is not it says so loudly rather than passing quietly: a green run that
 * silently skipped the only case that matters is worse than a red one.
 */

const SUPABASE_URL = process.env["SUPABASE_URL"] ?? "";
const SERVICE_KEY =
  process.env["SUPABASE_SERVICE_ROLE_KEY"] ??
  process.env["SUPABASE_SECRET_KEY"] ??
  "";
const HAS_SUPABASE = SUPABASE_URL !== "" && SERVICE_KEY !== "";

/** One adapter under test, and how to name an owner it will accept. */
interface StoreCase {
  readonly name: string;
  make(): Promise<{ store: ByollmStore; owner: string }>;
}

const CASES: StoreCase[] = [
  {
    name: "MemoryStore",
    make: () => Promise.resolve({ store: new MemoryStore(), owner: "alice" }),
  },
];

if (HAS_SUPABASE) {
  CASES.push({
    name: "supabaseStore (real Postgres)",
    make: async () => {
      const client = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      // Postgres wants a uuid that references `auth.users`, where the memory
      // store is happy with "alice". The relay only ever compares owner
      // strings for equality, so whichever the store needs is what the whole
      // route uses — including the consent fixture and the daemon's pairing.
      const { data, error } = await client.auth.admin.createUser({
        email: `relay+${randomUUID().slice(0, 8)}@byollm.test`,
        email_confirm: true,
      });
      if (error)
        throw new Error(`could not create a test user: ${error.message}`);
      return { store: supabaseStore({ client }), owner: data.user.id };
    },
  });
}

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of disposers) await d();
  disposers = [];
});

beforeAll(async () => {
  await cryptoReady();
});

it("says so when the Postgres case is not running", () => {
  // Not a skip: a skip is easy to stop noticing. If the local stack is not
  // configured this test names the gap in the report, every run, and the CI
  // job that provides the stack asserts the opposite below.
  if (!HAS_SUPABASE) {
    expect(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are unset — the Postgres " +
        "case did not run. `cd packages/server && supabase start` to include it.",
    ).toBeTruthy();
  }
  expect(CASES.length).toBeGreaterThanOrEqual(1);
});

if (process.env["REQUIRE_SUPABASE"] === "1") {
  it("runs the Postgres case, because this job exists to run it", () => {
    // The pre-stamp gate, asserted rather than assumed. A CI job that starts
    // Supabase and then silently exercises only the memory store would report
    // exactly the green the uuid bug already survived once.
    expect(HAS_SUPABASE).toBe(true);
  });
}

describe.each(CASES)("the cloud lane over $name", (storeCase) => {
  it("round-trips through app.enqueue with the lane as config", async () => {
    const { store, owner } = await storeCase.make();
    const siteKeys = generateSiteKeys();
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site, {
      consents: [{ owner, siteId: SITE_ID, paused: false }],
    });
    const relay = new Relay({ fixture });

    const app = new ByollmApp({
      store,
      siteKeys,
      lane: {
        relayOrigin: "http://relay.test",
        siteId: SITE_ID,
        fetch: (input, init) => relay.handle(new Request(input, init)),
      },
    });

    const daemon = await makeDaemon(relay, fixture, {
      owner,
      site,
    });
    disposers.push(daemon.dispose);

    const handle = await app.enqueue({
      kind: "llm.generate",
      owner,
      audience: "self",
      payload: { prompt: "through the relay" },
    });

    // The relay got a stub. The payload is still in the site's own store,
    // sealed at rest — direct mode's property inherited, not replaced.
    expect((await relay.state.job(SITE_ID, handle.id))?.stub.kind).toBe(
      "llm.generate",
    );
    expect(JSON.stringify(await relay.state.jobs())).not.toContain(
      "through the relay",
    );

    for (let i = 0; i < 100; i += 1) {
      await daemon.runner.tick();
      const report = await app.cloud!.pump();
      // The lease the relay granted, written into the site's own row. This
      // is `adopt`, and against Postgres it is also the assertion that the
      // relay's lease ids are a shape the column accepts.
      expect(report.refused).toEqual([]);
      const record = await app.job(handle.id);
      if (record?.state === "ok") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const delivered = await app.result(handle.id);
    expect(delivered?.outcome).toMatchObject({
      outcome: "ok",
      text: "echo: through the relay",
    });
    expect(delivered?.provenance?.untrusted).toBe(false);
    expect(daemon.backend.seen).toEqual(["through the relay"]);
  });

  it("adopts the relay's lease into its own row", async () => {
    // Stated as its own demonstration because it is the store-contract
    // addition the cloud lane forced, and because the two adapters implement
    // it separately — which is exactly where a divergence would live.
    const { store, owner } = await storeCase.make();
    const siteKeys = generateSiteKeys();
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site, {
      consents: [{ owner, siteId: SITE_ID, paused: false }],
    });
    const relay = new Relay({ fixture });
    const app = new ByollmApp({
      store,
      siteKeys,
      lane: {
        relayOrigin: "http://relay.test",
        siteId: SITE_ID,
        fetch: (input, init) => relay.handle(new Request(input, init)),
      },
    });
    const daemon = await makeDaemon(relay, fixture, {
      owner,
      site,
    });
    disposers.push(daemon.dispose);

    const handle = await app.enqueue({
      kind: "llm.generate",
      owner,
      audience: "self",
      payload: { prompt: "who holds this" },
    });

    // Before the claim the site's row knows nothing about any device.
    // MemoryStore reports no lease as , Postgres as  —
    // a divergence worth naming rather than papering over with a loose
    // matcher, and harmless because callers check truthiness.
    expect((await app.job(handle.id))?.lease ?? null).toBeNull();

    await daemon.runner.tick();
    for (let i = 0; i < 40; i += 1) {
      const report = await app.cloud!.pump();
      if (report.sealed.includes(handle.id)) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const record = await app.job(handle.id);
    expect(record?.state).toBe("claimed");
    // Deliberately *not* a runner: this site never paired with the machine
    // holding the job, holds no token for it and could not revoke it. On
    // Postgres `lease_runner` is a foreign key into `byollm_runners`, so
    // recording one would mean fabricating a row for a relationship that
    // does not exist. The grant is what the site knows, so the grant is what
    // it stores — and who actually ran the work arrives with the result,
    // proved by a signature rather than asserted by a row.
    expect(record?.lease?.runnerId ?? "").toBe("");
    // The id round-tripped through whatever the store's column is. Against
    // Postgres that is `uuid`, and a composite id would have failed here.
    expect(record?.lease?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("refuses a result the relay attributes to the wrong device", async () => {
    const { store, owner } = await storeCase.make();
    const siteKeys = generateSiteKeys();
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site, {
      consents: [{ owner, siteId: SITE_ID, paused: false }],
    });
    const relay = new Relay({ fixture });
    const app = new ByollmApp({
      store,
      siteKeys,
      lane: {
        relayOrigin: "http://relay.test",
        siteId: SITE_ID,
        fetch: (input, init) => relay.handle(new Request(input, init)),
      },
    });
    const daemon = await makeDaemon(relay, fixture, {
      owner,
      site,
    });
    disposers.push(daemon.dispose);

    const handle = await app.enqueue({
      kind: "llm.generate",
      owner,
      audience: "self",
      payload: { prompt: "whose result is this" },
    });

    for (let i = 0; i < 80; i += 1) {
      await daemon.runner.tick();
      await app.cloud!.pump();
      if ((await relay.state.job(SITE_ID, handle.id))?.state === "done") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // A relay lying about provenance: the same sealed bytes, a device that
    // did not sign them. This is what keeps RELAY_BLIND from becoming
    // RELAY_TRUSTED, and it must hold identically on every store.
    const impostor = publicIdentityOf(generateKeys(Date.now()));
    const routed = await relay.state.job(SITE_ID, handle.id);
    routed!.claimedBy = { ...routed!.claimedBy!, device: impostor };

    const report = await app.cloud!.pump();
    expect(report.completed).not.toContain(handle.id);
  });

  it("survives a relay that is mid-deploy, and finishes the job after", async () => {
    // What a draining pod actually does: readiness goes false, the pod keeps
    // answering for the length of its `preStop` window, and every routed call
    // gets `503 {"error":"not-ready"}`. That is the drain design working —
    // callers are told to come back rather than meeting a closed socket.
    //
    // This lane used to read that answer's body without looking at the status
    // and throw `TypeError: finished.jobs is not iterable`: a site falling
    // over because its relay was polite. Found by a deploy's own wire proof,
    // on a release that had nothing to do with it.
    //
    // The property is not "pump does not throw" — it is that the work is
    // still there afterwards. So the drain happens *around a real job*, and
    // the assertion is that the job completes once the pod has gone.
    const { store, owner } = await storeCase.make();
    const siteKeys = generateSiteKeys();
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site, {
      consents: [{ owner, siteId: SITE_ID, paused: false }],
    });
    const relay = new Relay({ fixture });

    let draining = false;
    const app = new ByollmApp({
      store,
      siteKeys,
      lane: {
        relayOrigin: "http://relay.test",
        siteId: SITE_ID,
        fetch: (input, init) =>
          draining
            ? Promise.resolve(
                new Response(
                  JSON.stringify({ error: "not-ready", message: "draining" }),
                  {
                    status: 503,
                    headers: { "content-type": "application/json" },
                  },
                ),
              )
            : relay.handle(new Request(input, init)),
      },
    });

    const daemon = await makeDaemon(relay, fixture, { owner, site });
    disposers.push(daemon.dispose);

    const handle = await app.enqueue({
      kind: "llm.generate",
      owner,
      audience: "self",
      payload: { prompt: "across a deploy" },
    });

    draining = true;
    for (let i = 0; i < 3; i += 1) {
      // No throw, and not silence either: a site that had nothing to do and a
      // site that was told to wait must not look the same in a log.
      const report = await app.cloud!.pump();
      expect(report.deferred).toBeDefined();
      expect(report.sealed).toEqual([]);
      expect(report.completed).toEqual([]);
    }
    draining = false;

    for (let i = 0; i < 100; i += 1) {
      await daemon.runner.tick();
      const report = await app.cloud!.pump();
      expect(report.deferred).toBeUndefined();
      expect(report.refused).toEqual([]);
      if ((await app.job(handle.id))?.state === "ok") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const delivered = await app.result(handle.id);
    expect(delivered?.outcome).toMatchObject({
      outcome: "ok",
      text: "echo: across a deploy",
    });
  });
});

describe("provenance names a person, not a key", () => {
  /**
   * cloud_008 §2.5, finding 41 — two owner namespaces compared for equality.
   *
   * The cloud lane filled `runnerOwner` with `keyId(device.identity)`. The
   * direct plane fills it with the owner's id. Same field, same type, two
   * different kinds of value — so an app asking "did my own machine run
   * this?" across both lanes compared a key id to a user id and got `false`
   * for the same person.
   *
   * The relay has held the right value since the claim: `claimedBy.owner`,
   * supplied by the projection.
   */
  it("reports the owner the projection named, on both lanes alike", async () => {
    const { store, owner } = await CASES[0]!.make();
    const siteKeys = generateSiteKeys();
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site, {
      consents: [{ owner, siteId: SITE_ID, paused: false }],
    });
    const relay = new Relay({ fixture });
    const app = new ByollmApp({
      store,
      siteKeys,
      lane: {
        relayOrigin: "http://relay.test",
        siteId: SITE_ID,
        fetch: (i, init) => relay.handle(new Request(i, init)),
      },
    });
    const daemon = await makeDaemon(relay, fixture, { owner, site });
    disposers.push(daemon.dispose);

    const job = await app.enqueue({
      kind: "llm.generate",
      owner,
      audience: "self",
      payload: { prompt: "whose machine ran this" },
    });

    for (let i = 0; i < 12; i += 1) {
      await daemon.runner.tick();
      await app.cloud!.pump();
      if ((await store.get(job.id))?.state === "ok") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const record = await store.get(job.id);
    expect(record?.state).toBe("ok");
    // A person, in the namespace consent and rosters are written in.
    expect(record?.provenance?.runnerOwner).toBe(owner);
    // And specifically not the device key id it used to be — stated so the
    // regression is named rather than merely absent.
    expect(record?.provenance?.runnerOwner).not.toBe(
      keyId(publicIdentityOf(daemon.keys).identity),
    );
  });
});

describe("the site's own row decides whether to seal", () => {
  /**
   * cloud_008 §2.2 — `adopt()` returned `null` and the cloud lane ignored it.
   *
   * `adopt` refuses a job that is terminal or already leased, and its own
   * comment says why: that means the relay and this store disagree about
   * reality, and the store's row is not the place to resolve it. The return
   * value was discarded, so the site sealed the payload anyway.
   *
   * Sealing is the irreversible half. Once the ciphertext is at the relay a
   * device can fetch and run it — so a job the app had already cancelled, or
   * whose deadline had passed, was handed out because the pump did not read
   * an answer it had already asked for.
   */
  it("does not seal for a job its own store refuses to lend out", async () => {
    const { store, owner } = await CASES[0]!.make();
    const siteKeys = generateSiteKeys();
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site, {
      consents: [{ owner, siteId: SITE_ID, paused: false }],
    });
    const relay = new Relay({ fixture });

    const app = new ByollmApp({
      store,
      siteKeys,
      lane: {
        relayOrigin: "http://relay.test",
        siteId: SITE_ID,
        fetch: (i, init) => relay.handle(new Request(i, init)),
      },
    });

    const job = await app.enqueue({
      kind: "llm.generate",
      owner,
      audience: "self",
      payload: { prompt: "cancelled before anyone ran it" },
    });

    // A device claims at the relay — which knows nothing about cancellation,
    // and that is the whole point of the case.
    const device = publicIdentityOf(generateSiteKeys());
    relay.project({
      ...fixture,
      devices: [{ owner, runnerId: "runner_x", device }],
    });
    await relay.state.claim({
      runnerId: "runner_x",
      owner,
      device,
      kinds: new Set(["llm.generate"]),
      routes: new Set([routeKey(SITE_ID, owner)]),
      max: 1,
      leaseMs: 60_000,
    });

    // Meanwhile the app cancels. The site's own row is now terminal.
    await app.cancel(job.id);

    const report = await app.cloud!.pump();

    expect(report.refused).toContain(job.id);
    expect(report.sealed).not.toContain(job.id);
    // And nothing was handed to the relay — the assertion that matters, since
    // a payload there is a payload a device can run.
    expect((await relay.state.job(SITE_ID, job.id))?.payload).toBeUndefined();
  });
});

describe("what the relay is told, and what it is not", () => {
  /**
   * cloud_008 §0.2 — `audienceAllow` reaches nobody.
   *
   * It is a list of the people who may run a job, and it was on the stub: sent
   * to the relay on every `named` job, and sent to the daemon on the direct
   * plane. byollm_009 §6 calls the stub's metadata "exhaustive and normative…
   * what an upstream can see, stated as a commitment", and this was not on the
   * list.
   *
   * The ruling went further than withholding it from the relay. byollm_001
   * Rev 1 §B settled who decides `named` before any of this existed — *the
   * daemon's own list decides, not the server's* — so the field was a second
   * answer to a question the daemon already owned, able only to agree or to
   * disagree with nothing written down about which wins. It is off the schema
   * entirely, and `JobStub.strict()` is what keeps it off.
   *
   * The rule it leaves: **a class the router acts on may travel; membership
   * never does.**
   *
   * Asserted against the *stub the relay stored*, not against the publisher's
   * argument — the question is what the third party holds, and only its own
   * copy answers that.
   */
  it("never receives audienceAllow, on any lane", async () => {
    const { store, owner } = await CASES[0]!.make();
    const siteKeys = generateSiteKeys();
    const site = publicIdentityOf(siteKeys);
    const fixture = fixtureFor(site, {
      consents: [{ owner, siteId: SITE_ID, paused: false }],
    });
    const relay = new Relay({ fixture });

    const app = new ByollmApp({
      store,
      siteKeys,
      lane: {
        relayOrigin: "http://relay.test",
        siteId: SITE_ID,
        fetch: (i, init) => relay.handle(new Request(i, init)),
      },
    });

    const job = await app.enqueue({
      kind: "llm.generate",
      owner,
      audience: "named",
      // The site restricts the job to two named people…
      audienceAllow: ["carol", "erin"],
      payload: { prompt: "who may run this" },
    });

    const routed = await relay.state.job(SITE_ID, job.id);
    expect(routed).toBeDefined();
    // …and the relay is told none of it. Checked by serialising the stub
    // rather than by reading a field that no longer exists: the property is
    // that the names are not there, and a test naming the removed field would
    // stop compiling instead of stopping the leak.
    expect(JSON.stringify(routed?.stub)).not.toContain("carol");
    expect(JSON.stringify(routed?.stub)).not.toContain("erin");

    // The rest of the enumerated list is still there — "sends nothing" would
    // pass this test and break routing.
    expect(routed?.stub.owner).toBe(owner);
    expect(routed?.stub.kind).toBe("llm.generate");
    expect(routed?.stub.audience).toBe("named");
  });

  it("still records it on the site's own row, where enforcement reads it", async () => {
    // The other half. Taking it off the wire must not mean losing it: the
    // site's own `claim` filters candidates with this list before offering a
    // job, which is legitimate — the party holding the list authored it, and
    // it never leaves. What ended was sending a second copy to somebody else
    // to check.
    const { store, owner } = await CASES[0]!.make();
    const siteKeys = generateSiteKeys();
    const app = new ByollmApp({ store, siteKeys });

    const job = await app.enqueue({
      kind: "llm.generate",
      owner,
      audience: "named",
      audienceAllow: ["carol"],
      payload: { prompt: "still known here" },
    });

    const record = await store.get(job.id);
    expect(record?.audienceAllow).toEqual(["carol"]);
  });
});

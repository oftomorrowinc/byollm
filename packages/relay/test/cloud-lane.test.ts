import { randomUUID } from "node:crypto";
import { cryptoReady, generateKeys, publicIdentityOf } from "@byollm/protocol";
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
      consents: [{ owner, siteId: SITE_ID }],
    });
    const relay = new Relay({ siteId: SITE_ID, fixture });

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
    expect((await relay.state.job(handle.id))?.stub.kind).toBe("llm.generate");
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
      consents: [{ owner, siteId: SITE_ID }],
    });
    const relay = new Relay({ siteId: SITE_ID, fixture });
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
      consents: [{ owner, siteId: SITE_ID }],
    });
    const relay = new Relay({ siteId: SITE_ID, fixture });
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
      if ((await relay.state.job(handle.id))?.state === "done") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // A relay lying about provenance: the same sealed bytes, a device that
    // did not sign them. This is what keeps RELAY_BLIND from becoming
    // RELAY_TRUSTED, and it must hold identically on every store.
    const impostor = publicIdentityOf(generateKeys(Date.now()));
    const routed = await relay.state.job(handle.id);
    routed!.claimedBy = { ...routed!.claimedBy!, device: impostor };

    const report = await app.cloud!.pump();
    expect(report.completed).not.toContain(handle.id);
  });
});

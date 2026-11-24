import {
  PROTOCOL_VERSION,
  cryptoReady,
  generateKeys,
  keyId,
  publicIdentityOf,
  sizeClassOf,
} from "@byollm/protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Relay } from "../src/index.js";
import { SITE_ID, fixtureFor, makeDaemon, siteHeaders } from "./harness.js";

/**
 * A paused service is the owner's to know — byollm_019 §3.4, #10825.
 *
 * The heartbeat now says which services a device has stopped offering until a
 * clock says otherwise, and when. Two things are true of it here, and each is
 * a test: the relay keeps it the way it keeps the matrix (whole, latest only,
 * an empty list clears it), and a site is told exactly what it was told
 * before the list existed — not a byte more, by any path.
 */

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers) await dispose();
  disposers = [];
});

beforeAll(async () => {
  await cryptoReady();
});

const PAUSED = [
  { service: "primary", why: "allowance", until: Date.now() + 3_600_000 },
] as const;

async function paired(relay: Relay, fixture: ReturnType<typeof fixtureFor>) {
  const daemon = await makeDaemon(relay, fixture, {
    owner: "alice",
    site: fixture.sites[0]!.site,
    offer: "private",
  });
  disposers.push(daemon.dispose);
  const beat = (extra: Record<string, unknown>) =>
    daemon.signedFetch("heartbeat", {
      daemonVersion: "test",
      capabilities: [],
      activeLeases: [],
      ...extra,
    });
  return { daemon, beat };
}

describe("the relay keeps the paused list", () => {
  it("whole, replaced on every beat, and cleared by an empty one", async () => {
    const siteKeys = generateKeys(Date.now());
    const fixture = fixtureFor(publicIdentityOf(siteKeys));
    const relay = new Relay({ fixture });
    const { daemon, beat } = await paired(relay, fixture);

    expect((await beat({ paused: PAUSED })).status).toBe(200);
    expect((await relay.state.presence(daemon.runnerId))?.paused).toEqual(
      PAUSED,
    );

    const other = [{ service: "claude", why: "allowance" }];
    expect((await beat({ paused: other })).status).toBe(200);
    expect((await relay.state.presence(daemon.runnerId))?.paused).toEqual(
      other,
    );

    expect((await beat({ paused: [] })).status).toBe(200);
    expect((await relay.state.presence(daemon.runnerId))?.paused).toEqual([]);
  });

  it("reads an older daemon, which never sends it, as nothing paused", async () => {
    const siteKeys = generateKeys(Date.now());
    const fixture = fixtureFor(publicIdentityOf(siteKeys));
    const relay = new Relay({ fixture });
    const { daemon, beat } = await paired(relay, fixture);

    expect((await beat({ paused: PAUSED })).status).toBe(200);
    // The key absent, as every daemon before #10825 sends it.
    expect((await beat({})).status).toBe(200);
    expect((await relay.state.presence(daemon.runnerId))?.paused).toEqual([]);
  });

  it("refuses an entry carrying anything but a word and a time", async () => {
    // The CLI's sentence quotes paths, usernames and account emails. The
    // schema is what keeps it off the wire, so it is tested at the door.
    const siteKeys = generateKeys(Date.now());
    const fixture = fixtureFor(publicIdentityOf(siteKeys));
    const relay = new Relay({ fixture });
    const { beat } = await paired(relay, fixture);

    const leaked = await beat({
      paused: [
        {
          service: "primary",
          why: "allowance",
          detail: "You've hit your usage limit (todd@example.com)",
        },
      ],
    });
    expect(leaked.status).toBe(400);
  });
});

describe("a site is told the same bytes with and without it", () => {
  /** Everything a site reads in one session, as the raw bytes it reads. */
  async function whatTheSiteReads(paused: boolean): Promise<string[]> {
    const siteKeys = generateKeys(1_700_000_000_000);
    const fixture = fixtureFor(publicIdentityOf(siteKeys));
    const relay = new Relay({
      fixture,
      // One slot the control plane says is waiting — the refusal at enqueue
      // a site meets when nothing can answer it right now — and one it can.
      satisfiable: (input: { readonly purpose: string | undefined }) =>
        Promise.resolve({
          verdict:
            input.purpose === "fact-checker"
              ? ("waiting" as const)
              : ("ok" as const),
        }),
    });
    const { beat } = await paired(relay, fixture);
    expect((await beat(paused ? { paused: PAUSED } : {})).status).toBe(200);

    const site = keyId(publicIdentityOf(siteKeys).identity);
    const send = async (endpoint: string, body: unknown) => {
      const rawBody = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        ...(body as object),
      });
      const response = await relay.handle(
        new Request(`http://relay.test/relay/site/${endpoint}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...siteHeaders(siteKeys, endpoint, rawBody),
          },
          body: rawBody,
        }),
      );
      return `${String(response.status)} ${await response.text()}`;
    };
    const read = async (endpoint: string) => {
      const response = await relay.handle(
        new Request(
          `http://relay.test/relay/site/${endpoint}?siteId=${SITE_ID}` +
            `&protocolVersion=${PROTOCOL_VERSION}`,
          { headers: siteHeaders(siteKeys, endpoint, "") },
        ),
      );
      return `${String(response.status)} ${await response.text()}`;
    };
    const stub = (id: string, purpose: string) => ({
      siteId: SITE_ID,
      stub: {
        id,
        kind: "llm.generate",
        owner: "alice",
        site,
        audience: "private",
        sizeClass: sizeClassOf(32),
        streaming: false,
        purpose,
        deadlineAt: 1_900_000_000_000,
      },
    });

    return [
      await send("enqueue", stub("job_refused", "fact-checker")),
      await send("enqueue", stub("job_taken", "summary")),
      await read("pending"),
      await read("results"),
    ];
  }

  it("at enqueue, refused or taken, and on every read after", async () => {
    const without = await whatTheSiteReads(false);
    const withIt = await whatTheSiteReads(true);
    // The refusal is a refusal, so this compares something real.
    expect(without[0]).toMatch(/^409 /);
    expect(withIt).toEqual(without);
    for (const said of withIt) {
      expect(said).not.toMatch(/paused|allowance|primary|until/);
    }
  });
});

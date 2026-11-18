import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import * as protocolNow from "@byollm/protocol";
import {
  JOB_KINDS,
  PROTOCOL_VERSION,
  RESERVED_PURPOSE,
  cryptoReady,
  generateKeys,
  publicIdentityOf,
} from "@byollm/protocol";
import { ByollmApp, MemoryStore } from "@byollm/server";
import {
  Budgets,
  ClientError,
  DAEMON_VERSION,
  DaemonConfig,
  DeviceIdentity,
  IngressLog,
  ProtocolClient,
  Runner,
  SpendLedger,
  connect,
  resolveConfig,
  type Backend,
  type BackendRequest,
  type BackendResult,
  type RunnerEvent,
} from "byollm-0.1.4";
import * as protocol014 from "byollm-protocol-0.1.4";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  MemoryBlobStore,
  MemoryPairingCodes,
  Relay,
  type RelayFixture,
} from "../src/index.js";
import { SITE_ID, controlPlane } from "./harness.js";

/**
 * #9552 — the published `byollm@0.1.4` daemon against a 0.1.5 hub, with the
 * 0.1.5 kinds in play. `PROTOCOL_VERSION` stayed `"2"` for 0.1.5 (#6933,
 * `wire-vocabulary.test.ts`'s `ADDED_UNDER_VERSION_2`) on the reason that a
 * new kind reaches only a party that advertised it. This is that reason, run.
 *
 * **The daemon is the one on npm**, installed under the alias `byollm-0.1.4`
 * from `npm:byollm@0.1.4`, with the `@byollm/protocol@0.1.4` it pins. Not a
 * reconstruction from this tree: a double of 0.1.4 would parse whatever its
 * author believed 0.1.4 parses, and agreement needs the other end's parser.
 * The first case proves the import is that package and not this tree's
 * source wearing its name.
 *
 * **The hub is this tree's**: the relay hub.byollm.cloud runs, behind the
 * real control plane (`@byollm/control-plane`, via the harness), with a blob
 * store so vision and image jobs can be queued at all, and a 0.1.5
 * `@byollm/server` on the relay lane as the site — so every new-kind job
 * waiting here was enqueued by the SDK a 0.1.5 site runs, not hand-built.
 *
 * The other direction — a 0.1.5 daemon against the published 0.1.4 server —
 * is `packages/conformance/test/guard-b-against-0.1.4.test.ts` (C060).
 */

const ORIGIN = "http://relay.test";

/** Where the published package actually lives on disk. */
const PUBLISHED = realpathSync(
  fileURLToPath(new URL("../node_modules/byollm-0.1.4", import.meta.url)),
);

beforeAll(async () => {
  await cryptoReady();
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

/** A model as the published daemon's own `Backend` interface describes one. */
class EchoBackend implements Backend {
  readonly stopReasons = {
    kind: "unavailable" as const,
    why: "a test double reads no vendor signal",
  };
  readonly id = "openai-http" as const;
  readonly class = "http" as const;
  readonly seen: string[] = [];
  health(): Promise<{ healthy: boolean; models: string[] }> {
    return Promise.resolve({ healthy: true, models: ["echo-model"] });
  }
  execute(request: BackendRequest): Promise<BackendResult> {
    this.seen.push(request.prompt);
    return Promise.resolve({
      ok: true,
      text: `echo: ${request.prompt}`,
      durationMs: 1,
    });
  }
}

/** One exchange the 0.1.4 daemon had with the hub, as it went over the wire. */
interface Exchange {
  readonly endpoint: string;
  readonly request: Record<string, unknown>;
  readonly status: number;
  readonly body: unknown;
}

/** A PNG small enough to be a vision input. */
function png(): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", Buffer.from(Array.from({ length: 64 }, (_, i) => i))),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

/**
 * The 0.1.5 hub, a 0.1.5 site on it, and bob's Mac on the published 0.1.4,
 * paired by the 0.1.4 daemon's own `connect` — the device-code flow.
 */
async function bobsOldMac(options: { controlPlane?: boolean } = {}) {
  const withPlane = options.controlPlane ?? true;
  const siteKeys = generateKeys(Date.now());
  const site = publicIdentityOf(siteKeys);
  const fixture: RelayFixture = {
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
  // alice's work on bob's machine is what carries a grant: an owner's own
  // jobs never do.
  plane.admit("alice");
  // Every kind mapped to bob's `primary`, the new three included — what an
  // owner who also runs a 0.1.5 machine has. With only the harness's two
  // 0.1.4 kinds mapped, the control plane would decline a new-kind job for
  // having no mapping, and this file would pass for that reason instead of
  // the one it is about.
  //
  // Even mapped, the control plane holds a second gate keyed on the same
  // thing: it grants only for a kind the claiming device advertised
  // (`engine.ts`, `offered`). So on this hub the new kinds are kept from a
  // 0.1.4 device twice — the relay's claim match and the grant — and the
  // case after the main one runs a hub with no control plane, where the
  // claim match is alone. Found by removing each and watching what failed.
  for (const user of ["bob", "alice"]) {
    plane.store.consent({
      siteId: SITE_ID,
      user,
      mappings: JOB_KINDS.map((kind) => ({
        purpose: RESERVED_PURPOSE,
        kind,
        service: "primary",
        owner: "bob",
      })),
    });
  }
  const pairingCodes = new MemoryPairingCodes(() => Date.now());
  const relay = new Relay({
    fixture,
    ...(withPlane ? plane.relay : {}),
    blobs: { store: new MemoryBlobStore({ origin: ORIGIN }) },
    pairingCodes,
    verificationUrl: `${ORIGIN}/settings/runners`,
  });
  const app = new ByollmApp({
    store: new MemoryStore(),
    siteKeys,
    lane: {
      relayOrigin: ORIGIN,
      siteId: SITE_ID,
      fetch: (input, init) => relay.handle(new Request(input, init)),
    },
  });

  // Everything the 0.1.4 daemon sent and every answer it got, in order.
  const wire: Exchange[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const sent = await request.clone().text();
    const response = await relay.handle(request);
    const text = await response.clone().text();
    wire.push({
      endpoint: new URL(request.url).pathname.replace(/^\/byollm\//, ""),
      request: sent === "" ? {} : (JSON.parse(sent) as Record<string, unknown>),
      status: response.status,
      body: text === "" ? {} : (JSON.parse(text) as unknown),
    });
    return response;
  };

  const home = await mkdtemp(join(tmpdir(), "byollm-014-on-015-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const identity = new DeviceIdentity(join(home, "keys.json"));
  const loaded = resolveConfig(
    DaemonConfig.parse({
      services: {
        primary: {
          model: "echo-model",
          kinds: ["llm.generate"],
          type: "openai-http",
          baseUrl: "http://127.0.0.1:11434/v1",
          offer: "team",
        },
      },
      concurrency: 2,
    }),
  );

  // The 0.1.4 daemon's own pairing: start, show a code, poll. The dashboard
  // approval is the control plane's projection learning the keypair, which
  // is what the hub's poll reads.
  const runnerId = randomUUID();
  let userCode = "";
  let polls = 0;
  let approve: Promise<void> = Promise.resolve();
  const approveCode = async (code: string): Promise<void> => {
    const pending = await pairingCodes.byUserCode(code);
    if (pending === undefined) throw new Error("no such pairing code");
    fixture.devices.push({ owner: "bob", runnerId, device: pending.device });
    relay.project(fixture);
  };
  const pairing = connect({
    client: new ProtocolClient({ origin: ORIGIN, fetch: fetchImpl }),
    daemonVersion: DAEMON_VERSION,
    device: await identity.publicIdentity(Date.now()),
    label: "bob's old mac",
    capabilities: [],
    onCode: (info) => {
      userCode = info.userCode;
    },
    // Approved after the first poll, so the daemon also reads a `pending`.
    onPoll: () => {
      polls += 1;
      if (polls === 2) approve = approveCode(userCode);
    },
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  const paired = await pairing;
  await approve;
  if (!paired.ok) throw new Error(`could not pair: ${paired.message}`);

  const budgets = new Budgets(join(home, "b.json"), loaded.config.community);
  await budgets.load(Date.now());
  const spend = new SpendLedger(join(home, "s.json"));
  await spend.load(Date.now());
  const backend = new EchoBackend();
  const events: RunnerEvent[] = [];
  const client = new ProtocolClient({
    origin: ORIGIN,
    identity: {
      runnerId: paired.pairing.runnerId,
      sign: (input) => identity.signRequest(input),
    },
    fetch: fetchImpl,
  });
  const runner = new Runner({
    client,
    runnerId: paired.pairing.runnerId,
    owner: paired.pairing.owner,
    identity: {
      keys: () => identity.load(Date.now()),
      sites: new Map(Object.entries(paired.pairing.sites)),
    },
    ...(paired.pairing.controlPlanePublic === undefined
      ? {}
      : { controlPlanePublic: paired.pairing.controlPlanePublic }),
    daemonVersion: DAEMON_VERSION,
    loaded,
    budgets,
    spend,
    ingress: new IngressLog({
      path: join(home, "ingress.log"),
      communityPromptDays: 7,
      keepSelfPrompts: true,
    }),
    backendFactory: () => backend,
    onEvent: (event) => events.push(event),
  });
  cleanup.push(async () => {
    await runner.shutdown("shutdown").catch(() => undefined);
  });

  return {
    relay,
    app,
    runner,
    client,
    backend,
    events,
    wire,
    paired: paired.pairing,
    controlPlanePublic: plane.relay.controlPlanePublic,
  };
}

/** The three kinds 0.1.5 added, waiting for bob as a 0.1.5 site queues them. */
async function enqueueTheNewKinds(app: ByollmApp) {
  const tools = await app.enqueue({
    kind: "llm.tools",
    owner: "bob",
    payload: {
      messages: [{ role: "user", content: "Is the moon made of cheese?" }],
      tools: [
        {
          name: "web_search",
          description: "Search the web for a claim",
          parameters: {
            type: "object",
            properties: { query: { type: "string", maxLength: 400 } },
            required: ["query"],
          },
        },
      ],
      purposeLimits: { maxToolCalls: 8, maxToolResultChars: 32_000 },
    },
  });
  const vision = await app.enqueue({
    kind: "llm.vision",
    owner: "bob",
    payload: {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", image: png() },
          ],
        },
      ],
    },
  });
  const image = await app.enqueue({
    kind: "llm.image",
    owner: "bob",
    payload: { prompt: "a square", aspect: "landscape" },
  });
  return [tools.id, vision.id, image.id];
}

/**
 * Every value 0.1.5 added that a 0.1.4 party could choke on, as it would
 * appear in a JSON body. `BlobDirection`'s `in`/`out` are not scanned for as
 * bare words — every body would match — so blob traffic is looked for by
 * its fields instead.
 */
const ADDED_VALUES = [
  "llm.tools",
  "llm.vision",
  "llm.image",
  "tool-budget",
  ...protocolNow.IMAGE_MEDIA_TYPES,
  ...protocolNow.ImageAspect.options,
  ...protocolNow.ToolsRefusal.options,
] as const;

describe("#9552: the published byollm@0.1.4 daemon against a 0.1.5 hub, the new kinds in play", () => {
  it("is the package from npm, on the protocol it pins, and both say version 2", () => {
    const pkg = JSON.parse(
      readFileSync(join(PUBLISHED, "package.json"), "utf8"),
    ) as { name: string; version: string };
    expect(pkg).toMatchObject({ name: "byollm", version: "0.1.4" });
    expect(DAEMON_VERSION).toBe("0.1.4");
    // The protocol the daemon itself imports — resolved from the daemon's
    // directory, as Node resolves it — is 0.1.4's.
    const pinned = JSON.parse(
      readFileSync(
        join(PUBLISHED, "..", "@byollm", "protocol", "package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(pinned.version).toBe("0.1.4");
    expect(protocol014.PROTOCOL_VERSION).toBe("2");
    expect(PROTOCOL_VERSION).toBe("2");
    // And the 0.1.4 vocabulary is what this file compares against: it has
    // none of the three kinds.
    expect([...protocol014.JOB_KINDS].sort()).toEqual([
      "llm.chat",
      "llm.generate",
    ]);
    expect(
      JOB_KINDS.filter(
        (kind) => !(protocol014.JOB_KINDS as readonly string[]).includes(kind),
      ).sort(),
    ).toEqual(["llm.image", "llm.tools", "llm.vision"]);
  });

  it("pairs, beats, stays present, is never handed a new kind, and answers the llm.generate jobs queued behind them", async () => {
    const hub = await bobsOldMac();

    // 1. Paired, through the 0.1.4 daemon's device-code flow, with the
    //    control plane's key pinned.
    expect(hub.paired.owner).toBe("bob");
    expect(hub.paired.controlPlanePublic).toBe(hub.controlPlanePublic);
    const pairedAt = (await hub.relay.state.presence(hub.paired.runnerId))
      ?.lastSeenAt;
    expect(pairedAt).toBeDefined();

    // 2. The new kinds wait for bob. Then the old Mac beats and claims, more
    //    than once, with them queued.
    const newKindJobs = await enqueueTheNewKinds(hub.app);
    for (const id of newKindJobs) {
      expect((await hub.relay.state.job(SITE_ID, id))?.state).toBe("queued");
    }
    for (let i = 0; i < 4; i += 1) {
      expect(await hub.runner.tick()).toBe(0);
      await hub.app.pump();
    }

    // Then llm.generate behind them: bob's own, and then alice's on bob's
    // machine, which is the one that carries a grant. One at a time, so each
    // claim answer is one shape.
    const runToOk = async (id: string): Promise<void> => {
      for (let i = 0; i < 100; i += 1) {
        await hub.runner.tick();
        await hub.app.pump();
        if ((await hub.app.job(id))?.state === "ok") return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const own = await hub.app.enqueue({
      kind: "llm.generate",
      owner: "bob",
      payload: { prompt: "bob's own, behind the new kinds" },
    });
    await runToOk(own.id);
    const admitted = await hub.app.enqueue({
      kind: "llm.generate",
      owner: "alice",
      payload: { prompt: "alice's, on bob's machine" },
    });
    await runToOk(admitted.id);

    expect((await hub.app.result(own.id))?.outcome).toMatchObject({
      outcome: "ok",
      text: "echo: bob's own, behind the new kinds",
    });
    expect((await hub.app.result(admitted.id))?.outcome).toMatchObject({
      outcome: "ok",
      text: "echo: alice's, on bob's machine",
    });
    expect([...hub.backend.seen].sort()).toEqual([
      "alice's, on bob's machine",
      "bob's own, behind the new kinds",
    ]);

    // Never handed one: every stub the hub gave this device was an
    // llm.generate, and the new-kind jobs are still waiting.
    const claims = hub.wire.filter((x) => x.endpoint === "claim");
    const handed = claims.flatMap(
      (x) => (x.body as { jobs: { id: string; kind: string }[] }).jobs,
    );
    expect(handed.map((stub) => stub.kind)).toEqual([
      "llm.generate",
      "llm.generate",
    ]);
    for (const id of newKindJobs) {
      expect(handed.map((stub) => stub.id)).not.toContain(id);
      expect((await hub.relay.state.job(SITE_ID, id))?.state).toBe("queued");
    }
    // What it advertised, on every beat and every claim: 0.1.4's one kind.
    for (const x of hub.wire.filter((y) =>
      ["heartbeat", "claim"].includes(y.endpoint),
    )) {
      const kinds = (x.request["capabilities"] as { kind: string }[]).map(
        (c) => c.kind,
      );
      expect(kinds).toEqual(["llm.generate"]);
    }

    // Kept beating, every beat accepted, and present at the end.
    const beats = hub.wire.filter((x) => x.endpoint === "heartbeat");
    expect(beats.length).toBeGreaterThanOrEqual(6);
    expect(beats.every((x) => x.status === 200)).toBe(true);
    const present = await hub.relay.state.presence(hub.paired.runnerId);
    expect(present?.lastSeenAt).toBeGreaterThanOrEqual(pairedAt ?? Infinity);
    expect(present?.capabilities.map((c) => c.kind)).toEqual(["llm.generate"]);
    // Nothing the daemon said about itself is a failure.
    expect(
      hub.events.filter((e) =>
        /error|fail|refus|malformed|revok/i.test(e.type),
      ),
    ).toEqual([]);

    // 3. Everything a 0.1.4 device parses from a 0.1.5 hub, parsed by the
    //    published 0.1.4 schemas — the very bodies this hub sent. The
    //    daemon already parsed them (it ran); this names each one and says
    //    which schema, so a later reader sees the list rather than a pass.
    const parsed = parseEveryAnswer(hub.wire);
    expect(parsed).toEqual({
      "pair start → PairStartResponse": "parses",
      "pair poll (pending) → PairPollResponse": "parses",
      "pair poll (approved) → PairPollResponse": "parses",
      "heartbeat → HeartbeatResponse": "parses",
      "claim (empty) → ClaimResponse": "parses",
      // Every stub this hub hands out carries a grant — the owner's own
      // included — because a relay with a control plane asks it on every
      // claim. A grant-less stub is the direct lane's, not the hub's.
      "claim (stub + grant) → ClaimResponse and SignedGrant": "parses",
      // The daemon fetches before the site has sealed: the hub says
      // `not-ready` and the daemon waits. A refusal every relayed job meets.
      "fetch refusal (409 not-ready) → WireError": "parses",
      "fetch → FetchResponse": "parses",
      "result → ResultResponse": "parses",
    });
    // The grants were verified by the daemon, not just parsed: alice's job
    // ran on bob's machine, which 0.1.4 does only on a grant signed by the
    // key it pinned at pairing.
    const grants = handed.map(
      (stub) => (stub as { grant?: { jobId: string; user: string } }).grant,
    );
    expect(grants.map((grant) => [grant?.jobId, grant?.user])).toEqual([
      [own.id, "bob"],
      [admitted.id, "alice"],
    ]);

    // And none of 0.1.5's additions reached this device in any body.
    const everything = JSON.stringify(hub.wire.map((x) => x.body));
    for (const value of ADDED_VALUES) {
      expect(everything, value).not.toContain(`"${value}"`);
    }
    // Blob traffic, by its fields. Not `direction`: the sealed envelope has
    // carried one since 0.1.4 (`payload`/`result`), which is a different
    // vocabulary from `BlobDirection`'s `in`/`out`.
    expect(everything).not.toMatch(/"(blob|blobs|toolsDigest)":/);
    expect(everything).not.toMatch(/"direction":"(in|out)"/);
  });

  it("is never handed a new kind by a hub with no control plane either, where the claim match is the only gate", async () => {
    const hub = await bobsOldMac({ controlPlane: false });
    expect(hub.paired.controlPlanePublic).toBeUndefined();
    const newKindJobs = await enqueueTheNewKinds(hub.app);
    const own = await hub.app.enqueue({
      kind: "llm.generate",
      owner: "bob",
      payload: { prompt: "behind the new kinds, no control plane" },
    });
    for (let i = 0; i < 100; i += 1) {
      await hub.runner.tick();
      await hub.app.pump();
      if ((await hub.app.job(own.id))?.state === "ok") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await hub.app.result(own.id))?.outcome).toMatchObject({
      outcome: "ok",
      text: "echo: behind the new kinds, no control plane",
    });
    const handed = hub.wire
      .filter((x) => x.endpoint === "claim")
      .flatMap(
        (x) => (x.body as { jobs: { id: string; kind: string }[] }).jobs,
      );
    expect(handed.map((stub) => [stub.id, stub.kind])).toEqual([
      [own.id, "llm.generate"],
    ]);
    for (const id of newKindJobs) {
      expect((await hub.relay.state.job(SITE_ID, id))?.state).toBe("queued");
    }
    // A grant-less stub is this hub's shape, and 0.1.4 parses it too.
    expect(parseEveryAnswer(hub.wire)).toMatchObject({
      "claim (stub) → ClaimResponse": "parses",
    });
    expect(
      Object.values(parseEveryAnswer(hub.wire)).every((v) => v === "parses"),
    ).toBe(true);
  });

  it("parses the hub's refusals as 0.1.4 wire errors, a new-kind job's included", async () => {
    const hub = await bobsOldMac();
    const [toolsJob] = await enqueueTheNewKinds(hub.app);
    await hub.runner.tick();

    // Asking for a job it does not hold — the llm.tools job waiting for its
    // owner. The 0.1.4 client turns the body into an error whose message is
    // the hub's own sentence, which it does only when `WireError` parsed.
    const refused = await hub.client
      .fetch({
        runnerId: hub.paired.runnerId,
        jobId: toolsJob ?? "",
        leaseId: "lease_this_device_never_held",
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(ClientError);
    const answer = hub.wire.at(-1);
    expect(answer?.endpoint).toBe("fetch");
    expect(answer?.status).toBeGreaterThanOrEqual(400);
    const wire = protocol014.WireError.safeParse(answer?.body);
    expect(wire.success, JSON.stringify(answer?.body)).toBe(true);
    expect((refused as ClientError).message).toBe(wire.data?.message);
    expect(JSON.stringify(answer?.body)).not.toContain("llm.tools");

    // An unsigned call: the other refusal every device meets.
    const unsigned = await new ProtocolClient({
      origin: ORIGIN,
      fetch: (input, init) => hub.relay.handle(new Request(input, init)),
    })
      .heartbeat({
        runnerId: hub.paired.runnerId,
        daemonVersion: DAEMON_VERSION,
        capabilities: [],
        activeLeases: [],
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(unsigned).toBeInstanceOf(ClientError);
    expect((unsigned as ClientError).kind).toBe("unauthorized");
    expect((unsigned as ClientError).message).not.toMatch(/returned HTTP/);
  });

  it("would refuse a new kind if one ever reached it — which is why advertisement is the gate", async () => {
    // Not a failure of 0.1.5: the record of what the gate is holding back.
    // The published 0.1.4 parsers close every enum the three kinds live in,
    // so the property above rests on the hub never sending one, and this
    // keeps that visible. Fed by hand, through the 0.1.4 client's own parse,
    // to a 0.1.4 ProtocolClient — a stub the 0.1.5 schema accepts.
    const stub = {
      id: "job_tools_1",
      kind: "llm.tools",
      owner: "bob",
      site: "site_key",
      audience: "private",
      sizeClass: "small",
      streaming: false,
      deadlineAt: Date.now() + 60_000,
      lease: { id: "lease_1", runnerId: "r", expiresAt: Date.now() + 30_000 },
    };
    expect(protocolNow.ClaimedStub.safeParse(stub).success).toBe(true);
    const client = new ProtocolClient({
      origin: ORIGIN,
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ jobs: [stub], leaseMs: 30_000 }), {
            headers: { "content-type": "application/json" },
          }),
        ),
    });
    const thrown = await client
      .claim({ runnerId: "r", capabilities: [], max: 1 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(thrown).toBeInstanceOf(ClientError);
    expect((thrown as ClientError).kind).toBe("malformed-response");

    // Every addition, against the 0.1.4 schema that would have to carry it.
    // The kinds: `JobKind` (stub, grant-less claim) and `Capability.kind`.
    for (const kind of ["llm.tools", "llm.vision", "llm.image"]) {
      expect(protocol014.JobKind.safeParse(kind).success, kind).toBe(false);
    }
    // `tool-budget` is a stop reason a DAEMON writes into a sealed outcome;
    // 0.1.4's vocabulary lacks it, and no hub body carries one to a device.
    expect(protocol014.StopReasonSchema.safeParse("tool-budget").success).toBe(
      false,
    );
    // The rest are vocabularies 0.1.4 does not have at all — no schema of
    // its could be asked to parse them, because none names them.
    const exported = protocol014 as Record<string, unknown>;
    for (const name of [
      "BlobDirection",
      "IMAGE_MEDIA_TYPES",
      "ImageAspect",
      "ImageMediaType",
      "ToolsRefusal",
    ]) {
      expect(exported[name], name).toBeUndefined();
      expect(
        (protocolNow as Record<string, unknown>)[name],
        name,
      ).toBeDefined();
    }
  });

  it("has no healthz to parse: the published daemon never reads one", () => {
    // `/healthz` and its vocabularies are read by the deployment audit and
    // `ready-for-latest`, not by a device. Checked in the published code
    // itself, every file of it.
    for (const file of ["index.js", "bin.js"]) {
      expect(readFileSync(join(PUBLISHED, "dist", file), "utf8")).not.toContain(
        "healthz",
      );
    }
    const chunks = readFileSync(join(PUBLISHED, "dist", "index.js"), "utf8")
      .match(/from "\.\/(chunk-[\w-]+\.js)"/g)
      ?.map((line) => line.slice(8, -1));
    expect(chunks?.length).toBeGreaterThan(0);
    for (const chunk of chunks ?? []) {
      expect(
        readFileSync(join(PUBLISHED, "dist", chunk), "utf8"),
      ).not.toContain("healthz");
    }
    // What `/healthz` reports is the wire's six enums. Between the 0.1.4 a
    // device pins and 0.1.5, exactly one of them moved, by exactly the three
    // kinds — the rest a 0.1.4 reader would recognise member for member.
    const vocab = (p: typeof protocolNow | typeof protocol014) => ({
      audience: [...p.Audience.options].sort(),
      backendClass: [...p.BackendClass.options].sort(),
      backendId: [...p.BackendIdSchema.options].sort(),
      jobKind: [...p.JobKind.options].sort(),
      offerScope: [...p.OfferScope.options].sort(),
      sizeClass: [...p.SizeClass.options].sort(),
    });
    const then = vocab(protocol014);
    const now = vocab(protocolNow);
    expect({ ...now, jobKind: then.jobKind }).toEqual(then);
    expect(now.jobKind.filter((k) => !then.jobKind.includes(k))).toEqual([
      "llm.image",
      "llm.tools",
      "llm.vision",
    ]);
  });
});

/**
 * Parse every answer the daemon got with the published 0.1.4 schema for its
 * endpoint, and name each kind of answer once.
 *
 * A body that does not parse is reported by name with zod's message — the
 * field that failed — rather than thrown, so a failure says which surface.
 */
function parseEveryAnswer(wire: readonly Exchange[]): Record<string, string> {
  const seen: Record<string, string> = {};
  const note = (
    label: string,
    result: { success: boolean; error?: { message: string } },
  ) => {
    const verdict = result.success
      ? "parses"
      : `FAILS: ${result.error?.message ?? ""}`;
    if (seen[label] === undefined || verdict !== "parses")
      seen[label] = verdict;
  };
  for (const x of wire) {
    if (x.status >= 400) {
      const code = (x.body as { error?: string }).error ?? "?";
      note(
        `${x.endpoint} refusal (${String(x.status)} ${code}) → WireError`,
        protocol014.WireError.safeParse(x.body),
      );
      continue;
    }
    switch (x.endpoint) {
      case "pair": {
        if (x.request["action"] === "start") {
          note(
            "pair start → PairStartResponse",
            protocol014.PairStartResponse.safeParse(x.body),
          );
        } else {
          const status = (x.body as { status?: string }).status ?? "?";
          note(
            `pair poll (${status}) → PairPollResponse`,
            protocol014.PairPollResponse.safeParse(x.body),
          );
        }
        break;
      }
      case "heartbeat":
        note(
          "heartbeat → HeartbeatResponse",
          protocol014.HeartbeatResponse.safeParse(x.body),
        );
        break;
      case "claim": {
        const jobs = (x.body as { jobs?: { grant?: unknown }[] }).jobs ?? [];
        const claim = protocol014.ClaimResponse.safeParse(x.body);
        if (jobs.length === 0) {
          note("claim (empty) → ClaimResponse", claim);
        } else if (jobs.some((job) => job.grant !== undefined)) {
          note("claim (stub + grant) → ClaimResponse and SignedGrant", claim);
          for (const job of jobs) {
            if (job.grant === undefined) continue;
            note(
              "claim (stub + grant) → ClaimResponse and SignedGrant",
              protocol014.SignedGrant.safeParse(job.grant),
            );
          }
        } else {
          note("claim (stub) → ClaimResponse", claim);
        }
        break;
      }
      case "fetch":
        note(
          "fetch → FetchResponse",
          protocol014.FetchResponse.safeParse(x.body),
        );
        break;
      case "result":
        note(
          "result → ResultResponse",
          protocol014.ResultResponse.safeParse(x.body),
        );
        break;
      case "release":
        note(
          "release → ReleaseResponse",
          protocol014.ReleaseResponse.safeParse(x.body),
        );
        break;
      default:
        note(`${x.endpoint} → (no 0.1.4 schema)`, {
          success: false,
          error: { message: "an endpoint 0.1.4 does not call" },
        });
    }
  }
  return seen;
}

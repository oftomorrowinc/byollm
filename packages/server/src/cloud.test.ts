import {
  ENVELOPE_MAX_AGE_MS,
  cryptoReady,
  generateKeys,
  keyId,
  publicIdentityOf,
  seal,
  type PublicIdentity,
  type SealedEnvelope,
} from "@byollm/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { ByollmApp } from "./app.js";
import { generateSiteKeys } from "./keys.js";
import { MemoryStore } from "./memory.js";

/**
 * The cloud lane's refusals.
 *
 * The round-trip is demonstrated end to end against a real relay and a real
 * daemon in the freeze gate. What that cannot easily produce is a *dishonest*
 * relay, so those paths are exercised here, where the relay's answers can be
 * whatever we like.
 *
 * Each of these is the same question: which of the relay's claims does the
 * site believe? The answer is none of the ones that matter — it believes
 * signatures, and the relay cannot produce them.
 */

beforeAll(async () => {
  await cryptoReady();
});

/** A relay that answers however a test tells it to. */
function fakeRelay(answers: {
  pending?: unknown[];
  results?: unknown[];
  onPayload?: (body: unknown) => void;
}) {
  const posted: { path: string; body: unknown }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (init?.method === "POST") {
      const body = JSON.parse(
        typeof init.body === "string" ? init.body : "null",
      ) as unknown;
      posted.push({ path: url.pathname, body });
      if (url.pathname === "/relay/site/payload") answers.onPayload?.(body);
      return Promise.resolve(Response.json({ ok: true }));
    }
    if (url.pathname === "/relay/site/pending") {
      return Promise.resolve(Response.json({ jobs: answers.pending ?? [] }));
    }
    return Promise.resolve(Response.json({ jobs: answers.results ?? [] }));
  };
  return { fetchImpl, posted };
}

function appWith(fetchImpl: typeof fetch) {
  const siteKeys = generateSiteKeys();
  const store = new MemoryStore();
  const app = new ByollmApp({
    store,
    siteKeys,
    lane: {
      relayOrigin: "http://relay.test",
      siteId: "site_1",
      fetch: fetchImpl,
    },
  });
  return { app, store, siteKeys };
}

describe("publishing a stub", () => {
  it("sends the enumerated metadata and no payload", async () => {
    const relay = fakeRelay({});
    const { app } = appWith(relay.fetchImpl);

    await app.enqueue({
      kind: "llm.generate",
      owner: "alice",
      payload: { prompt: "a secret" },
    });

    const enqueued = relay.posted.find((p) => p.path === "/relay/site/enqueue");
    expect(enqueued).toBeDefined();
    expect(JSON.stringify(enqueued)).not.toContain("a secret");
    const stub = (enqueued?.body as { stub: Record<string, unknown> }).stub;
    // Read positively: a field added to the stub later has to pass this on
    // purpose, rather than riding along because nothing looked.
    expect(Object.keys(stub).sort()).toEqual([
      "audience",
      "deadlineAt",
      "id",
      "kind",
      "owner",
      "site",
      "sizeClass",
      "streaming",
    ]);
  });
});

describe("what the site refuses to believe", () => {
  const deviceKeys = generateKeys(1_800_000_000_000);
  const device: PublicIdentity = publicIdentityOf(deviceKeys);

  /** A result genuinely sealed by `deviceKeys`, for whatever job we name. */
  async function sealedResult(input: {
    jobId: string;
    siteIdentity: PublicIdentity;
    siteEncryption: string;
    outcome: unknown;
  }): Promise<SealedEnvelope> {
    return seal({
      plaintext: JSON.stringify(input.outcome),
      senderKeys: deviceKeys,
      recipientEncryptionPublic: input.siteEncryption,
      context: {
        jobId: input.jobId,
        senderKeyId: keyId(device.identity),
        recipientKeyId: keyId(input.siteIdentity.identity),
        deadlineAt: Date.now() + ENVELOPE_MAX_AGE_MS,
        direction: "result",
      },
    });
  }

  it("refuses a disposition the sealed outcome contradicts", async () => {
    // The relay acted on the clear-text hint, which is its job. The site is
    // the only party that can check it, which is why this check lives here
    // and not there (byollm_009 §6.1).
    const relay = fakeRelay({});
    const { app, siteKeys, store } = appWith(relay.fetchImpl);
    const handle = await app.enqueue({
      kind: "llm.generate",
      owner: "alice",
      payload: { prompt: "hi" },
    });

    const envelope = await sealedResult({
      jobId: handle.id,
      siteIdentity: publicIdentityOf(siteKeys),
      siteEncryption: siteKeys.encryptionPublic,
      outcome: {
        outcome: "error",
        code: "backend-error",
        message: "it failed",
        retryable: false,
      },
    });

    const lying = fakeRelay({
      results: [
        {
          jobId: handle.id,
          envelope,
          disposition: "ok",
          runnerId: "runner_1",
          device,
        },
      ],
    });
    const relayed = new ByollmApp({
      store,
      siteKeys,
      lane: {
        relayOrigin: "http://relay.test",
        siteId: "site_1",
        fetch: lying.fetchImpl,
      },
    });
    const report = await relayed.cloud!.pump();
    expect(report.completed).toEqual([]);
    expect(report.refused).toContain(handle.id);
  });

  it("refuses a result attributed to a device that did not sign it", async () => {
    const relay = fakeRelay({});
    const { app, siteKeys, store } = appWith(relay.fetchImpl);
    const handle = await app.enqueue({
      kind: "llm.generate",
      owner: "alice",
      payload: { prompt: "hi" },
    });

    const envelope = await sealedResult({
      jobId: handle.id,
      siteIdentity: publicIdentityOf(siteKeys),
      siteEncryption: siteKeys.encryptionPublic,
      outcome: { outcome: "ok", text: "done" },
    });

    // Same sealed bytes, a different device named. This is the relay lying
    // about provenance, and it is the check that keeps RELAY_BLIND from
    // quietly becoming RELAY_TRUSTED.
    const impostor = publicIdentityOf(generateKeys(1_800_000_000_000));
    const lying = fakeRelay({
      results: [
        {
          jobId: handle.id,
          envelope,
          disposition: "ok",
          runnerId: "runner_1",
          device: impostor,
        },
      ],
    });
    const relayed = new ByollmApp({
      store,
      siteKeys,
      lane: {
        relayOrigin: "http://relay.test",
        siteId: "site_1",
        fetch: lying.fetchImpl,
      },
    });
    const report = await relayed.cloud!.pump();
    expect(report.completed).toEqual([]);
  });

  it("refuses to seal for a job whose at-rest envelope it cannot open", async () => {
    // Rotated keys, a restored backup, someone else's row. The device is left
    // waiting, which is exactly what `awaiting-payload` exists to bound — and
    // the refusal is reported rather than swallowed, because a site that
    // cannot open its own work has a problem someone must see.
    const relay = fakeRelay({});
    const { app, store } = appWith(relay.fetchImpl);
    const handle = await app.enqueue({
      kind: "llm.generate",
      owner: "alice",
      payload: { prompt: "hi" },
    });

    const stranger = generateSiteKeys();

    const pending = fakeRelay({
      pending: [
        {
          jobId: handle.id,
          device,
          runnerId: "runner_1",
          leaseId: "lease_1",
          awaitingUntil: Date.now() + 10_000,
        },
      ],
    });
    // A site holding different keys than the ones that sealed the row.
    const wrongKeys = new ByollmApp({
      store,
      siteKeys: stranger,
      lane: {
        relayOrigin: "http://relay.test",
        siteId: "site_1",
        fetch: pending.fetchImpl,
      },
    });
    const report = await wrongKeys.cloud!.pump();
    expect(report.sealed).toEqual([]);
    expect(report.refused).toContain(handle.id);
    // And nothing was handed over.
    expect(pending.posted.some((p) => p.path === "/relay/site/payload")).toBe(
      false,
    );
  });
});

describe("a relay that says ask me later — alpha.31", () => {
  /**
   * Every deploy drains, and a draining pod answers `503 not-ready` to every
   * routed call for the length of its `preStop` window. That is the drain
   * design working: readiness goes false, the pod keeps serving, and callers
   * are told to come back rather than meeting a closed socket.
   *
   * This lane read the body of that answer, found no `jobs` in it, and threw
   * `TypeError: finished.jobs is not iterable` — a site falling over because
   * its relay was polite. Found by `roll.sh`'s own wire proof, on the deploy
   * that introduced nothing to do with it.
   *
   * The bug's shape is "a response body used without checking the status", so
   * the cases below present the refusal on **each endpoint in turn**: fixing
   * the one loop that crashed would have left the same crash two calls away.
   */

  /** A relay that refuses one endpoint and answers the rest normally. */
  function refusing(endpoint: string, status: number, error: string) {
    const bodies: Record<string, unknown> = {
      pending: { jobs: [] },
      results: { jobs: [] },
      enqueue: { accepted: true },
      payload: { accepted: true },
      cancel: { cancelled: true },
    };
    const impl: typeof fetch = (input) => {
      const url = String(input instanceof Request ? input.url : input);
      const called = url.split("?")[0]!.split("/").pop()!;
      if (called === endpoint) {
        return Promise.resolve(
          new Response(JSON.stringify({ error, message: "later" }), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(bodies[called] ?? {}), {
          headers: { "content-type": "application/json" },
        }),
      );
    };
    return impl;
  }

  for (const endpoint of ["pending", "results"]) {
    it(`defers rather than crashing when ${endpoint} is draining`, async () => {
      const { app } = appWith(refusing(endpoint, 503, "not-ready"));
      const report = await app.cloud!.pump();
      // Not a throw, and not silence either: the reason is on the report, so
      // a site that did nothing and a site that was told to wait do not look
      // the same in a log.
      expect(report.deferred).toContain(endpoint);
      expect(report.sealed).toEqual([]);
    });
  }

  it("comes back on the next cycle, once the pod has gone", async () => {
    // The half that makes deferring correct rather than merely quiet: the
    // work is still there, and the next pump finds it.
    let draining = true;
    const impl: typeof fetch = () => {
      if (draining) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: "not-ready", message: "later" }),
            {
              status: 503,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ jobs: [], accepted: true }), {
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const { app } = appWith(impl);

    expect((await app.cloud!.pump()).deferred).toBeDefined();
    draining = false;
    const after = await app.cloud!.pump();
    expect(after.deferred).toBeUndefined();
  });

  it("does not defer a refusal that will still be true tomorrow", async () => {
    // A bad signature, an unknown site, a version this relay does not speak.
    // Swallowing these would leave a site silently disconnected from its own
    // users with nothing in any log to say so — the opposite failure, and the
    // more expensive one.
    for (const [status, error] of [
      [401, "unauthorized"],
      [403, "forbidden"],
      [400, "unsupported-protocol-version"],
    ] as const) {
      const { app } = appWith(refusing("pending", status, error));
      await expect(app.cloud!.pump()).rejects.toThrow(/pending/);
    }
  });
});

/**
 * Who may serve a job is the person's decision, and the site is not told it.
 *
 * A cloud-lane site cannot compute an audience: the person's mapping names a
 * service and its owner, that owner's offer scope says who it serves, and the
 * hub holds both at claim. The site holds none of it — the disclosure fence
 * exists so it never does.
 *
 * Asking it to declare one anyway is how the default came to disable team
 * sharing in silence. `private` means own devices only, so a site that simply
 * never mentioned the field broke sharing for every user with a team, while
 * working perfectly for everyone testing alone. **A declaration required from
 * the party that cannot know is a default in disguise.**
 */
describe("audience on the cloud lane", () => {
  it("refuses a site that declares one", async () => {
    const relay = fakeRelay({});
    const { app } = appWith(relay.fetchImpl);

    await expect(
      app.enqueue({
        kind: "llm.generate",
        owner: "someone",
        payload: { prompt: "hello" },
        /* Typechecks, and must: the lane is a runtime fact, so the type
           cannot refuse this and the method has to. That asymmetry is the
           whole reason the refusal exists at all. */
        audience: "team",
      }),
    ).rejects.toThrow(/does not take `audience` on the cloud lane/);
  });

  /* Refusing the declaration is only half of it. The stub still carries an
     audience to the relay, and a store defaulting it to `private` would keep
     every cloud job private no matter who was forbidden from saying so. */
  it("derives one that defers to the person's own mapping", async () => {
    const relay = fakeRelay({});
    const { app, store } = appWith(relay.fetchImpl);

    const job = await app.enqueue({
      kind: "llm.generate",
      owner: "someone",
      payload: { prompt: "hello" },
    });

    const stored = await store.get(job.id);
    expect(
      stored?.audience,
      "a private job can only run on the requester's own devices, so a " +
        "teammate's mapping could never be honoured",
    ).toBe("team");
  });

  /**
   * And it does not answer a question it cannot see.
   *
   * `runnerAvailability` counts runners in this site's own store. On the
   * cloud lane devices pair with the relay, nothing writes a runner here, and
   * the truthful answer is "unknown" rather than "none" — it reported
   * `no-runner-paired, candidates: 0` to every cloud app that asked, and a
   * teammate on a shared device was told to install software she did not need.
   */
  it("refuses to report availability it cannot see", async () => {
    const relay = fakeRelay({});
    const { app } = appWith(relay.fetchImpl);

    await expect(
      app.runnerAvailability({ owner: "someone", kind: "llm.generate" }),
    ).rejects.toThrow(/cannot answer on the cloud lane/);
  });
});

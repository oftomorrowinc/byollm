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
      audience: "self",
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
      audience: "self",
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
      audience: "self",
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
      audience: "self",
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

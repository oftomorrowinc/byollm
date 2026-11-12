import { cryptoReady } from "@byollm/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { CloudLane, RelayUnavailable } from "./cloud.js";
import { generateSiteKeys } from "./keys.js";
import { MemoryStore } from "./memory.js";

/**
 * The cloud lane's blob calls when the relay or the store says no
 * (byollm_021 §2, #7875).
 *
 * The round trip against a real relay is `packages/relay/test/blobs-sdk.test.ts`.
 * What a real relay will not do is answer with the wrong shape, and a real
 * memory store does not go down, so those answers are made here. Each case
 * asks the same two things: is it refused, and is the refusal one a site
 * should retry (the store is down) or not (the answer will not change)?
 */

beforeAll(async () => {
  await cryptoReady();
});

const NOW = 1_800_000_000_000;

/** A lane whose relay and store answer `/relay/<path>` and `https://store.test/…` as told. */
function lane(answer: (url: URL, init?: RequestInit) => Response) {
  const asked: string[] = [];
  const cloud = new CloudLane({
    options: {
      relayOrigin: "https://relay.test",
      siteId: "site_1",
      fetch: (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        asked.push(`${init?.method ?? "GET"} ${url.pathname}`);
        return Promise.resolve(answer(url, init));
      },
    },
    store: new MemoryStore(),
    siteKeys: generateSiteKeys(),
    now: () => NOW,
  });
  return { cloud, asked };
}

const slot = {
  blob: "b_1",
  url: "https://store.test/put/b_1",
  expiresAt: NOW + 60_000,
};

async function refusal(promise: Promise<unknown>): Promise<RelayUnavailable> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RelayUnavailable);
  return error as RelayUnavailable;
}

describe("the cloud lane's blob calls, refused", () => {
  it("does not take an answer without a blob id, a URL and an expiry as an upload slot", async () => {
    for (const answer of [
      {},
      { ...slot, blob: 7 },
      { ...slot, url: undefined },
      { ...slot, expiresAt: String(slot.expiresAt) },
    ]) {
      const { cloud } = lane(() => Response.json(answer));
      const error = await refusal(cloud.blobSlot("job_1", 262_184));
      expect(error.code).toBe("bad-response");
      expect(error.retryable).toBe(false);
    }
  });

  it("says whether a store's refused upload is worth retrying, and never PUTs twice under one slot", async () => {
    for (const [status, retryable] of [
      [503, true],
      [429, true],
      [403, false],
    ] as const) {
      const { cloud, asked } = lane((url) =>
        url.pathname === "/relay/blobs"
          ? Response.json(slot)
          : new Response("no", { status }),
      );
      const { blob } = await cloud.blobSlot("job_1", 262_184);
      const error = await refusal(cloud.uploadBlob(blob, new Uint8Array(8)));
      expect(error.code).toBe("blob-upload");
      expect(error.message).toContain(`HTTP ${String(status)}`);
      expect(error.retryable).toBe(retryable);
      // The slot was spent by the attempt: a second PUT needs a new slot.
      expect(
        (await refusal(cloud.uploadBlob(blob, new Uint8Array(8)))).code,
      ).toBe("no-slot");
      expect(asked).toEqual(["POST /relay/blobs", "PUT /put/b_1"]);
    }
  });

  it("does not take an answer without a URL as a download URL, and fetches nothing", async () => {
    const { cloud, asked } = lane(() => Response.json({ url: 7 }));
    const error = await refusal(cloud.downloadBlob("job_1", "b_1", 262_184));
    expect(error.code).toBe("bad-response");
    expect(error.retryable).toBe(false);
    expect(asked).toEqual(["POST /relay/blobs/download"]);
  });

  it("says whether a store's refused download is worth retrying", async () => {
    for (const [status, retryable] of [
      [500, true],
      [429, true],
      [404, false],
    ] as const) {
      const { cloud } = lane((url) =>
        url.pathname === "/relay/blobs/download"
          ? Response.json({ url: "https://store.test/get/b_1" })
          : new Response("gone", { status }),
      );
      const error = await refusal(cloud.downloadBlob("job_1", "b_1", 262_184));
      expect(error.code).toBe("blob-download");
      expect(error.message).toContain(`HTTP ${String(status)}`);
      expect(error.retryable).toBe(retryable);
    }
  });

  it("does not read a relay that is down as one that carries images", async () => {
    // Only a 404 answers the question. A 503 is no answer, and an llm.image
    // job asked about it must not be published on the strength of it.
    const { cloud } = lane(() =>
      Response.json({ error: "server-error" }, { status: 503 }),
    );
    const error = await refusal(cloud.carriesImages("job_1"));
    expect(error.retryable).toBe(true);
    expect(error.code).toBe("server-error");
  });
});

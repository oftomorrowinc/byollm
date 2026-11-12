import { describe, expect, it } from "vitest";
import { MAX_BLOB_OBJECT_BYTES, blobObjectBytes } from "./blob.js";
import { MAX_IMAGES_OUT } from "./media.js";
import {
  BlobSlotResponse,
  PROTOCOL_VERSION,
  SiteBlobDownloadRequest,
  SiteBlobDownloadResponse,
  SiteBlobSlotRequest,
  SiteBlobSlotResponse,
  SiteBlobsReceivedRequest,
  SiteBlobsReceivedResponse,
} from "./wire.js";

/**
 * The site plane's three blob shapes — byollm_021 §2, #7875.
 *
 * Each is held to exactly its keys, in both directions. The slot's answer in
 * particular: #7875's choice B is that the job rides in the object name the
 * upstream chooses, so there is no header list for an uploader to copy, and a
 * `headers` key appearing on either slot answer is that choice being undone.
 */

const slotRequest = {
  protocolVersion: PROTOCOL_VERSION,
  siteId: "site_demo",
  jobId: "job-1",
  direction: "in",
  bytes: blobObjectBytes(1),
};
const slotResponse = {
  blob: "AAAAAAAAAAAAAAAAAAAAAA1",
  url: "https://blobs.example/put",
  expiresAt: 1_800_000_000_000,
};
const downloadRequest = {
  protocolVersion: PROTOCOL_VERSION,
  siteId: "site_demo",
  jobId: "job-1",
  blob: "AAAAAAAAAAAAAAAAAAAAAA1",
};
const downloadResponse = {
  url: "https://blobs.example/get",
  expiresAt: 1_800_000_000_000,
};
const receivedRequest = {
  protocolVersion: PROTOCOL_VERSION,
  siteId: "site_demo",
  jobId: "job-1",
  blobs: ["AAAAAAAAAAAAAAAAAAAAAA1"],
};

describe("the site's blob shapes", () => {
  it("accepts each shape as written", () => {
    expect(SiteBlobSlotRequest.safeParse(slotRequest).success).toBe(true);
    expect(SiteBlobSlotResponse.safeParse(slotResponse).success).toBe(true);
    expect(SiteBlobDownloadRequest.safeParse(downloadRequest).success).toBe(
      true,
    );
    expect(SiteBlobDownloadResponse.safeParse(downloadResponse).success).toBe(
      true,
    );
    expect(SiteBlobsReceivedRequest.safeParse(receivedRequest).success).toBe(
      true,
    );
    expect(
      SiteBlobsReceivedResponse.safeParse({ jobId: "job-1" }).success,
    ).toBe(true);
  });

  it("refuses an unknown key on every one of them", () => {
    const cases: [
      { safeParse: (v: unknown) => { success: boolean } },
      object,
    ][] = [
      [SiteBlobSlotRequest, slotRequest],
      [SiteBlobSlotResponse, slotResponse],
      [SiteBlobDownloadRequest, downloadRequest],
      [SiteBlobDownloadResponse, downloadResponse],
      [SiteBlobsReceivedRequest, receivedRequest],
      [SiteBlobsReceivedResponse, { jobId: "job-1" }],
    ];
    for (const [schema, value] of cases) {
      expect(schema.safeParse({ ...value, extra: 1 }).success).toBe(false);
    }
  });

  it("gives neither slot answer a headers key — the job rides in the object name", () => {
    const headers = { "x-goog-meta-byollm-job": "job-1" };
    expect(
      SiteBlobSlotResponse.safeParse({ ...slotResponse, headers }).success,
    ).toBe(false);
    expect(
      BlobSlotResponse.safeParse({ ...slotResponse, headers }).success,
    ).toBe(false);
    expect(Object.keys(BlobSlotResponse.shape).sort()).toEqual([
      "blob",
      "expiresAt",
      "url",
    ]);
    expect(Object.keys(SiteBlobSlotResponse.shape).sort()).toEqual([
      "blob",
      "expiresAt",
      "url",
    ]);
  });

  it("issues a site slot for an input only", () => {
    expect(
      SiteBlobSlotRequest.safeParse({ ...slotRequest, direction: "out" })
        .success,
    ).toBe(false);
    const { direction: _direction, ...undirected } = slotRequest;
    expect(SiteBlobSlotRequest.safeParse(undirected).success).toBe(false);
  });

  it("bounds a slot at one image at the cap", () => {
    expect(
      SiteBlobSlotRequest.safeParse({
        ...slotRequest,
        bytes: MAX_BLOB_OBJECT_BYTES,
      }).success,
    ).toBe(true);
    expect(
      SiteBlobSlotRequest.safeParse({
        ...slotRequest,
        bytes: MAX_BLOB_OBJECT_BYTES + 1,
      }).success,
    ).toBe(false);
    expect(
      SiteBlobSlotRequest.safeParse({ ...slotRequest, bytes: 0 }).success,
    ).toBe(false);
  });

  it("refuses a blob id that could be a path", () => {
    for (const blob of ["../x", "a/b", "a.b", ""]) {
      expect(
        SiteBlobDownloadRequest.safeParse({ ...downloadRequest, blob }).success,
      ).toBe(false);
      expect(
        SiteBlobsReceivedRequest.safeParse({
          ...receivedRequest,
          blobs: [blob],
        }).success,
      ).toBe(false);
    }
  });

  it("takes one to four blobs in received — an llm.image job's outputs", () => {
    expect(
      SiteBlobsReceivedRequest.safeParse({ ...receivedRequest, blobs: [] })
        .success,
    ).toBe(false);
    const blobs = Array.from(
      { length: MAX_IMAGES_OUT + 1 },
      (_, n) => `blob${String(n)}`,
    );
    expect(
      SiteBlobsReceivedRequest.safeParse({ ...receivedRequest, blobs }).success,
    ).toBe(false);
    expect(
      SiteBlobsReceivedRequest.safeParse({
        ...receivedRequest,
        blobs: blobs.slice(0, MAX_IMAGES_OUT),
      }).success,
    ).toBe(true);
  });

  it("requires the protocol version on every request", () => {
    for (const [schema, value] of [
      [SiteBlobSlotRequest, slotRequest],
      [SiteBlobDownloadRequest, downloadRequest],
      [SiteBlobsReceivedRequest, receivedRequest],
    ] as const) {
      expect(schema.safeParse({ ...value, protocolVersion: "1" }).success).toBe(
        false,
      );
    }
  });
});

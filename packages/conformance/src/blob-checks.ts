import { randomUUID } from "node:crypto";
import {
  BlobRef,
  blobObjectBytes,
  decryptBlob,
  encryptBlob,
  sniffImage,
} from "@byollm/protocol";
import type { Check } from "./checks.js";
import {
  advance,
  claimImageJob,
  claimRaw,
  contains,
  downloadInput,
  fetchPayload,
  imageCapabilities,
  pairDaemon,
  postResult,
  releaseLease,
  signedPost,
  testPng,
  uploadOutput,
  type HarnessDaemon,
} from "./harness.js";
import type { ConformanceTarget } from "./target.js";

/**
 * Images by reference — byollm_021 §2, §10 (#6933 card 5, #7057).
 *
 * Every check here plays the device's half of the protocol over the raw
 * wire, because no shipped daemon serves `llm.vision` or `llm.image` until
 * card 6 — and because what these certify is the server's half: the store,
 * the lease scope, the size check and the deletion order. The site's half is
 * the server's own SDK, driven through {@link ConformanceTarget.blobs}.
 *
 * Numbered as byollm_021 §10 numbers them (C048–C060, renumbered by #7053).
 */

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** The first image reference in an opened `llm.vision` payload. */
function firstImage(opened: unknown): BlobRef {
  const payload = opened as {
    messages: { content: string | { type: string; image?: unknown }[] }[];
  };
  for (const message of payload.messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "image") return BlobRef.parse(part.image);
    }
  }
  throw new Error("the payload carried no image reference");
}

/**
 * Enqueue a vision job, have `daemon` claim it and open its payload: the
 * job, its lease and its first image's reference — key and all, which only
 * a device holding the lease can read.
 */
async function takeVisionJob(
  target: ConformanceTarget,
  daemon: HarnessDaemon,
  image: Uint8Array,
): Promise<{ jobId: string; leaseId: string; ref: BlobRef }> {
  const { id } = await target.blobs.enqueueVision({
    owner: "alice",
    text: "what is in this picture?",
    images: [image],
  });
  const stub = await claimImageJob(target, daemon, id);
  const fetched = await fetchPayload(target, daemon, id, stub.lease.id);
  assert(fetched?.opened != null, "the device could not open its payload");
  return { jobId: id, leaseId: stub.lease.id, ref: firstImage(fetched.opened) };
}

/** Enqueue an `llm.image` job and have `daemon` answer it with `image`. */
async function answerImageJob(
  target: ConformanceTarget,
  daemon: HarnessDaemon,
  image: Uint8Array,
): Promise<{ jobId: string; ref: BlobRef }> {
  const { id } = await target.enqueue({
    kind: "llm.image",
    payload: { prompt: "a red square" },
    owner: "alice",
  });
  const stub = await claimImageJob(target, daemon, id);
  const ref = await uploadOutput(target, daemon, {
    jobId: id,
    leaseId: stub.lease.id,
    image,
  });
  const posted = await postResult(target, daemon, {
    jobId: id,
    leaseId: stub.lease.id,
    outcome: { outcome: "ok", text: "", images: [ref] },
  });
  const body = (await posted.json()) as { accepted?: boolean };
  assert(
    posted.status === 200 && body.accepted === true,
    `an honest llm.image result was not accepted (${String(posted.status)})`,
  );
  return { jobId: id, ref };
}

/** The blobs the target holds for one job. */
async function blobsOf(target: ConformanceTarget, jobId: string) {
  return (await target.blobs.stored()).filter((blob) => blob.jobId === jobId);
}

async function withDaemon(
  target: ConformanceTarget,
  run: (daemon: HarnessDaemon) => Promise<void>,
): Promise<void> {
  const daemon = await pairDaemon(target, { owner: "alice", offer: "private" });
  try {
    await run(daemon);
  } finally {
    await daemon.dispose();
  }
}

export const BLOB_CHECKS: readonly Check[] = [
  {
    id: "C048_BLOBS_SEALED",
    title:
      "the store holds no image bytes and no key that opens one, inputs or outputs",
    musts: ["BLOBS_SEALED"],
    async run(target: ConformanceTarget): Promise<void> {
      await withDaemon(target, async (daemon) => {
        const input = testPng(4, 4, 8192);
        const { jobId, leaseId, ref } = await takeVisionJob(
          target,
          daemon,
          input,
        );

        const output = testPng(4, 4, 8192);
        const answered = await answerImageJob(target, daemon, output);

        const stored = await target.blobs.stored();
        const records = await target.blobs.records();
        assert(
          stored.length >= 2,
          "the store holds fewer blobs than were sent",
        );
        // A window from the middle of each image's random pixel chunk: found
        // anywhere, it could only have come from the plaintext.
        const windows = [input, output].map((image) =>
          image.subarray(image.length - 2048, image.length - 1024),
        );
        const keys = [ref.key, answered.ref.key];
        for (const blob of stored) {
          if (blob.data === null) continue;
          for (const window of windows) {
            assert(
              !contains(blob.data, window),
              `blob ${blob.id} holds plaintext image bytes`,
            );
          }
          for (const key of keys) {
            assert(
              !contains(blob.data, Buffer.from(key, "base64url")) &&
                !contains(blob.data, Buffer.from(key)),
              `blob ${blob.id} holds a blob key`,
            );
          }
        }
        for (const key of keys) {
          assert(
            !records.includes(key),
            "the store's job records hold a blob key in the clear",
          );
        }
        for (const window of windows) {
          assert(
            !records.includes(Buffer.from(window).toString("base64")) &&
              !records.includes(Buffer.from(window).toString("base64url")),
            "the store's job records hold image bytes",
          );
        }

        // The controls, after the search so that a store holding plaintext is
        // reported as that: the device holding the lease can open what is
        // stored, so "nothing readable" above is about the store and not a
        // broken blob.
        const got = await downloadInput(target, daemon, {
          jobId,
          leaseId,
          blob: ref.blob,
        });
        assert(
          got.object !== undefined,
          "the device could not download its input",
        );
        const opened = await decryptBlob({
          object: got.object,
          ref,
          jobId,
          direction: "in",
        });
        assert(opened.ok, "the device could not open its input");
        assert(
          !contains(opened.bytes, Buffer.from("GPS 51.5007N")),
          "the site uploaded the image with its location still in it",
        );

        // The other control: the site can still open what it keeps, so the
        // key it does not store in the clear is one it can recover.
        const images = await target.blobs.images(answered.jobId);
        assert(
          images.length === 1 &&
            Buffer.from(images[0]?.bytes ?? []).equals(Buffer.from(output)),
          "the site could not open the output it collected",
        );
      });
    },
  },

  {
    id: "C053_BLOB_NEEDS_THE_LEASE",
    title:
      "a blob URL is issued only for a lease the caller holds, and dies with it",
    musts: ["LEASE_SCOPED_BY_GRANT"],
    async run(target: ConformanceTarget): Promise<void> {
      await withDaemon(target, async (alice) => {
        const { jobId, leaseId, ref } = await takeVisionJob(
          target,
          alice,
          testPng(),
        );
        const bob = await pairDaemon(target, {
          owner: "bob",
          offer: "private",
        });
        try {
          const stranger = await downloadInput(target, bob, {
            jobId,
            leaseId,
            blob: ref.blob,
          });
          assert(
            stranger.status !== 200 && stranger.url === undefined,
            "a device that holds no lease on the job was issued a blob URL",
          );
        } finally {
          await bob.dispose();
        }
        const wrongLease = await downloadInput(target, alice, {
          jobId,
          leaseId: `${leaseId}-not`,
          blob: ref.blob,
        });
        assert(
          wrongLease.url === undefined,
          "a blob URL was issued for a lease the job does not have",
        );

        const held = await downloadInput(target, alice, {
          jobId,
          leaseId,
          blob: ref.blob,
        });
        assert(
          held.status === 200 &&
            held.object !== undefined &&
            held.url !== undefined,
          "the device holding the lease was refused its blob",
        );

        // Release, then try both the old lease and the URL minted under it.
        const released = await releaseLease(target, alice, jobId, leaseId);
        assert(released.status === 200, "the lease could not be released");
        const afterRelease = await downloadInput(target, alice, {
          jobId,
          leaseId,
          blob: ref.blob,
        });
        assert(
          afterRelease.url === undefined,
          "a released lease was still issued a blob URL",
        );
        const stale = await target.fetch(
          new Request(held.url, { method: "GET" }),
        );
        assert(
          stale.status !== 200,
          "a blob URL kept working after the lease it was issued under ended",
        );

        // An output slot is lease-scoped the same way.
        const slot = await signedPost(target, alice, "blob-slot", {
          jobId,
          leaseId,
          bytes: blobObjectBytes(1),
        });
        assert(
          slot.status !== 200,
          "an output slot was issued without a lease",
        );
      });
    },
  },

  {
    id: "C054_BLOBS_GO_WITH_THE_JOB",
    title:
      "inputs go when the result is accepted, outputs on received, and an uncollected job's a day after its deadline",
    musts: ["BLOBS_GO_WITH_THE_JOB"],
    async run(target: ConformanceTarget): Promise<void> {
      await withDaemon(target, async (daemon) => {
        // Inputs: present until the result is accepted, gone at acceptance.
        const vision = await takeVisionJob(target, daemon, testPng());
        assert(
          (await blobsOf(target, vision.jobId)).length === 1,
          "the input blob was not stored",
        );
        const posted = await postResult(target, daemon, {
          jobId: vision.jobId,
          leaseId: vision.leaseId,
          outcome: { outcome: "ok", text: "a picture" },
        });
        assert(posted.status === 200, "the vision result was refused");
        assert(
          (await blobsOf(target, vision.jobId)).length === 0,
          "an input blob outlived the accepted result",
        );

        // Outputs: gone once the site has them and says so.
        const image = await answerImageJob(target, daemon, testPng());
        await target.blobs.collect(image.jobId);
        await target.blobs.images(image.jobId);
        assert(
          (await blobsOf(target, image.jobId)).length === 0,
          "an output blob outlived the site's received",
        );

        // Never collected: due a day after the deadline, and swept then.
        const { id } = await target.blobs.enqueueVision({
          owner: "alice",
          text: "nobody will run this",
          images: [testPng()],
        });
        const waiting = await blobsOf(target, id);
        assert(
          waiting.length === 1,
          "the uncollected job's blob was not stored",
        );
        for (const blob of waiting) {
          assert(
            blob.deleteAt - blob.createdAt <= target.ttlMs + DAY + 5_000,
            "an uncollected job's blob is kept past its deadline plus a day",
          );
        }
        if (target.advanceTime) {
          await advance(target, target.ttlMs + DAY + 1_000);
          assert(
            (await blobsOf(target, id)).length === 0,
            "an uncollected job's blob survived the sweep a day after its deadline",
          );
        }
      });
    },
  },

  {
    id: "C057_BLOB_SIZE_CHECKED_BEFORE_OFFER",
    title:
      "a stored blob that is not its slot's size is refused before its job is offered or its result accepted",
    musts: ["BLOB_BUDGET_BEFORE_DOWNLOAD"],
    async run(target: ConformanceTarget): Promise<void> {
      await withDaemon(target, async (daemon) => {
        // A 256 KiB slot, and 512 KiB stored under it: the ciphertext of a
        // ~300 KB image, whose object is two buckets.
        const image = testPng(8, 8, 300_000);
        const sniffed = sniffImage(image);
        assert(sniffed !== null, "the test image did not sniff");
        const jobId = randomUUID();
        const { blob } = await target.blobs.slot({
          jobId,
          bytes: blobObjectBytes(256 * 1024),
        });
        const sealed = await encryptBlob({
          plaintext: image,
          jobId,
          blobId: blob,
          direction: "in",
        });
        assert(
          sealed.object.length === blobObjectBytes(image.length) &&
            sealed.object.length > blobObjectBytes(256 * 1024),
          "the oversized object is not oversized",
        );
        await target.blobs.upload(blob, sealed.object);
        // The reference declares what the slot was issued for — 200 KB, one
        // bucket — so the only thing wrong is what was stored. A server that
        // checks the slot against the reference and trusts the slot passes
        // this job; only reading the stored size refuses it.
        const ref = {
          blob,
          mediaType: sniffed.mediaType,
          bytes: 200_000,
          width: sniffed.width,
          height: sniffed.height,
          sha256: sealed.sha256,
          key: sealed.key,
        };
        let refused = false;
        try {
          await target.enqueue({
            id: jobId,
            kind: "llm.vision",
            owner: "alice",
            payload: {
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: "describe" },
                    { type: "image", image: ref },
                  ],
                },
              ],
            },
          });
        } catch {
          refused = true;
        }
        assert(refused, "a job whose blob overran its slot was enqueued");
        const offered = await claimRaw(
          target,
          daemon,
          await imageCapabilities(daemon),
        );
        assert(
          !offered.some((job) => job.id === jobId),
          "a job whose blob overran its slot was offered",
        );
        assert(
          (await target.job(jobId)) === null,
          "a refused job was stored anyway",
        );

        // Outputs: a slot is filled with at most its size, and a result whose
        // output was never stored is not accepted.
        const { id } = await target.enqueue({
          kind: "llm.image",
          payload: { prompt: "a red square" },
          owner: "alice",
        });
        const stub = await claimImageJob(target, daemon, id);
        const slot = await signedPost(target, daemon, "blob-slot", {
          jobId: id,
          leaseId: stub.lease.id,
          bytes: blobObjectBytes(256 * 1024),
        });
        assert(slot.status === 200, "the device was refused an output slot");
        const { blob: outBlob, url } = (await slot.json()) as {
          blob: string;
          url: string;
        };
        const over = await target.fetch(
          new Request(url, { method: "PUT", body: sealed.object }),
        );
        assert(over.status !== 204, "an output slot took more than its size");
        const posted = await postResult(target, daemon, {
          jobId: id,
          leaseId: stub.lease.id,
          outcome: {
            outcome: "ok",
            text: "",
            images: [{ ...ref, blob: outBlob }],
          },
        });
        const body = (await posted.json()) as { accepted?: boolean };
        assert(
          body.accepted !== true,
          "a result whose output blob is not its slot's size was accepted",
        );
      });
    },
  },

  {
    id: "C059_OUTPUT_OUTLIVES_COLLECTION",
    title:
      "an output blob survives collection until the site says it holds it, or an hour",
    musts: ["BLOBS_GO_WITH_THE_JOB"],
    async run(target: ConformanceTarget): Promise<void> {
      await withDaemon(target, async (daemon) => {
        const output = testPng();
        const { jobId } = await answerImageJob(target, daemon, output);
        const collected = await target.blobs.collect(jobId);
        assert(collected.state === "ok", "the result could not be collected");
        await advance(target, 30_000);

        const later = await target.blobs.images(jobId, { received: false });
        assert(
          later.length === 1 &&
            Buffer.from(later[0]?.bytes ?? []).equals(Buffer.from(output)),
          "the site could not download its output 30 s after collecting it",
        );
        const kept = await blobsOf(target, jobId);
        assert(kept.length === 1, "the output blob went before received");
        for (const blob of kept) {
          // The slot was issued moments before collection, so its deletion
          // time, measured from the slot, is collection plus the hour.
          assert(
            blob.deleteAt - blob.createdAt <= HOUR + 60_000,
            "an output blob is kept more than an hour after collection",
          );
        }
        if (target.advanceTime) {
          await advance(target, HOUR);
          assert(
            (await blobsOf(target, jobId)).length === 0,
            "an output blob survived an hour past collection without received",
          );
        }
      });
    },
  },
];

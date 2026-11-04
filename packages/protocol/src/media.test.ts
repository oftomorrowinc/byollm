import { describe, expect, it } from "vitest";
import { EnvelopeDirection } from "./envelope.js";
import { SealedOutcome, SealedOutcomeFor, StopReasonSchema } from "./job.js";
import {
  ImagePayload,
  KindedPayload,
  VisionPayload,
  payloadTextLength,
  visionImages,
} from "./kinds.js";
import {
  BLOB_PADDING_BYTES,
  BlobRef,
  MAX_IMAGES_IN,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIDE,
  paddedBlobBytes,
} from "./media.js";

/**
 * Images by reference, and the results each new kind may carry —
 * byollm_021 §1–§4, byollm_012 §3.
 */

const ref = (over: Record<string, unknown> = {}) => ({
  blob: "blob_01",
  mediaType: "image/jpeg",
  bytes: 4_000_000,
  width: 4032,
  height: 3024,
  sha256: "0".repeat(64),
  key: "k".repeat(43),
  ...over,
});

describe("BlobRef — §2", () => {
  it("carries the seven fields and nothing else", () => {
    expect(BlobRef.safeParse(ref()).success).toBe(true);
    // No URL, no direction, no plaintext: the key opens the blob and the
    // direction is in its associated data, never beside it.
    for (const extra of [
      { url: "https://r2.example/blob_01" },
      { direction: "in" },
      { data: "iVBORw0KGgo" },
    ]) {
      expect(BlobRef.safeParse(ref(extra)).success).toBe(false);
    }
  });

  it("holds an image to 20 MiB, 8,192 a side and 40 megapixels", () => {
    expect(BlobRef.safeParse(ref({ bytes: MAX_IMAGE_BYTES })).success).toBe(
      true,
    );
    expect(BlobRef.safeParse(ref({ bytes: MAX_IMAGE_BYTES + 1 })).success).toBe(
      false,
    );
    expect(
      BlobRef.safeParse(ref({ width: MAX_IMAGE_SIDE + 1, height: 1 })).success,
    ).toBe(false);
    // 8,000 × 8,000 is inside each side and past the pixel cap: the bomb a
    // side limit alone would let through.
    expect(8000 * 8000).toBeGreaterThan(MAX_IMAGE_PIXELS);
    expect(BlobRef.safeParse(ref({ width: 8000, height: 8000 })).success).toBe(
      false,
    );
  });

  it("accepts PNG, JPEG and WebP, and refuses SVG, GIF, HEIC and AVIF", () => {
    for (const ok of ["image/png", "image/jpeg", "image/webp"]) {
      expect(BlobRef.safeParse(ref({ mediaType: ok })).success, ok).toBe(true);
    }
    for (const bad of [
      "image/svg+xml",
      "image/gif",
      "image/heic",
      "image/avif",
      "text/html",
    ]) {
      expect(BlobRef.safeParse(ref({ mediaType: bad })).success, bad).toBe(
        false,
      );
    }
  });

  it("refuses a key that is not 32 bytes and a hash that is not SHA-256", () => {
    expect(BlobRef.safeParse(ref({ key: "k".repeat(42) })).success).toBe(false);
    expect(BlobRef.safeParse(ref({ key: "k".repeat(44) })).success).toBe(false);
    expect(BlobRef.safeParse(ref({ sha256: "F".repeat(64) })).success).toBe(
      false,
    );
  });

  it("pads to a multiple of 256 KiB, so a store sees a bucket", () => {
    expect(BLOB_PADDING_BYTES).toBe(256 * 1024);
    expect(paddedBlobBytes(1)).toBe(BLOB_PADDING_BYTES);
    expect(paddedBlobBytes(BLOB_PADDING_BYTES)).toBe(BLOB_PADDING_BYTES);
    expect(paddedBlobBytes(BLOB_PADDING_BYTES + 1)).toBe(
      2 * BLOB_PADDING_BYTES,
    );
    expect(() => paddedBlobBytes(0)).toThrow();
  });
});

describe("the llm.vision payload — chat with image parts", () => {
  const vision = (content: unknown, role = "user") => ({
    messages: [{ role, content }],
  });
  const parts = (n: number) => [
    { type: "text", text: "What is in these?" },
    ...Array.from({ length: n }, (_, i) => ({
      type: "image",
      image: ref({ blob: `b${String(i)}` }),
    })),
  ];

  it("carries 1 to 8 images, in user turns", () => {
    expect(VisionPayload.safeParse(vision(parts(1))).success).toBe(true);
    expect(VisionPayload.safeParse(vision(parts(MAX_IMAGES_IN))).success).toBe(
      true,
    );
    expect(
      VisionPayload.safeParse(vision(parts(MAX_IMAGES_IN + 1))).success,
    ).toBe(false);
    // No image is a chat job, which every daemon already serves.
    expect(VisionPayload.safeParse(vision("just text")).success).toBe(false);
  });

  it("refuses an image in an assistant or system turn", () => {
    for (const role of ["assistant", "system"]) {
      expect(
        VisionPayload.safeParse(vision(parts(1), role)).success,
        role,
      ).toBe(false);
    }
  });

  it("refuses an image carried as bytes or as a URL", () => {
    for (const part of [
      { type: "image", data: "iVBORw0KGgo" },
      { type: "image_url", image_url: { url: "https://x.test/a.png" } },
    ]) {
      expect(VisionPayload.safeParse(vision([part])).success).toBe(false);
    }
  });

  it("measures its text and not its images", () => {
    const p = VisionPayload.parse({
      system: "Be brief.",
      messages: [
        { role: "user", content: parts(2) },
        { role: "assistant", content: "Two photos." },
      ],
    });
    expect(visionImages(p)).toHaveLength(2);
    expect(payloadTextLength({ kind: "llm.vision", payload: p })).toBe(
      "What is in these?".length + "Two photos.".length + "Be brief.".length,
    );
  });
});

describe("the llm.image payload — §1", () => {
  it("is a prompt, with a closed aspect and a count of 1 to 4", () => {
    expect(ImagePayload.safeParse({ prompt: "a red bicycle" }).success).toBe(
      true,
    );
    expect(
      ImagePayload.safeParse({ prompt: "x", aspect: "portrait", count: 4 })
        .success,
    ).toBe(true);
    expect(
      KindedPayload.safeParse({
        kind: "llm.image",
        payload: { prompt: "x", aspect: "square" },
      }).success,
    ).toBe(true);
  });

  it.each([
    ["a pixel size", { prompt: "x", size: "1024x1024" }],
    ["a model", { prompt: "x", model: "flux" }],
    ["a step count", { prompt: "x", steps: 30 }],
    ["an open aspect", { prompt: "x", aspect: "16:9" }],
    ["five images", { prompt: "x", count: 5 }],
    ["no prompt", { prompt: "" }],
  ])("refuses %s", (_what, raw) => {
    expect(ImagePayload.safeParse(raw).success).toBe(false);
  });

  it("measures its prompt", () => {
    expect(
      payloadTextLength({ kind: "llm.image", payload: { prompt: "abcd" } }),
    ).toBe(4);
  });
});

describe("each result addition on its own kind only", () => {
  const ran = {
    model: "qwen",
    backendClass: "http",
    durationMs: 10,
    stop: "end",
    stopReported: true,
  };
  const tools = {
    toolCalls: 3,
    toolOutcomes: { answered: 2, errored: 0, timedOut: 1, refused: 0 },
  };
  const ok = { outcome: "ok", text: "fine" };

  it("puts toolCalls and toolOutcomes on llm.tools, and refuses them elsewhere", () => {
    const sealed = { outcome: ok, ran: { ...ran, ...tools } };
    expect(SealedOutcomeFor("llm.tools").safeParse(sealed).success).toBe(true);
    for (const kind of [
      "llm.chat",
      "llm.generate",
      "llm.vision",
      "llm.image",
    ] as const) {
      expect(SealedOutcomeFor(kind).safeParse(sealed).success, kind).toBe(
        false,
      );
    }
    // And they are not optional there: a site needs them on every arm.
    expect(
      SealedOutcomeFor("llm.tools").safeParse({ outcome: ok, ran }).success,
    ).toBe(false);
  });

  it("makes toolOutcomes account for every call", () => {
    const off = {
      outcome: ok,
      ran: {
        ...ran,
        toolCalls: 3,
        toolOutcomes: { ...tools.toolOutcomes, answered: 1 },
      },
    };
    expect(SealedOutcomeFor("llm.tools").safeParse(off).success).toBe(false);
    expect(
      SealedOutcomeFor("llm.tools").safeParse({
        outcome: ok,
        ran: {
          ...ran,
          toolCalls: 21,
          toolOutcomes: { answered: 21, errored: 0, timedOut: 0, refused: 0 },
        },
      }).success,
    ).toBe(false);
  });

  it("lets only llm.tools stop at its tool budget", () => {
    expect(StopReasonSchema.options).toContain("tool-budget");
    const budget = {
      outcome: ok,
      ran: { ...ran, ...tools, stop: "tool-budget" },
    };
    expect(SealedOutcomeFor("llm.tools").safeParse(budget).success).toBe(true);
    expect(
      SealedOutcome.safeParse({
        outcome: ok,
        ran: { ...ran, stop: "tool-budget" },
      }).success,
    ).toBe(false);
  });

  it("puts images on llm.image, required, and refuses them elsewhere", () => {
    const image = { outcome: { ...ok, text: "", images: [ref()] }, ran };
    expect(SealedOutcomeFor("llm.image").safeParse(image).success).toBe(true);
    for (const kind of [
      "llm.chat",
      "llm.generate",
      "llm.vision",
      "llm.tools",
    ] as const) {
      expect(SealedOutcomeFor(kind).safeParse(image).success, kind).toBe(false);
    }
    expect(
      SealedOutcomeFor("llm.image").safeParse({ outcome: ok, ran }).success,
    ).toBe(false);
    // Bytes, never URLs: the image arm has no artifactUrl.
    expect(
      SealedOutcomeFor("llm.image").safeParse({
        outcome: { ...image.outcome, artifactUrl: "https://x.test/a.png" },
        ran,
      }).success,
    ).toBe(false);
  });

  it("leaves the existing kinds' sealed outcome exactly as it was", () => {
    // What a 0.1.4 reader parses: a text answer and its `ran`, nothing new.
    const plain = { outcome: ok, ran };
    for (const kind of ["llm.chat", "llm.generate", "llm.vision"] as const) {
      expect(SealedOutcomeFor(kind)).toBe(SealedOutcome);
    }
    expect(SealedOutcome.safeParse(plain).success).toBe(true);
  });
});

describe("the tool envelope directions — §5.1", () => {
  it("are directions beside payload and result", () => {
    expect(EnvelopeDirection.options).toEqual([
      "payload",
      "result",
      "tool-call",
      "tool-result",
    ]);
  });
});

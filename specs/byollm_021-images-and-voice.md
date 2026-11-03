# byollm_021 — Images in and out; voice as a named future

**Status: for ruling. Written 2026-11-02 by Kevin Samsoe for decision #6755
(card #6758), beside byollm_012 v1. Nothing here is built, and under rule 34
nothing in this repo changes until Todd has read it and ruled. CW reviews
on #6755.**
**Read with: `MAX_ENVELOPE_BYTES` in `packages/protocol/src/job.ts` (the
09-10 ruling), byollm_009 §6 and §12, byollm_013, byollm_016 Amendment L.**
**§Rollout at the end covers this spec and byollm_012 together.**

## What Todd is asked to rule

1. **Image input (`llm.vision`) and image output (`llm.image`)**, as two
   decisions. They share one mechanism for the bytes, so ruling yes to
   either means building it.
2. **Where the bytes go** (§2): by reference, encrypted end to end, in
   object storage. This follows the 09-10 ruling rather than reopening it.
3. **Voice** (§9): a named future, with its shape recorded so that nothing
   built now gets in its way.
4. **The rollout** (§Rollout): one gathered 0.1.5 with byollm_012, the hub
   first, and #5743 riding along under #6214.

## 0. Where this starts

- **Todd, 2026-09-10**, recorded on `MAX_ENVELOPE_BYTES`: *"6 MB solves for
  just text and people don't try to push images. We will add R2 for
  multimodal later."* The docstring explains why: **the cap is a shape
  decision.** It makes the envelope the wrong tool for a photo, because the
  right tool for a photo is object storage and a reference to it.
- **`NOT_YET`** says "no embeddings or images yet" on every surface.
- **Amendment L's own example** names an image kind: `"advertising":
  ["llm.generate", "llm.image"]`. This spec keeps that name for image
  output.
- **No integrator has asked for images through byollm yet.** Press's Ad
  Studio is the obvious candidate. This spec does not claim it needs images.
  Whoever owns Ad Studio says so, and that is the evidence.

## 1. Two kinds, not a bigger `llm.chat`

byollm_016's wire says **the kind owns the payload shape**. If `llm.chat`
messages could carry images, a 0.1.4 daemon advertising `llm.chat` would
claim a job it cannot parse: `ChatMessage` is strict, so the payload would
be refused after the claim, on a device the person chose. A new kind is
never advertised by a daemon that cannot serve it, and is never offered to
one (`CLAIM_REQUIRES_CAPABILITY`). It also gets its own row on the consent
screen and its own byollm_013 probe, and it needs no new field in the stub.

**`llm.vision`: "Reading images".** The payload is `llm.chat`'s, except that
a `user` message's `content` may be a list of parts instead of a string:

```
{ type: "text",  text: string }
{ type: "image", image: BlobRef }        // §2
```

There are 1 to 8 images per job, only in `user` turns. The result is text,
as for `llm.chat`.

**`llm.image`: "Making images".**

```
{ prompt: string, aspect?: "square" | "portrait" | "landscape", count?: 1..4 }
```

`aspect` and `count` are argued for, since byollm_004 §1 keeps parameters
off payloads. They are closed enums, like `ChatMessage.role`. They work
*inside* the model call and never route it. The owner's service entry maps
each aspect to that backend's pixel size (`request.sizes`), so a job never
names a size, a model or a step count. An ad needs to be square for one
placement and portrait for another, and without `aspect` the kind cannot
produce either on purpose. `count` is clamped by the owner's
`maxImagesPerJob`.

The result is `outcome: "ok"` with `text` (empty, or the backend's revised
prompt where it returns one) and `images: BlobRef[]`.

**Not in this spec:** editing an image (image in and image out in one job),
images in `llm.tools`, and images in `llm.generate`. Each is a later kind
if someone needs it.

## 2. Where the bytes go

**By reference, always.** The envelope stays at most 6 MiB and carries
references. Bytes never ride inside it, even when a small image would fit.
Two placements would mean two implementations, and the 09-10 ruling already
chose this one.

**Each image is its own blob, encrypted before it leaves the endpoint that
made it:**

- A fresh 32-byte key per blob. XChaCha20-Poly1305, with the nonce stored
  ahead of the ciphertext.
- The associated data is `jobId ‖ blobId ‖ direction` (`in` or `out`). A
  blob therefore cannot be moved to another job, or passed off as an output
  when it was an input, without failing to decrypt.
- The reference, `BlobRef`, travels **only inside the sealed, signed
  envelope**:

```
BlobRef = { blob: string, mediaType, bytes, width, height, sha256, key }
```

`sha256` is the hash of the plaintext and is checked after decrypting. Since
`key` exists only inside an envelope that is signed and sealed
(`ENVELOPE_SEALED_AND_SIGNED`), whoever stores the blob holds ciphertext and
nothing that opens it. That keeps `RELAY_BLIND` true for media.

**The blob is padded to a multiple of 256 KiB before it is encrypted.**
Amendment A's rule is that the router sees a bucket, never a byte count,
because the exact figure is the stronger fingerprint. A blob store sees each
object's size, so padding is how that rule reaches media. byollm_009 §12
says traffic analysis is not addressed. This keeps blobs from making it
worse.

### The cloud lane (byollm.cloud)

- **Upload, site side.** The site asks the hub for an upload slot with a
  signed request (`POST /relay/blobs`, site key, the job id and the padded
  size). The hub answers with a blob id and a short-lived presigned R2 `PUT`
  URL that signs that size as its `Content-Length`. The site uploads the
  ciphertext **straight to R2**. Whether R2 enforces a signed
  `Content-Length` is Cloudflare's behaviour, not ours, so nothing rests on
  it: **the hub reads each object's size (a `HEAD`) before the job is
  offered**, and refuses the job if any of its blobs is missing or differs
  from the size its slot was issued for. Output blobs get the same check
  before the result is accepted. The build card still tests R2 once, so the
  docs can say whether an oversized upload fails at R2 or only at the hub.
  Either way, the 256 KiB padding and a teammate's budget rest on a size
  that has been checked, not only declared.
  The bytes never pass through the relay's memory. That matters, because the
  09-10 docstring sizes the cap to a 320 MiB box. A site may upload at
  enqueue time, before any device has claimed the job, because the key does
  not depend on the device. The upload overlaps the wait.
- **Download, device side.** A daemon holding the job's lease asks for a
  short-lived presigned `GET` with a lease-scoped signed request
  (`LEASE_SCOPED_BY_GRANT`). No lease, no URL.
- **Output.** The daemon asks for upload slots the same way (lease-scoped,
  `out`), uploads, and only then posts the sealed result that references
  them. The site downloads with its own signed request.
- **Deletion.** A job's blobs, in and out, are deleted when the site
  collects the result. A job that is never collected has its blobs deleted
  24 hours after `deadlineAt`. An R2 lifecycle rule deletes anything older
  than 7 days as a floor under both, for the case where the hub's own sweep
  is down. **No blob outlives its job by more than a day in normal
  operation**, and the privacy page says so.
- **Metering.** Blob bytes are counted into the existing monthly aggregate,
  the same as envelope bytes (the "two grains" ruling of 2026-08-28). No
  per-job byte figure is recorded. The object's size exists in R2 for as
  long as the object exists, as the envelope's size does in the store, and
  goes with it.

### The direct lane (`@byollm/server`)

The server answers the same endpoints from its store adapter, which gains
`putBlob`, `getBlob` and `deleteBlob`. The memory store keeps blobs in
memory. The Supabase adapter uses a private Storage bucket that only the
service role can reach, which **means a migration**. For anyone who wrote
their own store adapter, this is a breaking addition to the store contract,
and §Rollout says so in the release note.

## 3. Size class and caps

**`sizeClass` keeps its meaning, which is characters of text.** For
`llm.vision` it buckets the text parts, and for `llm.image` the prompt.
Images are not squeezed into it, and the enum gains no value. Image bytes
are bounded by protocol constants instead, so the stub gains no field
(`STUB_METADATA_EXHAUSTIVE` is untouched) and a 0.1.4 parser never meets a
new size class.

| value | constant | why |
|---|---|---|
| 20 MiB per image, in or out | `MAX_IMAGE_BYTES` | a full-resolution phone photo as JPEG, with room to spare |
| 8 per `llm.vision` job | `MAX_IMAGES_IN` | several pages or screenshots; more is a batch, which is several jobs |
| 4 per `llm.image` job | `MAX_IMAGES_OUT` | the `count` ceiling |
| 8,192 px a side, 40 megapixels | `MAX_IMAGE_SIDE`, `MAX_IMAGE_PIXELS` | a 20 MiB PNG can decode to gigabytes; this refuses decompression bombs from the header |

(The value comes first because `musts-match-specs.test.ts` reads any table
row that starts with a backticked SCREAMING_CASE id as a declared MUST.)

**A teammate's images are budgeted before they are downloaded.** The daemon
gains `community.maxImageBytes`, set by the owner, with a default of 16 MiB
per job, for jobs whose owner is not the device's owner. The check runs on
the `bytes` declared in the opened payload, **before any blob is
downloaded**. While downloading, the daemon counts actual bytes and stops at
the declared size, so a blob larger than declared is refused.

**The default is lower than `MAX_IMAGE_BYTES` on purpose.** 16 MiB per job
admits two or three ordinary phone photos (a few MiB each as JPEG) from a
teammate. It refuses a single image at the 20 MiB protocol cap. The cap is
sized for an owner's own work, where the person paying for the bandwidth is
the person sending the image. On a teammate's job the device's owner pays,
so the default leaves that headroom unspent until the owner raises
`community.maxImageBytes`. The refusal names the setting and the size the
job needed (byollm_013's rule).

This is #5738's "fetch, then refuse" (see §Rollout) made cheap on purpose:
what is fetched before the decision is the sealed payload, at most 6 MiB of
text and references, never 160 MiB of somebody else's photos.

## 4. Formats

- **In and out: `image/png`, `image/jpeg`, `image/webp`.**
- **Refused:** SVG, which is a document that can carry script. GIF, which
  means animation and decoding bombs; the site converts. HEIC and AVIF; the
  site converts, and v1 stays narrow. Anything else.
- **The declared type must match the bytes.** Both endpoints sniff the magic
  bytes, and a mismatch is refused. Width and height are read from the
  header (PNG `IHDR`, JPEG `SOF`, WebP `VP8`/`VP8L`/`VP8X`) without
  decoding, and an image over the pixel cap is refused before it reaches a
  backend.
- **Location metadata is the site's to remove.** The daemon passes input
  bytes through unchanged, because rewriting an image is decoding it. The
  site SDK strips EXIF before upload by default, and the docs say why: a
  phone photo carries where it was taken, and a teammate's device should not
  learn that.
- **Output is untrusted to the site** (byollm_003 Rev 1's return trip). The
  site SDK checks the type and dimensions before it hands bytes to the app,
  and the docs tell apps to serve them only with the verified
  `Content-Type` and `X-Content-Type-Options: nosniff`. That is
  `OUTPUT_INERT`'s meaning for images: bytes, never a document.

## 5. Capability and detection

Capability rows are already per kind and per service. A service lists
`llm.vision` or `llm.image` in its `kinds`, and the kind is advertised only
when its probe passes (`CAPABILITY_IS_DETECTED`, byollm_013).

**The vision probe has to prove the effect, not only the invocation.**
byollm_013 says a probe proves the invocation, not the model. For images,
that is not enough. byollm_016 learned with adapters that **liveness cannot
tell a parameter that was used from one that was ignored**, and some model
servers drop image parts for a model that cannot see them and answer
anyway. So the probe sends an embedded 16×16 solid-red PNG through the exact
request shape, asks "What colour is this square? Answer with one word.",
and passes only on "red". That is one tiny image and one word. It is the
same differential check 016 requires for adapters, applied to the one place
here where a 200 means nothing.

**The image probe** asks for the smallest size the backend allows and passes
when the bytes are a valid PNG, JPEG or WebP by their magic. On a metered
backend this is a paid call, so it runs when the owner adds the kind and on
`byollm backends --probe-images`, and the heartbeat reuses the last result
for 24 hours. It never runs per heartbeat.

**Failures name themselves:** "llava on ollama: sent an image, the model
answered 'blue' — it is not reading images", "flux on localai: answered
with a URL instead of image bytes (see §6)".

## 6. Backend support

Expectations, not promises. **The probe decides**, and this table is what
the build cards test first.

| backend | `llm.vision` | `llm.image` | how |
|---|---|---|---|
| `ollama` | vision models (Gemma 3, Qwen2.5-VL, Llama 3.2 Vision, LLaVA) | no | `image_url` parts with data URLs on `/v1/chat/completions` |
| `llamacpp` | with a multimodal projector (`--mmproj`) | no | same |
| `vllm`, `lmstudio`, `jan` | vision models | no | same |
| `mlx` (`mlx_lm.server`) | no; text only (`mlx-vlm` is a different server, and can be a later entry) | no | — |
| `localai` | vision backends | yes | chat parts; `/v1/images/generations` |
| `openai` | yes | yes | chat parts; `/v1/images/generations` |
| `anthropic` (compatible endpoint) | yes | no | chat parts |
| `gemini` (compatible endpoint) | yes | probe decides | chat parts; images endpoint |
| `grok`, `together` | yes | yes | chat parts; images endpoint |
| `groq`, `mistral`, `openrouter` | vision models | no in v1 | chat parts |
| `deepseek` | no | no | — |
| `claude-cli` | expected, to verify | no | `--input-format stream-json` with base64 image blocks: a second frozen argv, with its own corpus rows |
| `codex-cli` | expected, to verify | no | `-i <path>`; the daemon writes the image into the empty scratch cwd under a name the daemon chose, never one from the payload |

**Image output is bytes, never URLs.** The daemon asks `/v1/images/generations`
for `b64_json`. A backend that answers with a URL instead is an error,
because fetching it would mean the daemon fetching a URL the backend chose,
which is exactly the device-side fetch byollm_012 holds back from v1
(§11.1). That fetch is not allowed here.

**Named future backends:** ComfyUI and Automatic1111, where most local image
generation actually runs. Neither speaks the OpenAI shape, so each is a new
backend type with its own adversarial rows, not a registry line.

## 7. Who may send images to whose device

**Images are allowed on `team`.** Unlike tools, an image does nothing on
the device. It is data handed to a model, and the result is text or bytes.
But an image is more personal than most text, so:

- **`SHARED_COMPUTE_DISCLOSED` gets an image sentence.** A Reading-images
  slot mapped to a teammate's service shows: **"<owner>'s device will see
  the images this part of <site> sends."**
- **A teammate's images are kept as hashes only** in the owner's ingress log
  (§8), from the start, rather than in full for 7 days the way byollm_004
  Rev 1 keeps a teammate's text. Keeping somebody else's photos for a week
  is more than keeping their prompts.
- **`llm.image` on a metered backend** falls under `METERED_DEFAULTS_SELF`
  and `METERED_REQUIRES_CEILING` unchanged. Images are priced per image,
  not per token, so the ceiling for an image service is counted in images.
  The build card picks the unit, and the MUSTs do not change.

## 8. Ingress log

Each image in or out gets one line: hash, type, bytes and dimensions. The
image itself is not kept. An owner may choose to keep the images from their
own jobs. A teammate's are always hashes.

## 9. Voice: a named future

**Not proposed for 0.1.5.** The shape is recorded so that nothing built now
precludes it, and so that "not now" is about cost:

- **Two kinds: `audio.transcribe`** (audio in, text out) **and
  `audio.speak`** (text in, audio out). For `audio.speak`, *the voice is the
  service*. That is byollm_016's founding example: the first real config
  named its backend `gwen-voice`. A site asks for speech and never names a
  voice, under the same key-not-value law as everything else.
- **The same blob mechanism.** `BlobRef.mediaType` is a closed enum
  *per kind*, which is why §2 calls it `BlobRef` and not `ImageRef`: audio
  types join it for audio kinds without a new reference shape. Formats in:
  WAV, MP3, M4A/AAC, Ogg Opus, FLAC, WebM. Out: MP3, WAV, Opus. Caps are
  set by duration as well as bytes (for example 30 minutes in, 10,000
  characters out).
- **Backends:** `/v1/audio/transcriptions` (whisper.cpp server,
  faster-whisper-server, LocalAI, OpenAI, Groq) and `/v1/audio/speech`
  (OpenAI, LocalAI, Kokoro-FastAPI), all on the existing `openai-http`
  transport.

**Why it waits:**

- **No integrator has asked through byollm.** Earwax, an audiobook studio,
  is the obvious first one for `audio.speak`. This spec does not claim it
  needs it. Whoever owns earwax says so, and that is the evidence 016's
  evidence-gating asks for.
- **Live voice needs streaming**, which is byollm_006 and is parked. Only
  file-in, file-out voice fits the job model as it is.
- **A cloned voice is a person's likeness.** `audio.speak` on a
  teammate's device, in the owner's own cloned voice, for a site the owner
  never used, raises a consent question that `offer: "team"` does not
  answer. It needs its own sentence before it needs code.

## 10. Proposed MUSTs and their checks

These are in bold rather than registry rows, for the reason byollm_012 §12
gives.

- **BLOBS_SEALED**: blob bytes leave an endpoint only encrypted under a key
  that travels only inside a sealed, signed envelope; a blob store and a
  relay hold no key that opens one. It extends `RELAY_BLIND` to media.
  Operator and conformance.
- **BLOB_BOUND_TO_JOB**: a blob that fails to decrypt under its job's
  associated data, or whose plaintext hash does not match its reference, is
  refused at both endpoints. Conformance.
- **MEDIA_VERIFIED**: declared type matches the magic bytes, and the
  dimensions are within the caps, checked at both endpoints before a backend
  or an app sees the bytes. Conformance and adversarial.
- **BLOB_BUDGET_BEFORE_DOWNLOAD**: a non-owner's images are charged against
  `community.maxImageBytes` from the declared sizes before any blob is
  fetched, and a download stops at its declared size. An upstream offers
  no job whose stored blobs differ from the sizes their slots were issued
  for (§2). Conformance on the reference server (C060, C061, C069);
  operator on the hub.
- **BLOBS_GO_WITH_THE_JOB**: a job's blobs are deleted at collection, or 24
  hours after its deadline. Conformance on the reference server; operator on
  the hub.
- **IMAGE_BYTES_NOT_URLS**: a daemon never fetches a URL a backend returned
  in place of image bytes. Adversarial.

| # | proposed id | what it does | passes when | mutation that must fail it |
|---|---|---|---|---|
| 1 | C057 blobs sealed | the kit reads every stored blob and the relay's whole state | no plaintext image bytes anywhere; no key | store the plaintext |
| 2 | C058 blob bound to its job | swap two jobs' blob ids; swap `in` for `out`; flip one byte | each one refused before the backend | drop the associated data |
| 3 | C059 media verified | PNG declared over JPEG bytes; an SVG; a 50,000 × 50,000 PNG header | each one refused; backend saw nothing | trust the declared type |
| 4 | C060 blob budget before download | a teammate's job declaring 3 × 10 MiB against a 16 MiB budget | refused; **zero blob downloads** | check after downloading |
| 5 | C061 blob larger than declared | a blob of 12 MiB declared as 2 MiB | download stops at 2 MiB; refused | trust the declaration |
| 6 | C062 blob needs the lease | a download request without the job's lease | refused; no URL issued | drop the lease scope |
| 7 | C063 blobs go with the job | collect a result; let another job pass its deadline plus a day | no blob left for either | skip the sweep |
| 8 | C064 vision is detected | an echo backend that ignores images and answers "blue" | `llm.vision` not advertised; `backends` says why | probe for a 200 only |
| 9 | C065 image bytes, not URLs | an image backend that answers with a URL | job errors; no fetch made | follow the URL |
| 10 | C069 blob size checked before offer | the reference server issues a 256 KiB slot; the site stores 512 KiB under it, then a job is enqueued | the job is refused at enqueue and never offered | trust the slot's size |

(byollm_012's checks are C033–C045.)

## 11. Done when

- `llm.vision` and `llm.image` (whichever are ruled) exist in
  `@byollm/protocol`, with `BlobRef`, the caps and the kind labels.
- Blobs work on both lanes: R2 with presigned URLs on the hub, and the store
  adapter methods on `@byollm/server` with the Supabase migration.
- §10's checks pass and are recorded in MUTATIONS.md.
- The backends in §6 marked "yes" pass their probes on a real machine, and
  `claude-cli`/`codex-cli` vision is either verified or struck from the
  table.
- The site SDK encrypts, pads, strips EXIF, uploads and verifies output,
  and an app never handles a key.
- `NOT_YET` drops "no images yet" and keeps "no voice yet".

---

## Rollout: byollm_012 v1 and byollm_021 in one gathered 0.1.5

This is the rollout for both specs. Todd held 0.1.5 on #6214 (msg #53767):
*"Let's hold this until we have more updates to go out in 0.1.5 — likely
tool and image support."* So whatever of the two specs is ruled ships as
that release, with the two fixes already in it.

### R1. What changes in the protocol

- `JobKind` gains whichever of `llm.tools`, `llm.vision` and `llm.image`
  are ruled.
- New payload schemas: tools is chat's shape plus `tools` and
  `maxToolCalls`; vision is chat with image parts; image is §1's.
- Result additions, each on its own kind only: `toolCalls` (tools),
  `images` (image). `StopReason` gains `tool-budget`.
- For tools: `Purpose.tools` in the manifest; `toolsDigest` on grants for
  `llm.tools` only; the `tool-call` and `tool-result` envelope directions;
  four endpoints, `tool-call` and `tool-results` on the daemon plane and
  `calls` and `tool-result` on the site plane, served by the relay and by
  `@byollm/server` alike; and the site SDK's tool handlers in the pump.
- `BlobRef`, the media caps and the 256 KiB padding.
- New endpoints for images: the site's blob slot, the device's lease-scoped
  blob URLs, and the device's output slots. On the hub they are presigned R2
  URLs. On `@byollm/server` they are served from the store.
- The store contract gains three blob methods. The Supabase SQL gains a
  bucket and its policy. Tool calls and results in flight need a store too,
  and on the direct lane they use the same adapter: a short-lived row per
  call, deleted with its job.
- Kind labels: "Using the site's tools", "Reading images", "Making images".
- `NOT_YET` updated (both specs' "done when").
- The MUSTs in byollm_012 §12 and §10 above, as registry entries and spec
  tables, with their checks.

**`PROTOCOL_VERSION` stays `"2"`.** Every addition is a new value that
reaches only a party that advertised or declared it. That holds in one
direction only, which is why the order below matters.

### R2. Who goes first, and what each pair sees

1. **Publish `@byollm/*` 0.1.5.** The tag, pins and three-OS run are #4265,
   iceboxed today, which comes back out.
2. **The hub goes on 0.1.5 before anything sends a new kind**: relay,
   control plane and the dashboard's consent screen, plus the R2 bucket, its
   lifecycle rule and presigning. The control plane signs `toolsDigest`
   into `llm.tools` grants and re-asks a person when a purpose's tools
   change. The tools slot's pulldown lists services with tools on, own and
   team. The kind labels and both specs' disclosure lines go live.
3. **Manifests.** Todd updates the byollm.cloud manifest of record by hand,
   as today. New slots start unmapped, and people get the mapping
   notification (Amendment L's rider).
4. **Daemons upgrade when it suits their owners.** Nothing new is on until
   an owner adds a kind to a service.
5. **Sites bump their pins and declare the new kinds.**

| pair | what happens |
|---|---|
| 0.1.4 daemon, 0.1.5 hub | Nothing changes. It never advertises a new kind and is never offered one. A person whose only devices are on 0.1.4 sees the new slot as "nothing of yours can use the site's tools yet — update byollm on <device> (0.1.4)". It never receives a grant carrying `toolsDigest`, because grants carry it only for `llm.tools`, which it never claims. The hub knows the version from `daemonVersion` on the device's requests, so the hub composes the fix (byollm_013's rule). |
| 0.1.5 daemon, 0.1.5 hub | Everything ruled. |
| 0.1.5 daemon, **0.1.4 upstream** (a hub not yet deployed, or a self-hosted `@byollm/server`) | **The danger case.** `Capability.kind` is an enum, and a 0.1.4 upstream parses the heartbeat strictly. One new kind in the advertisement and the whole heartbeat is refused, so the device goes dark for *everything*, not only the new kind. Two guards. (a) New kinds are off by default, so a plain upgrade advertises nothing new. (b) The daemon must never let a new kind take the device down, and must not blame the upstream's version for a refusal the new kind did not cause. A 0.1.4 upstream's refusal does not say which field failed: the relay and the reference server both answer `400 bad-request` with a fixed message ("request failed schema validation" in `relay/src/daemon-plane.ts`, "request body failed schema validation" in `server/src/handlers.ts`) that names no path. So the daemon tells the two cases apart by a differential retry instead of by reading the body. When a heartbeat that advertises a 0.1.5 kind is refused as `bad-request`, the daemon re-sends the same heartbeat once, with only the 0.1.5 kinds removed. **Only if that retry succeeds** does it remember, for the session, that this upstream predates them, and say so: "<upstream> runs byollm 0.1.4 or older and cannot carry the site's tools — update it, or turn tools off for `qwen`". If the retry is refused too, the new kinds were not the cause. The daemon reports the original refusal as it does today, and blames no version. The hub cannot warn the daemon with a new response field, because B019 is the same hazard in the other direction. A 0.1.5 upstream may name the failing path inside the existing `message` string, which adds no key, but the daemon must not depend on that, because 0.1.4 upstreams never will. |
| 0.1.4 site, 0.1.5 hub | Nothing changes. It never asks for a new kind, so it never meets a new result key. |
| 0.1.5 site, 0.1.4 hub | A new kind is refused at enqueue as a bad request. Step 2 before step 5 prevents this on byollm.cloud, and self-hosters upgrade their server before their site, which on the direct lane is the same package. A 0.1.5 site's pump asks a 0.1.4 relay for `calls` and gets a 404. The pump reads that as "this relay carries no tools" and carries on with the rest of its cycle, so a site that upgrades early keeps working. |

**The existing gate already covers the hub.** `scripts/ready-for-latest.mjs`
in byollm-cloud checks two things before a release is promoted to
`latest`. It compares the *keys* the hub accepts (`/wire`, from
`wire-shapes.ts`). It also compares every closed vocabulary the hub reports
in `/healthz` (backends, kinds, offer scopes, audiences, size classes,
backend classes) against the exports of the `@byollm/protocol` version
being promoted. `kinds` maps to `JOB_KINDS`. So a 0.1.5 daemon that
advertises `llm.tools` is refused promotion until the deployed hub
accepts it, and a vocabulary the gate cannot map is itself a refusal.
(This section first said the gate compared keys only. That was wrong: it
read `wire-shapes.ts` without reading the vocabulary half of the script.)
What the gate cannot reach is a self-hosted `@byollm/server` still on
0.1.4, and guard (b) above exists for that case.

### R3. What `@oftomorrow/byollm` (Press) needs

- Pin `@byollm/*` to exactly 0.1.5. `docs/schema-lock.md` says to pin
  exactly.
- **Press hosts one tool, `web_search`,** as a handler registered with the
  site SDK. It runs on Press's own search key, with Press's cache and rate
  limits, and authorises each call as the job's user (byollm_012 §6).
- **`llmSearch` becomes a thin wrapper over `llm` with `llm.tools`** and
  that one tool, which is what its docstring has been promising. It goes to
  the runner first. When no device can serve it, it takes Press's existing
  labelled API path (`FALLBACK_LABELED`), as `llm` does today.
- **The waiting request keeps the pump turning**, as it does today
  (`pumpWhileWaiting`), and the pump now answers tool calls as well. A
  verification job that makes several calls keeps its request open for
  longer, so the route's timeout has to cover the round trips (byollm_012
  §5.3).
- `PURPOSES["fact-checker"]` gains `"llm.tools"` in `kinds` and the
  `web_search` declaration in `tools`. No purpose gains an image kind unless
  its owner asks (§0).
- If Press's store runs on the Supabase adapter's SQL, the blob bucket
  migration is vendored into `modules/byollm/migrations` **at the end of the
  folder**, because `register` numbers module migrations by sorted position,
  and pushed with `--include-all`. Earwax takes the same pin bump when it
  wants and needs no kind change.

### R4. What the byollm.cloud manifest needs

Press's manifest of record gains `llm.tools` on Fact Checker, with its
`web_search` declaration, and the hub's manifest validation accepts the new
kinds and `Purpose.tools` (step 2). The purpose's own description does not
change. The tools line under it is built from the declarations (byollm_012
§10), and the digest of those same declarations is what the device checks,
so the consent screen and the device cannot disagree about which tools
exist.

### R5. Docs

- `docs/security.md`: byollm_012 §13's sentence word for word, what a site
  takes on when it declares a tool (byollm_012 §6), image inertness and blob
  encryption.
- `docs/protocol.md`: the new kinds, the tool envelopes and endpoints,
  `BlobRef`, and the blob endpoints.
- A site guide for tools: declaring them, writing a handler, authorising as
  the job's user, and what the round trips cost on each lane.
- `docs/schema-lock.md`: whether the new payload shapes and `BlobRef` are
  inside the lock. The recommendation is yes, beside the envelope, since a
  site's stored references outlive a release.
- README, byo-llm.com and byollm.cloud: `NOT_YET` renders the updated list
  on every surface. Its test catches any surface that disagrees.
- byollm.cloud `/privacy`: images are stored encrypted for the life of a
  job and deleted when it is collected, or at most a day after its deadline.
  This lands with #4556's deletion sentence, which already rides with the
  0.1.5 web deploy.

### R6. The release note

`docs/release-notes/0.1.5.md` keeps its two paragraphs and gains these,
with the headline rewritten:

> **0.1.5 — Site tools, images, and two fixes.**
>
> `PROTOCOL_VERSION` is still `2`. **Update your hub or server first.** A
> daemon on 0.1.5 works with a 0.1.4 upstream until you turn on one of the
> new kinds, and if the upstream is older, it tells you and keeps serving
> everything else. A 0.1.4 daemon works with a 0.1.5 hub and never sees the
> new kinds. **There is a migration** if you run the Supabase adapter: the
> blob bucket. If you wrote your own store adapter, it needs `putBlob`,
> `getBlob` and `deleteBlob`.
>
> **Site tools.** A new kind, `llm.tools`, lets the model on your device
> call tools a site declares, such as its search or its catalogue. The
> tools run on the site's servers, never on your device: your device sends
> the model's requests to that site, sealed, and hands back what the site
> returns. You see the site's tools when you choose a model for them, and
> again if the site changes them. It works on local and HTTP models; your
> Claude and Codex subscriptions can't serve it yet. It is off until you
> turn it on for a service. Every request is in `byollm log`. (byollm_012)
>
> **Images.** `llm.vision` reads images and `llm.image` makes them. Images
> travel encrypted, by reference, and are deleted with their job.
> (byollm_021)

### R7. #5743 rides along (#6214)

23102a5 (#5743: a teammate's large job is admitted by its size class's
floor) is already on main under 0.1.5's bump (70b005d). Owl's red team on
#6214 named two things a ruling should say. This rollout gives each of them
an answer for Todd to accept or change:

- **Fetch, then refuse (red team point 3).** Admitting by the floor means a
  device fetches and opens a non-owner's payload before it can refuse it.
  That trade was accepted by Owl, not Todd. §3 of this spec makes the same
  trade for images and bounds it: the sealed payload may be fetched, blobs
  may not. **Proposed, for Todd to rule in one sentence with this
  spec:** "A device may fetch and open a non-owner's sealed payload before
  refusing it on size; it never downloads that job's blobs before the
  budget check."
- **#5744's unblock condition has no reader (point 4).** Step 2 puts the hub
  on 0.1.5 with device versions in view, which is the reader #5744's
  condition needs ("the hub shows every teammate-reachable device on it").
  The hub build card names #5744 so that whoever lands it unblocks it.

The 0.1.5 note's current line, "A daemon on 0.1.5 talks to a hub or relay on
0.1.0 through 0.1.4, and the other way round", stops being true without
qualification and is replaced by R6's paragraph.

### R8. Build cards, after the ruling

Filed only after Todd rules, each naming the ruling, on the ot.byollm lane.
In order, with the hub before the release:

1. **Protocol:** kinds, schemas, `Purpose.tools`, the grant's
   `toolsDigest`, the tool envelope directions, `BlobRef`, labels,
   `NOT_YET`, registry entries and spec tables.
2. **Relay and reference server, tools:** the four endpoints, the
   `waiting-on-site` sub-state, the relay's per-job count, and the direct
   lane's store rows for calls in flight.
3. **Daemon, tools:** the function-calling loop on `http` backends, the
   digest check at admission, the waits and timeouts, budgets, logging and
   the probe.
4. **Site SDK, tools:** handler registration, the pump's `calls` step, the
   SDK's per-job count, and the 404 tolerance for an older relay.
5. **Blobs:** store methods, the reference server endpoints, Supabase SQL,
   and the site SDK's encrypt, pad, strip and verify.
6. **Daemon, images:** vision parts, image generation, probes, and the
   `claude-cli`/`codex-cli` verification.
7. **Hub (byollm-cloud):** enum acceptance (the existing
   `ready-for-latest.mjs` refuses promotion until it is deployed, R2), the
   relay's tool endpoints, `toolsDigest` in grants and re-consent on a
   changed tool list, R2 and presigning, consent lines, the version-aware
   "update your device" slot text, and #5744's reader.
8. **Release:** #4265 back out of the icebox (pins, tag, three-OS run), the
   note (R6), the changelog and the docs (R5).
9. **Press:** R3, after 8.

Cards 2–4 and 5–6 can run in parallel once 1 is on main. Card 7 can start
once 1 is on main. Nothing reaches npm until 8, and nothing reaches people
until the hub has gone first.

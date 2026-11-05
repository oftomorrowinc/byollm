# byollm_021 — Images in and out; audio as a named future

**Status: ruled. Written 2026-11-02 and revised 2026-11-03 by Kevin Samsoe
for decision #6933 (card #6758). Todd ruled #6933 on 2026-11-03 (#55201):
object storage by reference stands, and the rulebook's "no blob path" line is
amended by that ruling. This version is the one commit that ruling names.
Nothing here is built, and under rule 34 nothing in this repo changes until
the cards that follow the ruling are filed.**
**Read with: Todd's ruling at #55201 and CW's write-up at #55220; #6756's
ruling as written out at #54358; `MAX_ENVELOPE_BYTES` in
`packages/protocol/src/job.ts` (the 09-10 line); byollm_009 §6 and §12;
byollm_013; byollm_016 Amendment L.**
**§Rollout at the end covers this spec and byollm_012 together.**

**How this text got here.** The first version (488cb02) carried image bytes
by reference, as encrypted blobs in R2. #6756's write-up struck "hub-stored"
image bytes on 11-02, so 9331a6d put them inline at about 4 MiB a job. Todd
then ruled on #6933, in his own words: *"I want object storage by reference —
storage URLs with file pointers — for images and other large files, so we
don't hit size issues. That's the 488cb02 §2 design, and the rulebook's 'no
blob path' line is amended by this."* His example: inline, one 5 MB phone
photo from Ad Studio is refused; by reference it is 20 MiB an image, eight to
a job, encrypted and gone when the job is collected. So §2 and §3 are
488cb02's again, with CW's finding 5 answered (blob deletion waits for the
site to hold its output). Everything 9331a6d settled stays: images on HTTP
backends only (§6), "audio" (§9), the release order and cut line
(§Rollout).

## What was ruled

1. **Image input (`llm.vision`) and image output (`llm.image`).**
2. **By reference** (§2–§3): each image an encrypted blob in object storage,
   its key only inside the sealed envelope, 20 MiB an image, eight to a job,
   deleted with the job. The rulebook's "no blob path" line is amended by the
   ruling, and the blob path arrives in two steps (§Rollout R2): the three
   servers we run take the blob endpoints on `0.1.5-beta.1` before any daemon
   can send an image.
3. **HTTP backends only** (§6), as #6756 ruled.
4. **Audio** (§9): a named future. "Audio", not "voice", because byollm_016
   already uses "voice" for an owner's tuned service.
5. **The rollout** (§Rollout): one gathered 0.1.5 with byollm_012, every
   server we run upgraded before any daemon gets 0.1.5, the cut line #6756
   ruled, and #5743 riding along under #6214.

## 0. Where this starts

- **#6933, ruled 2026-11-03** (#55201, above). By reference stands.
- **#6756, ruled 2026-11-02** (written out at #54358). Tools and image input
  are HTTP-backend-only in this release. Every server we run upgrades before
  any 0.1.5 daemon ships. Its strike of "hub-stored" image bytes is replaced
  by #6933.
- **Todd, 2026-09-10**, recorded on `MAX_ENVELOPE_BYTES`: *"6 MB solves for
  just text and people don't try to push images. We will add R2 for
  multimodal later."* The docstring explains why: **the cap is a shape
  decision.** It makes the envelope the wrong tool for a photo, because the
  right tool for a photo is object storage and a reference to it. #6933 is
  that "later".
- **`NOT_YET`** says "no embeddings or images yet" on every surface.
- **Amendment L's own example** names an image kind: `"advertising":
  ["llm.generate", "llm.image"]`. This spec keeps that name for image
  output.
- **Ad Studio is the case Todd named.** A phone photo is the input it needs,
  which is what the 20 MiB cap is sized for.

## 1. Two kinds, not a bigger `llm.chat`

byollm_016's wire says **the kind owns the payload shape**. If `llm.chat`
messages could carry images, a 0.1.4 daemon advertising `llm.chat` would
claim a job it cannot parse: `ChatMessage` is strict, so the payload would
be refused after the claim, on a device the person chose. A new kind is
never advertised by a daemon that cannot serve it, and is never offered to
one (`CLAIM_REQUIRES_CAPABILITY`). It also gets its own row on the consent
screen, its own offer scope per service, and its own byollm_013 probe, and
it needs no new field in the stub.

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
images in `llm.tools`, tool results by reference, and images in
`llm.generate`. Each is a later kind or a later use of the same blobs, if
someone needs it.

## 2. Where the bytes go: by reference

**By reference, always.** The envelope stays at most 6 MiB and carries
references. Bytes never ride inside it, even when a small image would fit.
Two placements would mean two implementations, and #6933 chose this one.

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
- **Deletion, in an order that lets the site keep its output** (CW's
  finding 5). 488cb02 deleted every blob when the site collected the
  result, but the site downloads its output blobs *after* it collects, so
  that order deleted the images before the site could fetch them. Instead:
  - **input blobs** are deleted when the device's result is accepted, since
    nothing reads them after that;
  - **output blobs** are deleted when the site says it holds them
    (`POST /relay/blobs/received`, signed, naming the job), which the site
    SDK sends once every output blob has downloaded and verified;
  - if the site never says so, output blobs are deleted **one hour** after
    the result was collected;
  - a job that is never collected has its blobs deleted 24 hours after
    `deadlineAt`;
  - an R2 lifecycle rule deletes anything older than 7 days as a floor
    under all of these, for the case where the hub's own sweep is down.

  **No blob outlives its job by more than a day in normal operation**, and
  the privacy page says so.
- **Metering.** Blob bytes are counted into the existing monthly aggregate,
  the same as envelope bytes (the "two grains" ruling of 2026-08-28). No
  per-job byte figure is recorded. The object's size exists in R2 for as
  long as the object exists, as the envelope's size does in the store, and
  goes with it.

### The direct lane (`@byollm/server`)

The server answers the same endpoints from its store adapter, which gains
`putBlob`, `getBlob` and `deleteBlob`, and the same deletion order. The memory
store keeps blobs in memory. The Supabase adapter uses a private Storage
bucket that only the service role can reach, which **means a migration**.
For anyone who wrote their own store adapter, this is a breaking addition to
the store contract, and §Rollout says so in the release note.

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

This is #5738's "fetch, then refuse" (see §Rollout R7) made cheap on
purpose: what is fetched before the decision is the sealed payload, at most
6 MiB of text and references, never 160 MiB of somebody else's photos.

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

## 6. Backend support: HTTP only

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

**`claude-cli` and `codex-cli` serve neither kind in this release**, as
#6756 ruled. Their containment is untouched and named here so that nobody
loosens it as a side effect: `FIXED_ARGV` in `claude-cli.ts` (`--tools ""`,
`--strict-mcp-config` with an empty server list, `--restricted`), the tools
`codex-cli.ts` turns off, `file-mentions-stay-outside.test.ts` and
`codex-tools-disabled.test.ts`. The first version of this spec listed a
stream-json argv for `claude-cli` and `-i <path>` for `codex-cli`. Both are
struck. The second wrote image bytes into the scratch directory, which is
the file-surface path BY-01 closed.

**Image output is bytes, never URLs.** The daemon asks `/v1/images/generations`
for `b64_json`. A backend that answers with a URL instead is an error,
because fetching it would mean the daemon fetching a URL the backend chose,
which is exactly the device-side fetch byollm_012 holds back from v1
(§11.1). That fetch is not allowed here.

**Named future backends:** ComfyUI and Automatic1111, where most local image
generation actually runs. Neither speaks the OpenAI shape, so each is a new
backend type with its own adversarial rows, not a registry line.

## 7. Who may send images to whose device

**Images are allowed on `team`**, under the owner's per-kind offer scope and
`community.maxImageBytes` (§3). An image does nothing on the device. It is data handed
to a model, and the result is text or bytes. But an image is more personal
than most text, so:

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

## 9. Audio: a named future

**Not proposed for 0.1.5.** The shape is recorded so that nothing built now
precludes it, and so that "not now" is about cost. ("Audio" throughout:
byollm_016 already uses "voice" for an owner's tuned service, such as
`gwen-voice`, and #6756 ruled the word.)

- **Two kinds: `audio.transcribe`** (audio in, text out) **and
  `audio.speak`** (text in, audio out). For `audio.speak`, *the speaker is
  the service*: an owner's tuned service is what byollm_016 calls a voice,
  and a site asks for speech and never names one, under the same
  key-not-value law as everything else.
- **The same blob mechanism.** `BlobRef.mediaType` is a closed enum *per
  kind*, which is why §2 calls it `BlobRef` and not `ImageRef`: audio types
  join it for audio kinds without a new reference shape. This is the "other
  large files" in Todd's ruling. Formats in: WAV, MP3, M4A/AAC, Ogg Opus,
  FLAC, WebM. Out: MP3, WAV, Opus. Caps are set by duration as well as
  bytes (for example 30 minutes in, 10,000 characters out).
- **Backends:** `/v1/audio/transcriptions` (whisper.cpp server,
  faster-whisper-server, LocalAI, OpenAI, Groq) and `/v1/audio/speech`
  (OpenAI, LocalAI, Kokoro-FastAPI), all HTTP.

**Why it waits:**

- **No integrator has asked through byollm.** Earwax, an audiobook studio,
  is the obvious first one for `audio.speak`. This spec does not claim it
  needs audio.
  Whoever owns earwax says so, and that is the evidence 016's
  evidence-gating asks for.
- **Live audio needs streaming**, which is byollm_006 and is parked. Only
  file-in, file-out audio fits the job model as it is.
- **A cloned voice is a person's likeness.** `audio.speak` on a
  teammate's device, in the owner's own cloned voice, for a site the owner
  never used, raises a consent question that `offer: "team"` does not
  answer. It needs its own sentence before it needs code.

## 10. MUSTs and their checks

Registered with byollm_012 §12's, in one commit (#7053), and `pending` for
the reason that section gives: the checks below are built by cards 5 and 6,
and the card that builds one promotes its MUST and edits its "Verified" cell.

| MUST | Statement | Verified | Checks, and the kind they verify it as |
|---|---|---|---|
| `BLOBS_SEALED` | Blob bytes leave an endpoint only encrypted under a key that travels only inside a sealed, signed envelope; a blob store and a relay hold no key that opens one. It extends `RELAY_BLIND` to media. | conformance + **operator** | C048: conformance on the reference server (card 5, #7057); operator on the hub |
| `BLOB_BOUND_TO_JOB` | A blob that fails to decrypt under its job's associated data, or whose plaintext hash does not match its reference, is refused at both endpoints. | adversarial | C049: the daemon's suite (`images.test.ts`, #7136) for the device's end; the server's (`blobs.test.ts`, #7057) for the site's |
| `MEDIA_VERIFIED` | Declared type matches the magic bytes, and the dimensions are within the caps, checked at both endpoints before a backend or an app sees the bytes. | adversarial | C050: the daemon's suite (`images.test.ts`, #7136) for the device's end; the server's (`blobs.test.ts`, #7057) for the site's |
| `BLOB_BUDGET_BEFORE_DOWNLOAD` | A non-owner's images are charged against `community.maxImageBytes` from the declared sizes before any blob is fetched, and a download stops at its declared size. An upstream offers no job whose stored blobs differ from the sizes their slots were issued for (§2). | conformance + **operator** + adversarial | C057: conformance on the reference server (card 5, #7057); operator on the hub; C051, C052: the daemon's suites (card 6, #7058) |
| `BLOBS_GO_WITH_THE_JOB` | Input blobs are deleted when the result is accepted; output blobs when the site says it holds them, or one hour after collection; an uncollected job's blobs 24 hours after its deadline. | conformance + **operator** | C054, C059: conformance on the reference server (card 5, #7057); operator on the hub |
| `IMAGE_BYTES_NOT_URLS` | A daemon never fetches a URL a backend returned in place of image bytes. | adversarial | C056: the http-class adversarial corpus (card 6, #7058) |

Beside the table: **`KIND_NO_CODE`, `OUTPUT_INERT` and the CLI containment**
are unchanged, and the image kinds are never advertised on a `process`
backend. Daemon; conformance (C058).

**C056 is a check id on an adversarial MUST.** The table below lists it with
the kit's checks, and the MUST says it is proved by the daemon's own suites.
Card 6 decides which it is: a hostile image backend in the adversarial
corpus (the MUST stays `adversarial` and the id names the corpus row), or a
kit check (the MUST becomes `conformance`). **Card 6 (#7058) chose the
corpus row**: `packages/daemon/test/adversarial/http-class.test.ts`, whose
hostile backend answers with a URL on its own server, so a fetch would be
seen there. C051, C052, C055 and C058 are the daemon's suites too
(`images.test.ts`, `served-kinds.test.ts`, and C055 again in the http-class
corpus against the real adapter), for the reason card 3 gave for the tool
checks: the kit's target cannot yet hold a teammate's blobs or a process
backend. C049 and C050's device ends are the daemon's suite as well
(`images.test.ts`, #7136), and for a plainer reason: the party refusing is
the daemon, so a kit check of that end would certify our daemon and say
nothing about the server under test. Their site ends are the server's suite
(`blobs.test.ts`, #7057). Both MUSTs are therefore `adversarial`, not the
`conformance` first planned here; a kit check of the site's end, driven
through the target's own SDK, is what would make them `conformance`.

The ids are assigned after byollm_012's C033 to C047, in this table's order,
with guard (b)'s check last. Each was proposed as: C048 (C057), C049 (C058),
C050 (C059), C051 (C060), C052 (C061), C053 (C062), C054 (C063), C055
(C064), C056 (C065), C057 (C069), C058 (C070), C059 (C071), and C060 (C066).

| # | id | what it does | passes when | mutation that must fail it |
|---|---|---|---|---|
| 1 | C048 blobs sealed | the kit reads every stored blob and the relay's whole state | no plaintext image bytes anywhere; no key | store the plaintext |
| 2 | C049 blob bound to its job | swap two jobs' blob ids; swap `in` for `out`; flip one byte | each one refused before the backend | drop the associated data |
| 3 | C050 media verified | PNG declared over JPEG bytes; an SVG; a 50,000 × 50,000 PNG header | each one refused; backend saw nothing | trust the declared type |
| 4 | C051 blob budget before download | a teammate's job declaring 3 × 10 MiB against a 16 MiB budget | refused; **zero blob downloads** | check after downloading |
| 5 | C052 blob larger than declared | a blob of 12 MiB declared as 2 MiB | download stops at 2 MiB; refused | trust the declaration |
| 6 | C053 blob needs the lease | a download request without the job's lease | refused; no URL issued | drop the lease scope |
| 7 | C054 blobs go with the job | collect a result and send `received`; let another job pass its deadline plus a day | no blob left for either | skip the sweep |
| 8 | C055 vision is detected | an echo backend that ignores images and answers "blue" | `llm.vision` not advertised; `backends` says why | probe for a 200 only |
| 9 | C056 image bytes, not URLs | an image backend that answers with a URL | job errors; no fetch made | follow the URL |
| 10 | C057 blob size checked before offer | the reference server issues a 256 KiB slot; the site stores 512 KiB under it, then a job is enqueued | the job is refused at enqueue and never offered | trust the slot's size |
| 11 | C058 no images on a process backend | a `claude-cli` service listing `llm.vision` | `llm.vision` not advertised; `backends` says the kind needs an HTTP backend | advertise it |
| 12 | C059 output outlives collection until received | the site collects an `llm.image` result, then downloads its blobs 30 seconds later without having sent `received` | every download succeeds; the blobs are gone after `received`, or one hour after collection without it | delete output blobs at collection |

(byollm_012's checks are C033–C047. C060 is the daemon's differential
heartbeat retry, in §Rollout R2.)

## 11. Done when

- `llm.vision` and `llm.image` (whichever are ruled) exist in
  `@byollm/protocol`, with `BlobRef`, the caps and the kind labels.
- Blobs work on both lanes: R2 with presigned URLs on the hub, and the store
  adapter methods on `@byollm/server` with the Supabase migration, both with
  §2's deletion order.
- §10's checks pass and are recorded in MUTATIONS.md, and no §10 MUST is
  still `pending`.
- The backends in §6 marked "yes" pass their probes on a real machine.
- `claude-cli`'s and `codex-cli`'s containment files and tests are
  unchanged, which the release card checks by diff.
- The site SDK encrypts, pads, strips EXIF, uploads, verifies output and
  sends `received`, and an app never handles a key.
- `NOT_YET` drops "no images yet" and keeps "no audio yet".

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
- For tools: `Purpose.tools`, `maxToolCalls` and `maxToolResultChars` in
  the manifest; `toolsDigest` on grants for `llm.tools` only; in the site's
  enqueue request beside the stub, `tools: { toolsDigest, maxToolCalls }`,
  the job's budget being what the relay counts its calls against (byollm_012
  §4, §8; #7122); `payloadTextLength` counting
  `maxToolResultChars`; `RunMetadata.toolOutcomes`; the `tool-call` and `tool-result` envelope directions;
  four endpoints, `tool-call` and `tool-results` on the daemon plane and
  `calls` and `tool-result` on the site plane, served by the relay and by
  `@byollm/server` alike; and the site SDK's tool handlers in the pump.
- For images: `BlobRef`, the media caps and the 256 KiB padding. New
  endpoints: the site's blob slot (`POST /relay/blobs`), the device's
  lease-scoped blob URLs, the device's output slots, and the site's
  `received`. On the hub they are presigned R2 URLs. On `@byollm/server` they
  are served from the store.
- The store contract gains `putBlob`, `getBlob` and `deleteBlob`, and a
  short-lived row per tool call in flight, deleted with its job. The Supabase
  SQL gains two migrations: the private Storage bucket and its policy, and
  the tool-call table.
- Kind labels: "Using the site's tools", "Reading images", "Making images".
- `NOT_YET` updated (both specs' "done when").
- The MUSTs in byollm_012 §12 and §10 above, as registry entries and spec
  tables, with their checks.

**`PROTOCOL_VERSION` stays `"2"`.** Every addition is a new value that
reaches only a party that advertised or declared it. That holds in one
direction only, which is why the order below matters.

### R2. Who goes first, and what each pair sees

#6756 ruled the order (shape 1): *"every server we run (hub, Signals, Press)
upgrades before any 0.1.5 daemon ships."* Signals and Press are both
upstreams: Signals mounts `@byollm/server` at
`apps/web/app/byollm/[...route]/route.ts`, and Press mounts it through
`byollmHandlers`. Both pin 0.1.4 today. A clean version publishes straight
to `latest` (`docs/releasing.md`: the dist-tag is derived from the version
string), and daemons install from `latest`. So the servers go first on a
prerelease, and the clean version follows:

1. **Publish `0.1.5-beta.1`** (dist-tag `beta`, never `latest`). It carries
   everything ruled. The release card is new, not #4265 unboxed: #4265's
   brief and the current 0.1.5 note describe a two-fix release, and rule 32
   does not amend a brief in place.
2. **Every server we run moves to `0.1.5-beta.1` and deploys**, before
   anything else. **This is the blob path's first step**, as #6933 ruled
   (Owl's offer, which Todd took): the blob endpoints and store methods
   reach the three servers we run while no daemon from `latest` can send an
   image. Until step 3 it can be backed out by pinning the servers back to
   0.1.4, and nothing depends on it.
   - **the hub**: relay, control plane and the dashboard's consent screen,
     plus the blob endpoints, presigning against the R2 bucket, the `HEAD`
     before offer and the deletion sweep. The bucket, its 7-day lifecycle
     rule and the access key are Todd's by hand (R8). The control plane
     signs `toolsDigest` into `llm.tools` grants and re-asks a person when a
     purpose's tools change. The tools slot's pulldown lists services with
     tools on, own and team. The kind labels and both specs' disclosure
     lines go live;
   - **Signals**: `signals/package.json` and `apps/web/package.json`. Only
     the pin: Signals runs the library's `MemoryStore`, which keeps blobs and
     tool-call rows in memory, so there is no migration. Its chat keeps
     working for a device that turns a new kind on;
   - **Press**: `packages/byollm` and `modules/byollm`, the pin plus its two
     migrations (R3), at this step. R3's feature work comes later.
3. **Publish `0.1.5`** (dist-tag `latest`). Same wire as the beta, so the
   servers on the beta accept it. The three servers then move to the clean
   pin at their next deploy.
4. **Manifests.** Todd updates the byollm.cloud manifest of record by hand,
   as today. New slots start unmapped, and people get the mapping
   notification (Amendment L's rider).
5. **Daemons upgrade when it suits their owners.** Nothing new is on until
   an owner adds a kind to a service.
6. **Sites declare the new kinds**, Press first (R3).

**The cut line, as #6756 ruled it, word for word:** *"if tools have not
passed review by 2026-12-01, 0.1.5 ships with images and the held fixes."*
"Passed review" means R8's tool cards (2, 3 and 4) are approved, each with
its MUTATIONS.md rows. If they are not by that date, `llm.tools` comes out of
the beta's `JobKind` before step 3, and tools ship in the next release. Images
do not wait for tools, and nothing in this rollout lets tools ship ahead of
images.

| pair | what happens |
|---|---|
| 0.1.4 daemon, 0.1.5 hub | Nothing changes. It never advertises a new kind and is never offered one. A person whose only devices are on 0.1.4 sees the new slot as "nothing of yours can use the site's tools yet — update byollm on <device> (0.1.4)". It never receives a grant carrying `toolsDigest`, because grants carry it only for `llm.tools`, which it never claims. The hub knows the version from `daemonVersion` on the device's requests, so the hub composes the fix (byollm_013's rule). |
| 0.1.5 daemon, 0.1.5 hub | Everything ruled. |
| 0.1.5 daemon, **0.1.4 upstream** (none of ours, after step 2; somebody else's self-hosted `@byollm/server`) | **The danger case.** Step 2 means it never happens against a server we run. It still happens against other people's, so the daemon guards it. `Capability.kind` is an enum, and a 0.1.4 upstream parses the heartbeat strictly. One new kind in the advertisement and the whole heartbeat is refused, so the device goes dark for *everything*, not only the new kind. Two guards. (a) New kinds are off by default, so a plain upgrade advertises nothing new. (b) The daemon must never let a new kind take the device down, and must not blame the upstream's version for a refusal the new kind did not cause. A 0.1.4 upstream's refusal does not say which field failed: the relay and the reference server both answer `400 bad-request` with a fixed message ("request failed schema validation" in `relay/src/daemon-plane.ts`, "request body failed schema validation" in `server/src/handlers.ts`) that names no path. So the daemon tells the two cases apart by a differential retry instead of by reading the body. When a heartbeat that advertises a 0.1.5 kind is refused as `bad-request`, the daemon re-sends the same heartbeat once, with only the 0.1.5 kinds removed. **Only if that retry succeeds** does it remember, for the session, that this upstream predates them, and say so: "<upstream> runs byollm 0.1.4 or older and cannot carry the site's tools — update it, or turn tools off for `qwen`". If the retry is refused too, the new kinds were not the cause. The daemon reports the original refusal as it does today, and blames no version. The hub cannot warn the daemon with a new response field, because B019 is the same hazard in the other direction. A 0.1.5 upstream may name the failing path inside the existing `message` string, which adds no key, but the daemon must not depend on that, because 0.1.4 upstreams never will. **Guard (b) has a check, C060:** the kit runs the 0.1.4 reference server, published from npm, and a 0.1.5 daemon with `llm.tools` and `llm.vision` turned on. It passes when the daemon's second heartbeat succeeds without the new kinds, `llm.chat` jobs keep running, and the message names the upstream. The mutation that must fail it is "re-send unchanged". A second case gives the 0.1.4 server a heartbeat that is malformed for another reason, and passes when the daemon blames no version. |
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
What the gate cannot reach is a `@byollm/server` still on 0.1.4. For Signals
and Press, step 2 is what covers that. For everyone else's, guard (b) and
C060 do.

### R3. What `@oftomorrow/byollm` (Press) needs

- Pin `@byollm/*` to exactly `0.1.5-beta.1` at R2 step 2, then `0.1.5`.
  `docs/schema-lock.md` says to pin exactly. The pin bump is its own card and
  lands before the release, so that Press is never a 0.1.4 upstream for a
  0.1.5 daemon. The feature work below is a later card.
- **Press hosts one tool, `web_search`,** as a handler registered with the
  site SDK. It runs on Press's own search key, with Press's cache and rate
  limits, and authorises each call as the job's user (byollm_012 §6).
- **`llmSearch` becomes a thin wrapper over `llm` with `llm.tools`** and
  that one tool, which is what its docstring has been promising. It goes to
  the runner first. When no device can serve it, it takes Press's existing
  labelled API path (`FALLBACK_LABELED`), as `llm` does today.
- **`SearchAnswer.searches` stays what its docstring says**: "How many
  searches the model actually ran". The fact checker shows it to the author.
  It must not come from `RunMetadata.toolCalls`, which counts every call the
  model made, including calls the daemon refused and calls that timed out.
  Press runs the tool itself, so it already knows the true number: the
  wrapper counts the `web_search` handler runs for that job that returned a
  result, and reports that. With that, "every caller stays as written" holds.
- **The pump does not die with the request** (byollm_012 §5.3). The
  fact-checker's routes are already at `maxDuration = 300`, the platform's
  maximum, so a longer route timeout is not available. Press does both
  things the SDK offers:
  - the waiting request keeps turning the pump, as `pumpWhileWaiting` does
    today, and the pump now answers tool calls as well;
  - a scheduled job, beside the drain that already runs on a schedule,
    keeps cycling the pump while `toolJobsInFlight()` is true, so a call
    made after the waiting request ended is still answered.

  And the drain takes at most one `llm.tools` unit per invocation, so one
  invocation's 300 seconds cover that job's round trips.
- **A verdict reached without a search says so.** The fact checker already
  treats `searches: 0` as a verdict from memory. With `searches` counted
  from Press's own handler runs (above), a job whose every call timed out
  reports 0, and `toolOutcomes.timedOut` is shown in the run's details.
- `PURPOSES["fact-checker"]` gains `"llm.tools"` in `kinds`, the
  `web_search` declaration in `tools`, and its limits: `maxToolCalls` 8 and
  a `maxToolResultChars` sized to its searches (the build card measures a
  typical verification and picks it). No purpose gains an image kind unless
  its owner asks (§0).
- **Two migrations, each with its twin** (CW's finding 7). Press's store runs
  on the Supabase adapter's SQL, so the blob bucket migration and the
  tool-call table migration (R1) are vendored into
  `modules/byollm/migrations` **at the end of the folder**, because
  `register` numbers module migrations by sorted position. Each gets its twin
  in `supabase/migrations`, as the existing byollm ones do
  (`0106_adopted_leases_are_not_ours.sql` ↔
  `20003013_byollm_adopted_leases_are_not_ours.sql`), because since #6824
  `pnpm test` refuses an app migration with no twin. They are pushed with
  `--include-all`, at the pin card (R2 step 2). Earwax takes the same pin
  bump and migrations when it wants, and needs no kind change.

### R4. What the byollm.cloud manifest needs

Press's manifest of record gains `llm.tools` on Fact Checker, with its
`web_search` declaration and its two limits, and the hub's manifest
validation accepts the new kinds and the three `Purpose` fields (step 2). The
purpose's own description does not change. The tools line under it is built
from the declarations (byollm_012 §10), and the digest of those same
declarations is what the device checks, so the consent screen and the device
cannot disagree about which tools exist.

**The site's code and the manifest of record can disagree, and that is
caught at enqueue** (byollm_012 §4, check C047). Press's `PURPOSES` is
typed in code and the manifest of record is registered by hand. If they
differ, the hub refuses each `llm.tools` enqueue as
`tools-manifest-mismatch`, with the purpose named, before any device
claims anything. So the manifest update and Press's feature card (R8 card
11) land together: Todd registers the new manifest, then the feature card
deploys. A copy edit to a tool description later is a changed consent
(byollm_012 §4), so it is a decision, not a typo fix.

### R5. Docs

**The public "no tools" statements, as #6756 ruled them, line by line.**
The docs card carries this list and a check that the surfaces agree. Each
line is quoted as it reads on origin/main today, with what it becomes.

| where | today | what it becomes |
|---|---|---|
| `docs/protocol.md:470` | "The daemon exposes no tools, functions, retrieval, or MCP to the model. A kind that needs tools is a new kind with its own spec and threat review, not a payload flag." | byollm_012 §12's amended byollm_004 §2 sentence, word for word |
| `docs/protocol.md:481` | "the guarantee here is bounded precisely because the model has no tools and the output is inert" | "…bounded precisely because nothing the model says runs on the device: its output is inert, and a call to a site's tool is sealed to that site and run there" |
| `docs/security.md:27` | "the model has no tools, no retrieval and no MCP, and its output is inert bytes" | "the model has no tools that run on your device, no retrieval and no MCP. A site's own tools run on the site (byollm_012), and the model's output is inert bytes" |
| `docs/security.md:198` | "having no tools and no file surface outside the scratch directory" | unchanged. It is about `process` backends, which serve neither new kind in this release (byollm_012 §7, §6 above). The docs card says so beside it, so the next reader does not think it was missed |
| the oftomorrow.net launch post (B357) | "no tool use" | a published post is not a surface `NOT_YET`'s test reads, so this is a by-hand edit named in the docs card: a dated addendum saying what 0.1.5 changed |
| byo-llm.com | the `NOT_YET` list | rendered from `NOT_YET`; its test catches it |

Also in the docs card:

- `docs/security.md`: byollm_012 §13's sentence word for word, what a site
  takes on when it declares a tool (byollm_012 §6), image inertness and blob
  encryption.
- `docs/protocol.md`: the new kinds, the tool envelopes and endpoints,
  `BlobRef`, and the blob endpoints with their deletion order.
- byollm.cloud `/privacy`: images are stored encrypted for the life of a job
  and deleted once the site holds its output, or at most a day after the
  job's deadline. This lands with #4556's deletion sentence, which already
  rides with the 0.1.5 web deploy.
- A site guide for tools: declaring them and their limits, writing a
  handler, and what the round trips cost on each lane. It says, with an
  example, that **on any purpose a teammate can serve, a tool is scoped to
  the job, not the user**: it returns only what the site would have put in
  that job's payload (byollm_012 §6). It also says how to keep the pump
  turning while tool jobs run (byollm_012 §5.3).
- `docs/schema-lock.md`: whether the new payload shapes are inside the lock.
  The recommendation is yes, beside the envelope.
- README and byollm.cloud: `NOT_YET` renders the updated list on every
  surface. Its test catches any surface that disagrees.
- `docs/roadmap.md` and `packages/daemon/README.md` repeat "no tools" in the
  same sense (`roadmap.md:22`, `:29`, `:91`; daemon README `:240`, `:245`).
  They are not on the ruled list, and they get the same rewrite.

### R6. The release note

`docs/release-notes/0.1.5.md` keeps its two paragraphs and gains these,
with the headline rewritten:

> **0.1.5 — Site tools, images, and two fixes.**
>
> `PROTOCOL_VERSION` is still `2`. **Update your hub or server first.** A
> daemon on 0.1.5 works with a 0.1.4 upstream until you turn on one of the
> new kinds, and if the upstream is older, it tells you and keeps serving
> everything else. A 0.1.4 daemon works with a 0.1.5 hub and never sees the
> new kinds. **There are two migrations** if you run the Supabase adapter:
> the private Storage bucket for images, and the table that holds site-tool
> calls in flight. If you wrote your own store adapter, it needs `putBlob`,
> `getBlob`, `deleteBlob` and the tool-call methods.
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
> **Images.** `llm.vision` reads images and `llm.image` makes them, on
> local and HTTP models, up to 20 MiB an image and eight to a job. Images
> travel by reference, encrypted with a key only the job's two ends hold,
> and are deleted once the site has its output. A teammate's images are
> budgeted before your device downloads them (`community.maxImageBytes`,
> 16 MiB a job by default). (byollm_021)

### R7. #5743 rides along (#6214)

23102a5 (#5743: a teammate's large job is admitted by its size class's
floor) is already on main under 0.1.5's bump (70b005d). Owl's red team on
#6214 named two things a ruling should say. This rollout gives each of them
an answer for Todd to accept or change:

- **Fetch, then refuse (red team point 3).** Admitting by the floor means a
  device fetches and opens a non-owner's payload before it can refuse it.
  That trade was accepted by Owl, not Todd. §3 of this spec makes the same
  trade for images and bounds it: the sealed payload may be fetched, blobs
  may not. **The sentence, as #55220 carries it for the ruling:** "A device
  may fetch and open a non-owner's sealed payload before refusing it on
  size; it never downloads that job's blobs before the budget check."
- **#5744's unblock condition has no reader (point 4).** Step 2 puts the hub
  on 0.1.5 with device versions in view, which is the reader #5744's
  condition needs ("the hub shows every teammate-reachable device on it").
  The hub build card names #5744 so that whoever lands it unblocks it.

The 0.1.5 note's current line, "A daemon on 0.1.5 talks to a hub or relay on
0.1.0 through 0.1.4, and the other way round", stops being true without
qualification and is replaced by R6's paragraph.

### R8. Build cards, after the ruling

Filed only after Todd rules, each naming the ruling, on the ot.byollm lane
unless it says otherwise. CCB builds, as #6756 ruled. Kevin reviews where
Press is touched. byollm_012 v1 has no address-policy code, so #6756's
"named second author for ssrf-shaped code" has nothing to attach to in this
release. It applies again if daemon-run tools (byollm_012 §11.1) are ever
specced.

1. **Protocol:** kinds, schemas, `Purpose.tools` and its budget, the
   grant's `toolsDigest`, the tool envelope directions, `BlobRef` and the
   caps, labels, `NOT_YET`, registry entries and spec tables.
2. **Relay and reference server, tools:** the four endpoints, the
   `waiting-on-site` sub-state, the relay's per-job count, the direct lane's
   store rows for calls in flight, and the Supabase SQL for them.
3. **Daemon, tools:** the function-calling loop on `http` backends, the
   digest check at admission, the context cap, the waits and timeouts,
   budgets, logging, the probe, and guard (b) with C060.
4. **Site SDK, tools:** handler registration, the pump's `calls` step, the
   SDK's per-job count, the digest check at enqueue, and the 404 tolerance
   for an older relay.
5. **Blobs:** store methods, the reference server endpoints with §2's
   deletion order, the Supabase SQL for the bucket, and the site SDK's
   encrypt, pad, strip, upload, verify and `received`.
6. **Daemon, images:** vision parts and image generation on `http`
   backends, the probes, `community.maxImageBytes`, and C058's check that
   neither kind is ever advertised on a `process` backend.
7. **By hand, Todd's** (rulebook §1): the R2 bucket, its 7-day lifecycle rule
   and the access key for presigning, with the commands, on Todd's lane.
8. **Release, beta:** a new card, not #4265 (R2 step 1). It publishes
   `0.1.5-beta.1` and carries the three-OS run.
9. **Servers on the beta** (R2 step 2), each its own card:
   - the hub (byollm-cloud: enum acceptance, the relay's tool endpoints,
     `toolsDigest` in grants and re-consent on a changed tool list, the blob
     endpoints, presigning, the `HEAD` before offer and the sweep, consent
     lines, the version-aware "update your device" slot text, and #5744's
     reader). Its brief carries `by-hand: machine — card 7 (R2 bucket,
     lifecycle rule and key)`, so it waits for that card;
   - Signals' pin (on the signals lane);
   - Press's pin and its two migrations with their twins (on Kevin's lane).
10. **Release, clean:** publishes `0.1.5`, the note (R6), the changelog and
    the docs (R5), after card 9's three are deployed. It applies the cut
    line first.
11. **Press, features:** R3, after 10.

Cards 2–4 and 5–6 can run in parallel once 1 is on main. Card 7 can run any
time. The hub's work in card 9 can start once 1 is on main, and deploys on
the beta once card 7 is done. Nothing reaches `latest` until every server we
run is on the beta.

**CW edits `cw/RULEBOOK.md` §2** to the ruled wording: "adding a blob path —
exists since #6933 (11-03), by reference only, never inline; a change to it
takes the two steps above". That is CW's edit, not a byollm card.

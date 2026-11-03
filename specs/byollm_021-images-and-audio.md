# byollm_021 — Images in and out; audio as a named future

**Status: for ruling. Written 2026-11-02 and revised 2026-11-03 by Kevin
Samsoe for decision #6933 (card #6758), beside byollm_012 v1. Nothing here is
built, and under rule 34 nothing in this repo changes until Todd has read it
and ruled. The red team and CW review on #6933.**
**Read with: #6756's ruling as written out at #54358, `MAX_ENVELOPE_BYTES`
in `packages/protocol/src/job.ts` (the 09-10 ruling), byollm_009 §6 and §12,
byollm_013, byollm_016 Amendment L.**
**§Rollout at the end covers this spec and byollm_012 together.**

**What changed on 2026-11-03.** The first version carried image bytes by
reference, as encrypted blobs in R2 on the hub. #6756's ruling struck that:
*"'hub-stored' image bytes (a blob path, forbidden by the rulebook)"*, and
adopted CW's *"image input is inline (counted against the payload size
class) or nothing"*. It also ruled image input HTTP-backend-only and
`claude-cli`'s and `codex-cli`'s containment untouched. This version follows
that ruling. It is later than Todd's 09-10 line ("We will add R2 for
multimodal later"), and this spec reads the later ruling as the one that
stands. Object storage stays the named path for anything bigger, in its own
spec and its own two steps (§2).

## What Todd is asked to rule

1. **Image input (`llm.vision`) and image output (`llm.image`)**, as two
   decisions. Both carry their bytes the same way, inline.
2. **Inline, inside the sealed envelope** (§2–§3), counted against the
   payload's size class, and within `MAX_ENVELOPE_BYTES`. No blob path, no
   store change, no migration. This is #6756's ruling applied, and the cost
   is named: about 4 MiB of image per job.
3. **HTTP backends only** (§6), as #6756 ruled. The CLI rows are struck.
4. **Audio** (§9): a named future, with its shape recorded so that nothing
   built now gets in its way. "Audio", not "voice", because byollm_016
   already uses "voice" for an owner's tuned service.
5. **The rollout** (§Rollout): one gathered 0.1.5 with byollm_012, every
   server we run upgraded before any daemon gets 0.1.5, the cut line #6756
   ruled, and #5743 riding along under #6214.

## 0. Where this starts

- **#6756, ruled 2026-11-02** (Todd's "Yes, with the clarifications from CW
  and Owl", written out at #54358). Image input is inline or nothing. Tools
  and image input are HTTP-backend-only in this release. Every server we run
  upgrades before any 0.1.5 daemon ships.
- **Todd, 2026-09-10**, recorded on `MAX_ENVELOPE_BYTES`: *"6 MB solves for
  just text and people don't try to push images. We will add R2 for
  multimodal later."* The docstring explains that the cap is a shape
  decision: the envelope is the wrong tool for a large photo. This spec
  keeps that true by keeping images small, not by adding the other tool.
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
screen, its own offer scope per service, and its own byollm_013 probe, and
it needs no new field in the stub.

**`llm.vision`: "Reading images".** The payload is `llm.chat`'s, except that
a `user` message's `content` may be a list of parts instead of a string:

```
{ type: "text",  text: string }
{ type: "image", mediaType: "image/png" | "image/jpeg" | "image/webp",
                 data: string }          // base64 of the image bytes
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
prompt where it returns one) and `images`: a list of `{ mediaType, data }`,
inline, like the input parts.

**Not in this spec:** editing an image (image in and image out in one job),
images in `llm.tools`, and images in `llm.generate`. Each is a later kind
if someone needs it.

## 2. Where the bytes go: inline, sealed, nowhere else

**Image bytes travel only inside the sealed payload or the sealed result.**
They are signed and sealed with everything else (`ENVELOPE_SEALED_AND_SIGNED`),
so `RELAY_BLIND` covers them with no new mechanism. The relay holds them for
as long as it holds any envelope, and stores nothing else. There is no blob
store, no upload slot, no presigned URL, no deletion sweep and no migration.

**What that costs.** `MAX_ENVELOPE_BYTES` is 6 MiB, and base64 adds a third.
So a job carries about 4 MiB of image in total, in or out (§3). That is
enough for what vision models actually read: they resample large images
down, typically to around 1,500–2,000 pixels on the long side, so a phone
photo resized to 2,048 pixels as JPEG (a few hundred KiB) loses nothing the
model would have used. The site SDK resizes and re-encodes before sealing,
by default, and an app can turn that off only to send something smaller.

**What it rules out.** A full-resolution photo, a scan at print resolution,
or a long document as page images. Those need object storage and a reference,
which is Todd's 09-10 path. If someone needs them, that is its own spec,
taking the rulebook's two steps for a blob path, not a rider on this one.

## 3. Size class and caps

**Image data counts against the payload's size class**, as #6756 ruled.
`payloadTextLength` for `llm.vision` counts every text part plus the length of
every image's base64 `data`, and the site computes `sizeClass` from that, as
it does today. An image job is therefore almost always `large` (more than
64,000 characters is about 47 KiB of image). The enum gains no value and the
stub gains no field (`STUB_METADATA_EXHAUSTIVE` is untouched).

| value | constant | why |
|---|---|---|
| 4 MiB of image bytes per job, in or out, before base64 | `MAX_IMAGE_BYTES_PER_JOB` | what fits in a 6 MiB envelope with base64 and room for the text |
| 8 per `llm.vision` job | `MAX_IMAGES_IN` | several pages or screenshots; more is a batch, which is several jobs |
| 4 per `llm.image` job | `MAX_IMAGES_OUT` | the `count` ceiling |
| 8,192 px a side, 40 megapixels | `MAX_IMAGE_SIDE`, `MAX_IMAGE_PIXELS` | a small PNG can decode to gigabytes; this refuses decompression bombs from the header |

(The value comes first because `musts-match-specs.test.ts` reads any table
row that starts with a backticked SCREAMING_CASE id as a declared MUST.)

**A teammate's images use the budget a teammate's text already uses.** The
daemon's `community.maxPayloadChars` (default 100,000) applies to every
non-owner job, images included, because image data is counted as payload.
There is no separate image budget. Two consequences, both named:

- **By default, most teammates' image jobs are refused**, because 100,000
  characters is about 73 KiB of image. An owner who offers `llm.vision` to
  `team` raises `community.maxPayloadChars`. When they turn on `team` for
  `llm.vision` with the default still in place, `byollm` says so, and names
  the setting and the size a typical image job needs (byollm_013's rule).
- **Fetch, then refuse, now costs megabytes.** Since 23102a5 (#5743), a
  device admits a `large` job by its class's floor (64,001), fetches it, and
  refuses it on its actual size. With images, that fetch can be up to
  `MAX_ENVELOPE_BYTES`. It is bounded, and §Rollout R7 asks Todd to rule the
  trade in one sentence. An owner who does not want any of it does not offer
  `llm.vision` to `team`: offer scope is per kind.

**Output** counts against nothing on the device. It is bounded by
`MAX_IMAGE_BYTES_PER_JOB`. The daemon asks backends for JPEG or WebP where
they allow it, and a result whose images total more than the cap ends as an
error that names the cap ("4 images at this size do not fit; ask for fewer").
The daemon never re-encodes an image to make it fit, because re-encoding is
decoding, and decoding untrusted images is a surface the daemon does not
take on.

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
  bytes through unchanged. The site SDK strips EXIF while it resizes, by
  default, and the docs say why: a phone photo carries where it was taken,
  and a teammate's device should not learn that.
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
payload budget (§3). An image does nothing on the device. It is data handed
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
- **Inline, like images, and therefore short.** The parts take the same
  `{ mediaType, data }` shape with audio types per kind. Formats in: WAV,
  MP3, M4A/AAC, Ogg Opus, FLAC, WebM. Out: MP3, WAV, Opus. About 4 MiB per
  job is a few minutes of compressed speech. Anything longer, such as a
  chapter of an audiobook, needs object storage, which is the same
  separate spec §2 names.
- **Backends:** `/v1/audio/transcriptions` (whisper.cpp server,
  faster-whisper-server, LocalAI, OpenAI, Groq) and `/v1/audio/speech`
  (OpenAI, LocalAI, Kokoro-FastAPI), all HTTP.

**Why it waits:**

- **No integrator has asked through byollm.** Earwax, an audiobook studio,
  is the obvious first one for `audio.speak`, and its chapters are longer
  than an inline envelope holds. This spec does not claim it needs audio.
  Whoever owns earwax says so, and that is the evidence 016's
  evidence-gating asks for.
- **Live audio needs streaming**, which is byollm_006 and is parked. Only
  file-in, file-out audio fits the job model as it is.
- **A cloned voice is a person's likeness.** `audio.speak` on a
  teammate's device, in the owner's own cloned voice, for a site the owner
  never used, raises a consent question that `offer: "team"` does not
  answer. It needs its own sentence before it needs code.

## 10. Proposed MUSTs and their checks

These are in bold rather than registry rows, for the reason byollm_012 §12
gives.

- **IMAGES_INLINE_ONLY**: image bytes travel only inside a sealed, signed
  payload or result envelope, counted in the payload's size class and within
  `MAX_ENVELOPE_BYTES`. No other path carries them, and no upstream stores
  them beyond the envelope's own life. Conformance and operator.
- **MEDIA_VERIFIED**: declared type matches the magic bytes, and the
  dimensions are within the caps, checked at both endpoints before a backend
  or an app sees the bytes. Conformance and adversarial.
- **IMAGE_BYTES_NOT_URLS**: a daemon never fetches a URL a backend returned
  in place of image bytes. Adversarial.
- **`KIND_NO_CODE`, `OUTPUT_INERT` and the CLI containment** are unchanged,
  and the image kinds are never advertised on a `process` backend. Daemon;
  conformance (check 6).

| # | proposed id | what it does | passes when | mutation that must fail it |
|---|---|---|---|---|
| 1 | C057 images sealed | the kit reads the relay's whole state during and after an image job | no plaintext image bytes anywhere | carry the image beside the envelope |
| 2 | C058 images count toward size | a vision payload with a 200 KiB image and ten characters of text | the site SDK classes it `large`, and a teammate's device whose `community.maxPayloadChars` is below 64,001 refuses it at the stub, before fetching | count text parts only |
| 3 | C059 media verified | PNG declared over JPEG bytes; an SVG; a 50,000 × 50,000 PNG header | each one refused; backend saw nothing | trust the declared type |
| 4 | C060 a teammate's images meet the payload budget | a teammate's vision job of 300,000 characters against the default `community.maxPayloadChars` | refused on size; the backend saw nothing | exempt image data from the budget |
| 5 | C061 output fits or fails | an image backend returning four 2 MiB PNGs | the job errors naming the cap; nothing is truncated or re-encoded | re-encode to fit |
| 6 | C062 no images on a process backend | a `claude-cli` service listing `llm.vision` | `llm.vision` not advertised; `backends` says the kind needs an HTTP backend | advertise it |
| 7 | C064 vision is detected | an echo backend that ignores images and answers "blue" | `llm.vision` not advertised; `backends` says why | probe for a 200 only |
| 8 | C065 image bytes, not URLs | an image backend that answers with a URL | job errors; no fetch made | follow the URL |

(byollm_012's checks are C033–C045. C063 and C069 are retired with the blob
path. C066 is the daemon's differential heartbeat retry, in §Rollout R2.)

## 11. Done when

- `llm.vision` and `llm.image` (whichever are ruled) exist in
  `@byollm/protocol`, with the inline parts, the caps, `payloadTextLength`
  counting image data, and the kind labels.
- §10's checks pass and are recorded in MUTATIONS.md.
- The backends in §6 marked "yes" pass their probes on a real machine.
- `claude-cli`'s and `codex-cli`'s containment files and tests are
  unchanged, which the release card checks by diff.
- The site SDK resizes, re-encodes, strips EXIF and verifies output, and
  `byollm` warns an owner whose payload budget refuses typical teammate
  image jobs.
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
- For tools: `Purpose.tools` in the manifest; `toolsDigest` on grants for
  `llm.tools` only; the `tool-call` and `tool-result` envelope directions;
  four endpoints, `tool-call` and `tool-results` on the daemon plane and
  `calls` and `tool-result` on the site plane, served by the relay and by
  `@byollm/server` alike; and the site SDK's tool handlers in the pump.
- For images: the inline `{ mediaType, data }` parts, the caps, and
  `payloadTextLength` counting image data. No endpoint, store method or
  migration for images.
- Tool calls and results in flight need a store on the direct lane:
  `@byollm/server`'s store adapter gains a short-lived row per call, deleted
  with its job, and the Supabase SQL gains that table. This is the release's
  one migration, and it is tools', not images'.
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
   anything else:
   - **the hub**: relay, control plane and the dashboard's consent screen.
     The control plane signs `toolsDigest` into `llm.tools` grants and
     re-asks a person when a purpose's tools change. The tools slot's
     pulldown lists services with tools on, own and team. The kind labels
     and both specs' disclosure lines go live;
   - **Signals**: `signals/package.json` and `apps/web/package.json`, which
     needs no kind change, only the pin, so that its chat keeps working for a
     device that turns a new kind on;
   - **Press**: `packages/byollm` and `modules/byollm`, with the pin only at
     this step (R3's feature work comes later).
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
| 0.1.5 daemon, **0.1.4 upstream** (none of ours, after step 2; somebody else's self-hosted `@byollm/server`) | **The danger case.** Step 2 means it never happens against a server we run. It still happens against other people's, so the daemon guards it. `Capability.kind` is an enum, and a 0.1.4 upstream parses the heartbeat strictly. One new kind in the advertisement and the whole heartbeat is refused, so the device goes dark for *everything*, not only the new kind. Two guards. (a) New kinds are off by default, so a plain upgrade advertises nothing new. (b) The daemon must never let a new kind take the device down, and must not blame the upstream's version for a refusal the new kind did not cause. A 0.1.4 upstream's refusal does not say which field failed: the relay and the reference server both answer `400 bad-request` with a fixed message ("request failed schema validation" in `relay/src/daemon-plane.ts`, "request body failed schema validation" in `server/src/handlers.ts`) that names no path. So the daemon tells the two cases apart by a differential retry instead of by reading the body. When a heartbeat that advertises a 0.1.5 kind is refused as `bad-request`, the daemon re-sends the same heartbeat once, with only the 0.1.5 kinds removed. **Only if that retry succeeds** does it remember, for the session, that this upstream predates them, and say so: "<upstream> runs byollm 0.1.4 or older and cannot carry the site's tools — update it, or turn tools off for `qwen`". If the retry is refused too, the new kinds were not the cause. The daemon reports the original refusal as it does today, and blames no version. The hub cannot warn the daemon with a new response field, because B019 is the same hazard in the other direction. A 0.1.5 upstream may name the failing path inside the existing `message` string, which adds no key, but the daemon must not depend on that, because 0.1.4 upstreams never will. **Guard (b) has a check, C066:** the kit runs the 0.1.4 reference server, published from npm, and a 0.1.5 daemon with `llm.tools` and `llm.vision` turned on. It passes when the daemon's second heartbeat succeeds without the new kinds, `llm.chat` jobs keep running, and the message names the upstream. The mutation that must fail it is "re-send unchanged". A second case gives the 0.1.4 server a heartbeat that is malformed for another reason, and passes when the daemon blames no version. |
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
C066 do.

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
- **The waiting request keeps the pump turning**, as it does today
  (`pumpWhileWaiting`), and the pump now answers tool calls as well. A
  verification job that makes several calls keeps its request open for
  longer, so the route's timeout has to cover the round trips (byollm_012
  §5.3).
- `PURPOSES["fact-checker"]` gains `"llm.tools"` in `kinds` and the
  `web_search` declaration in `tools`. No purpose gains an image kind unless
  its owner asks (§0).
- If Press's store runs on the Supabase adapter's SQL, the tool-call table
  migration (R1) is vendored into `modules/byollm/migrations` **at the end of
  the folder**, because `register` numbers module migrations by sorted
  position, and pushed with `--include-all`. Earwax takes the same pin bump
  when it wants and needs no kind change.

### R4. What the byollm.cloud manifest needs

Press's manifest of record gains `llm.tools` on Fact Checker, with its
`web_search` declaration, and the hub's manifest validation accepts the new
kinds and `Purpose.tools` (step 2). The purpose's own description does not
change. The tools line under it is built from the declarations (byollm_012
§10), and the digest of those same declarations is what the device checks,
so the consent screen and the device cannot disagree about which tools
exist.

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
  takes on when it declares a tool (byollm_012 §6), and image inertness.
- `docs/protocol.md`: the new kinds, the tool envelopes and endpoints, and
  the inline image parts.
- A site guide for tools: declaring them, writing a handler, authorising as
  the job's user, and what the round trips cost on each lane.
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
> new kinds. **There is a migration** if you run the Supabase adapter: the
> table that holds site-tool calls in flight. If you wrote your own store
> adapter, it needs the tool-call methods.
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
> local and HTTP models. Images travel inside the sealed job like its text,
> up to about 4 MiB a job, and nothing stores them. A teammate's image job
> counts against the payload budget you already set for teammates.
> (byollm_021)

### R7. #5743 rides along (#6214)

23102a5 (#5743: a teammate's large job is admitted by its size class's
floor) is already on main under 0.1.5's bump (70b005d). Owl's red team on
#6214 named two things a ruling should say. This rollout gives each of them
an answer for Todd to accept or change:

- **Fetch, then refuse (red team point 3).** Admitting by the floor means a
  device fetches and opens a non-owner's payload before it can refuse it.
  That trade was accepted by Owl, not Todd. With images inline (§3) it
  costs more: up to `MAX_ENVELOPE_BYTES` per refused job, not kilobytes.
  **Proposed, for Todd to rule in one sentence with this spec:** "A device
  may fetch and open a non-owner's sealed payload, up to
  `MAX_ENVELOPE_BYTES`, before refusing it on size; an owner who does not
  want that for images does not offer `llm.vision` to `team`."
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

1. **Protocol:** kinds, schemas, `Purpose.tools`, the grant's
   `toolsDigest`, the tool envelope directions, the inline image parts and
   `payloadTextLength`, labels, `NOT_YET`, registry entries and spec tables.
2. **Relay and reference server, tools:** the four endpoints, the
   `waiting-on-site` sub-state, the relay's per-job count, the direct lane's
   store rows for calls in flight, and the Supabase SQL for them.
3. **Daemon, tools:** the function-calling loop on `http` backends, the
   digest check at admission, the waits and timeouts, budgets, logging, the
   probe, and guard (b) with C066.
4. **Site SDK, tools:** handler registration, the pump's `calls` step, the
   SDK's per-job count, and the 404 tolerance for an older relay.
5. **Site SDK, images:** resize, re-encode, strip EXIF, and verify output.
6. **Daemon, images:** vision parts and image generation on `http`
   backends, the probes, the payload-budget warning, and C062's check that
   neither kind is ever advertised on a `process` backend.
7. **Release, beta:** a new card, not #4265 (R2 step 1). It publishes
   `0.1.5-beta.1` and carries the three-OS run.
8. **Servers on the beta** (R2 step 2), in this order, each its own card:
   the hub (byollm-cloud: enum acceptance, the relay's tool endpoints,
   `toolsDigest` in grants and re-consent on a changed tool list, consent
   lines, the version-aware "update your device" slot text, and #5744's
   reader); Signals' pin (on the signals lane); Press's pin (on Kevin's
   lane).
9. **Release, clean:** publishes `0.1.5`, the note (R6), the changelog and
   the docs (R5), after card 8's three are deployed. It applies the cut line
   first.
10. **Press, features:** R3, after 9.

Cards 2–4 and 5–6 can run in parallel once 1 is on main. The hub's work in
card 8 can start once 1 is on main and deploys on the beta. Nothing reaches
`latest` until every server we run is on the beta.

There is no R2 bucket, lifecycle rule or access key to provision, since
images are inline (§2). Owl's #54857 point 8 falls away with the blob path.

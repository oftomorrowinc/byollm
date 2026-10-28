---
"@byollm/protocol": patch
"byollm": patch
---

A teammate's job declared `large` now runs when your
`community.maxPayloadChars` can hold it. Admission charged the size class's
ceiling, which for `large` is unbounded, so every such job was refused before
it was fetched at any limit you could set (#5738). Admission now charges the
class's floor — `sizeClassFloor`, new in `@byollm/protocol`: small 0, medium
4,001, large 64,001 — and refuses only what cannot fit; the opened payload is
still measured against your limit before any backend runs. A limit between a
class's floor and ceiling now downloads such a job and refuses it after
measuring. Streamed (`unbounded`) community jobs are still refused, now in
words rather than "Infinity".

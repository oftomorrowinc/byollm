# Dependencies, and why each one is here

The standard is dependency minimalism: every runtime dep justified here, and
zero-dep preferred where the platform provides. The daemon in particular must
install fast on a stranger's laptop — that is the five-minute promise in
byollm_002's "Done when".

## Runtime dependencies

| Package | Used by                        | Why                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zod`   | `protocol`, `server`, `daemon` | The wire boundary needs runtime validation, not just types: every payload is hostile input, and `strict()` parsing is the first line of `NO_PAYLOAD_ROUTING` — an unknown key becomes a parse failure rather than something ignored deeper in. Hand-rolling this for five endpoints plus config files would be more code and less trustworthy. One dependency, shared by all three packages. |

That is the whole list.

### What we deliberately did not add

- **No HTTP client.** `fetch` is in Node ≥18 and gives us `AbortSignal`,
  streaming reads (needed for the output cap) and `redirect: "error"` (needed
  for `HTTP_BASE_URL_SAFE`) for free.
- **No CLI framework.** The daemon's command surface is a `switch` over
  `process.argv`. A framework would be larger than the thing it parses.
- **No colour/spinner library.** Output is plain text an owner can pipe. The
  one place formatting matters — untrusted text reaching a terminal — needs
  control characters _removed_, not added.
- **No logger.** The ingress log is JSONL written with `appendFile`. It is the
  product's trust surface, so its format is ours to guarantee.
- **No uuid package.** `node:crypto` has `randomUUID` and `randomBytes`.
- **No test-only HTTP server.** `node:http` for the adversarial suite's probe
  server; the conformance kit drives handlers in-process.

### Peer, optional

| Package                 | Used by                  | Why                                                                                                                    |
| ----------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `@supabase/supabase-js` | `server` (optional peer) | Only the Supabase adapter needs it. Optional so an app using the in-memory store or its own adapter never installs it. |

## Toolchain notes

**TypeScript is pinned to 5.9, not 7.x.** TypeScript 7 is released, but
`typescript-eslint` still declares `typescript: ">=4.8.4 <6.1.0"`, so adopting
it today means dropping type-aware linting — a worse trade than lagging one
major. Revisit when `typescript-eslint` supports it.

**`lib` is `ES2024`** for `Promise.withResolvers`, used by the Supabase
Realtime delivery channel where the resolver is called from a subscription
callback rather than from inside the promise executor.

**Node ≥22.12.** Node 20 reached end of life in April 2026. 22 is the current
LTS line and has native `fetch`, `AbortSignal.any` and stable test tooling.

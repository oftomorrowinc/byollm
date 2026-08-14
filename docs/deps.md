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

### Decided, not yet added: `effect`

**Scope decided 2026-08-13, adopted with byollm_009. Not a dependency
today.** Recorded here so the scope is a decision rather than something
settled implicitly by whoever writes the first file that needs it.

The prompt was a crash class, not a preference. The Supabase delivery
channel discarded three promises with `void`; each turned an ordinary
failure — a transient store read, an app's own fallback throwing — into a
dead process, because an unhandled rejection ends Node. It survived review
because `no-floating-promises` was configured to permit exactly that
spelling. We fixed the instances and tightened the rule, and the rule is
still a lint: a thing that can be configured off, and was.

Effect makes the class **unrepresentable rather than lintable**. The error
is in the type — `Effect<A, E>` does not compile if `E` is ignored — and
fibers cannot be silently dropped the way promises can. Retry, timeout,
backoff and heartbeat are first-class instead of hand-rolled, which is most
of what a session layer is.

**Where it goes:**

- **Yes — the session layer** (connect, handshake, heartbeat, resume). This
  is retry-and-timeout logic, which is the thing Effect is for.
- **Yes — delivery adapters.** "An adapter must not change what a failure
  means" is currently a code-review principle. Here it becomes a
  compiler-checked property.
- **Later, on evidence — the daemon job loop.** Working, hardened code.
  Migrate when it is opened for 009, not before, and not for tidiness.
- **No — public package APIs.** These stay Promise-based, with
  `Effect.runPromise` at the boundary. **Nobody should have to learn Effect
  to enqueue a job.** Adoption is an internal discipline; making it an
  ecosystem tax on consumers of `@byollm/server` would be a straight
  betrayal of the dependency-minimalism rule at the top of this file.

The honest cost: it is a large dependency with a real learning curve, in a
repo whose stated bar is minimalism, and the boundary above is the only
thing keeping those two facts compatible. If that boundary erodes — if an
`Effect` type ever appears in a published signature — the trade has
stopped being the one we agreed to.

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

**We build and test on Node 24**, the current LTS line, and that is what CI
and the release workflow run.

**But `engines` says ≥22.14**, deliberately lower. These are two different
questions: what we develop on, and what we oblige a consumer to run. Node 22
is in maintenance LTS until April 2027, nothing in this code needs 24, and
raising the floor would drop working installs to buy nothing. The floor is
22.14 rather than 22.12 because that is the minimum npm's trusted publishing
accepts, so a contributor whose Node satisfies `engines` can also cut a
release.

Node 20 reached end of life in April 2026. Both supported lines have native
`fetch`, `AbortSignal.any` and stable test tooling.

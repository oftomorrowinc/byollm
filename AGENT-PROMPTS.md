# Agent prompts

The prompts a person hands to the AI they already use, so it does the setup.
This file is the source of record for `AGENT_PROMPTS` in `@byollm/protocol`,
the strip at the top of README.md and the one on byo-llm.com. Edit here, then
run `pnpm run about`; `verify` fails while any copy disagrees.

Every `byollm …` command in a prompt must appear in `byollm --help`, every
`https://docs.byollm.cloud/#…` anchor must exist on the docs, and every npm
package must be one this repository publishes —
`packages/daemon/src/agent-prompts.test.ts` checks all three.

Heading: You already have an AI. Hand it this.

Lede: Paste the prompt into whatever you use — Claude, ChatGPT, Codex, Cursor, a local model — and it does the setup, stopping where a step needs you.

## Set up my computer

id: computer · audience: user

```text
Set up BYOLLM on my computer so websites I approve can use the AI I already
have. Some steps need me at the keyboard: tell me exactly what to type, then
wait. First I open Terminal (Mac) or PowerShell (Windows). Run
`node --version`; if it fails or is below 22.14, I install the LTS version
of Node.js — the free program BYOLLM runs on — from https://nodejs.org and
reopen the window. Then run `npm install -g byollm@latest`. Then I run
`byollm setup` myself, because it asks questions: it finds what I have
(Ollama, MLX or llama.cpp here, or my Claude Pro/Max or Codex sign-in —
subscriptions stay mine, never shared) and pairs with byollm.cloud. When it
prints a pairing code and fingerprint, STOP: I approve it at
https://dashboard.byollm.cloud/devices and check the fingerprint matches.
Then run `byollm status` and `byollm services`, fix anything they name, and
`byollm start` if it is not running. Finish by having me press Connect at
https://test.byollm.cloud. Reference:
https://docs.byollm.cloud/#what-is-byollm and
https://docs.byollm.cloud/#keep-daemon-running. Don't guess commands:
`byollm --help` is the authority.
```

## Add BYOLLM to my site

id: site · audience: developer

```text
Add BYOLLM to this project so my users bring their own AI. Install
`@byollm/server`, generate site keys once with
`npx --package @byollm/server keygen` and put them in env (never in the
repo), mount the handler at `/byollm` (not under `/api` — the daemon pairs
with an origin), and add one `enqueue` with a timeout and a no-runner path —
never a bare await. Then register the site at https://dashboard.byollm.cloud
and add the Connect button exactly as https://docs.byollm.cloud/#embed says:
the iframe gets `site`, `state` and `return`, the page posts
`{ byollm: "hello" }` first, and the return page posts
`{ byollm: "connected" }` and closes. Job states and why an answer stopped:
https://docs.byollm.cloud/#job-states and
https://docs.byollm.cloud/#stop-reason. Test against
https://test.byollm.cloud's flow before you tell me it works. STOP and ask
me for anything that needs my dashboard login.
```

## Run my own relay

id: relay · audience: operator

```text
Stand up my own BYOLLM relay instead of byollm.cloud. Use `@byollm/relay`
and `@byollm/control-plane` from npm — one replica on the built-in memory
store, or give the relay a shared `RoutingStore` to run more — and prove it
with `@byollm/conformance`
(`npx --package @byollm/conformance byollm-certify <target>`) before
pointing any daemon at it: a server is byollm-compatible when the kit
passes. Then pair a daemon with `byollm connect <my relay origin>`. The
relay never sees prompts (https://docs.byollm.cloud/#what-we-see) and that
must stay true in my deployment. Reference:
https://github.com/oftomorrowinc/byollm#packages. STOP and ask me before
anything that costs money or opens a port to the internet.
```

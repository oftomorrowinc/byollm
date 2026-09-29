# Reporting a security problem

**Report it privately on GitHub: the repository's Security tab → "Report a
vulnerability", or directly at
[github.com/oftomorrowinc/byollm/security/advisories/new](https://github.com/oftomorrowinc/byollm/security/advisories/new).**
That opens a private advisory only you and the maintainers can see. If you
would rather not use GitHub, email `support@byollm.cloud` — it reaches the
same people. Either way, never a public issue for anything security-shaped,
even one you are unsure about: ask privately, and we will say so if it can be
public.

What you can expect back: an acknowledgement from a person within three
working days; a private write-up of what we found and what we are doing about
it, under the advisory's `GHSA-` number — if you wrote by email, we open the
advisory ourselves and send you that number; and credit in the release note
that ships the fix, unless you tell us you would rather not be named. This is
a small project before its 1.0, so the fix itself is best effort rather than
an SLA, but you will be told what is happening rather than that it is "being
reviewed".

**If you looked in good faith, we will not come after you for having looked.**
That includes probing the pairing, pinning and grant boundaries — which is
exactly where we would like the scrutiny — as long as you use your own accounts
and machines, do not degrade the service for other people, and do not access,
keep or publish anybody else's data. Tell us before you tell anyone else, and give
us a chance to ship a fix.

## What is in scope, and what is already known

The full threat model is [`docs/security.md`](docs/security.md). It states
what is guaranteed, what is explicitly _not_, and where the operating system
stops us — including a list of deliberate disclosures. Please read §1 and §9
before reporting: two things are conflated constantly, and only one of them is
a bug here.

- **Breakout** — payload text escaping the model call into the machine (code
  execution, file access, network calls beyond the model itself). This is
  designed out, not detected — and re-proved against the real binary on every run. **A working breakout is the most
  serious report we can receive**, and we want it.
- **Prompt injection** — payload text changing what the model _says_. No
  daemon can prevent this and we do not claim to; the consequences are bounded
  instead (no tools, no retrieval, no MCP; output is inert bytes). A
  demonstration that a model said something unwanted is not a vulnerability
  report. A demonstration that it _did_ something is.

Also in scope, and worth a report: anything that routes a job to a machine
that did not consent to it, exposes a payload to the relay or to us, lets a
site's key change under an id a device has already pinned, lets a device run
work no grant was signed for, or lets one account read another's data.

One thing is _not_ a bug, because it is the design: a paired device serves any
site the app it paired with offers it, from the first heartbeat that names the
site. There is no per-site approval on the machine — `byollm approve` was
retired by byollm_016 Amendment K. What the device keeps is the pairing
ceremony (a human compares a fingerprint once, per app), the pin on each site's
key, the grant check on every job, and a notice at the machine — `now serving
<site>`, with the fingerprint — the first time a new site's work runs. A
compromised app or control plane can therefore point a paired device at a site
its owner never chose; that trade is recorded in
[`specs/byollm_016-services.md`](specs/byollm_016-services.md) (Amendment K)
and bounded by spend caps, `byollm stop` and `byollm forget`. A report that an
app can add a site is telling us what the spec says; a report that it can do so
_silently_, or run work for it without a grant, is one we want.

Every guarantee in the threat model has a test id in the open protocol, and
the suite blocks publish. If you find a guarantee that is claimed but not
actually tested, that is also worth telling us — a rule nothing re-verifies is
how the real one gets in.

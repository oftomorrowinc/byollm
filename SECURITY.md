# Reporting a security problem

**Email `tsampson@cloudspace.com`, or open a private security advisory at
[github.com/oftomorrowinc/byollm/security/advisories](https://github.com/oftomorrowinc/byollm/security/advisories/new).
Please don't open a public issue for a vulnerability.**

Either channel reaches a person. This is a small project before its 1.0, so
the honest expectation is best effort rather than an SLA: you should hear back
within a few days, and you will be told what we are doing about it rather than
that it is "being reviewed".

**If you looked in good faith, we will not come after you for having looked.**
That includes probing the consent and allowlist boundaries — which is exactly
where we would like the scrutiny — as long as you use your own accounts and
machines, do not degrade the service for other people, and do not access, keep
or publish anybody else's data. Tell us before you tell anyone else, and give
us a chance to ship a fix.

## What is in scope, and what is already known

The full threat model is [`docs/security.md`](docs/security.md). It states
what is guaranteed, what is explicitly _not_, and where the operating system
stops us — including a list of deliberate disclosures. Please read §1 and §9
before reporting: two things are conflated constantly, and only one of them is
a bug here.

- **Breakout** — payload text escaping the model call into the machine (code
  execution, file access, network calls beyond the model itself). This is
  meant to be structurally impossible. **A working breakout is the most
  serious report we can receive**, and we want it.
- **Prompt injection** — payload text changing what the model _says_. No
  daemon can prevent this and we do not claim to; the consequences are bounded
  instead (no tools, no retrieval, no MCP; output is inert bytes). A
  demonstration that a model said something unwanted is not a vulnerability
  report. A demonstration that it _did_ something is.

Also in scope, and worth a report: anything that routes a job to a machine
that did not consent to it, exposes a payload to the relay or to us, lets a
site be served without its fingerprint being approved, or lets one account
read another's data.

Every guarantee in the threat model has a test id in the open protocol, and
the suite blocks publish. If you find a guarantee that is claimed but not
actually tested, that is also worth telling us — a rule nothing re-verifies is
how the real one gets in.

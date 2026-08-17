# byollm_010 — Platform support: matrix CI, and what "supported" means

**Status: implemented 2026-08-13**, except §5 (the version tuple), which
rides with the session-layer work in byollm_009 because it threads
through the handshake as well as CI.

Kevin Samsoe (@KSamsoe) found the `claude-cli` backend completely
non-functional on Windows within days of the repo going public. Not degraded —
`spawn("claude")` failed with `ENOENT`, health reported the CLI as not
installed, and `connect` correctly refused to pair with nothing to
offer. A Claude-subscription user on Windows could not use the daemon
at all.

The fix was good and is merged. This spec is about the fact that we
shipped it, published it, wrote a landing page about it, and moved
`latest` to it without ever running the test suite on the platform.

## 1. The claim we were making without checking

Nothing in the README, the site, or the specs says "macOS and Linux
only". `npx byollm@alpha connect` reads as a promise to anyone with
Node. The daemon's whole pitch is that it runs on *your* machine, and
a material share of those machines run Windows.

The rule this spec adopts: **a platform CI does not run is a platform
we do not support, and we say so out loud.** Either the runner exists
or the limitation is documented. What is not acceptable is the third
thing, which is what we were doing: implying universality and finding
out from a user.

## 2. The matrix

CI runs the daemon suite on real runners:

| Runner | Why |
|---|---|
| `ubuntu-latest` | Today's baseline; the server and conformance jobs stay here only |
| `macos-latest` (arm64) | The primary development platform, and MLX only exists here |
| `windows-latest` | The platform this spec exists because of |

Scope: the **daemon** package (unit, failures, edges) and the
**adversarial** suite. The server and conformance jobs are pure
protocol logic over HTTP and gain little from a matrix — running them
three times to watch the same assertions pass is cost without
information.

The release workflow gates on the matrix. `byollm_005` already refuses
to publish behind a failing adversarial corpus; that gate is worth
less when it only ever ran on one platform.

## 3. The adversarial suite has a hole, and it is on Windows

PR #1 disclosed this rather than papering over it, which is why it is
actionable now.

The suite's environment assertion is a **hand-written copy** of the
Unix allowlist, not an import from `childEnv`. That duplication is
deliberate and correct — a security test that imports the thing it
tests asserts only self-consistency. The consequence is that the
Windows allowlist (byollm_007-era `childEnv` widening, §3.3 of
`docs/security.md`) trips it: 33 failures.

Two of those are the same finding in different clothes:

1. **The widened allowlist is not in the assertion.** Expected. The
   assertion should learn about Windows, deliberately, as a second
   hand-written set.
2. **Windows injects variables that are on neither list** —
   `HOMEDRIVE` and others, at a layer below anything a process
   controls, the way macOS injects `__CF_USER_TEXT_ENCODING`.

The second is the real work, and it is a question we have not
answered: **what does Windows put into every child regardless of the
environment we pass, and is that acceptable inside a byollm_004 §2
isolation claim?** It needs enumerating on a real runner, and each
variable needs a judgement — carries no secret, or does.

The contributor's instinct here should be the house rule: **an
assertion rewritten to match observed behaviour has stopped testing
anything.**

**Answered 2026-08-13, on a real runner.** Windows injects exactly six:
`HOMEDRIVE`, `HOMEPATH`, `SYSTEMDRIVE`, `USERNAME`, `USERDOMAIN`,
`LOGONSERVER`. Linux injects none; macOS injects one. They are not
removable — naming a variable explicitly does not replace it, so the
injection happens below the process.

Four carry nothing the allowlist does not already give. Two do:
on a domain-joined machine `USERDOMAIN` is the AD domain and
`LOGONSERVER` names a domain controller. That is a real widening of
what a hostile job sees on a corporate Windows machine, it cannot be
closed from here, and `docs/security.md` §3.3 states it as a cost of
running a process-class backend there rather than leaving it to be
discovered.

The measurement came from `pnpm --filter byollm run env-report`, which
asserts nothing and prints. Keeping the answer and the assertion in
separate steps is the point: the assertion was written after reading
the answer, by someone deciding, rather than generated from whatever
the machine happened to do.

## 4. Tests cannot substitute for a runner, and nearly looked like they could

PR #1's tests take platform and environment as parameters so Windows
behaviour is assertable from Linux. That is good design and it is why
the fix is reviewable at all. It also has a limit worth writing down,
because the limit is invisible:

`path.delimiter` and `path.join()` are **host**-derived, not derived
from the platform argument. Simulating `win32` on Linux therefore
splits a Windows `PATH` on `:` instead of `;`, and joins with `/`. The
branching is genuinely tested — identity off Windows, Node prefix for
a `.js` entry point, passthrough for a real executable, honest
fallback when nothing is found. The **resolution** is not: the PATH
walk and the `.cmd` shim parse never execute meaningfully off Windows,
and the "falls back when nothing is found" case passes for an
incidental reason.

This is not a criticism of the tests; it is the argument for §2. Some
properties only a real runner can hold.

## 5. Version identity

`byollm --version` prints the package version and nothing else. That
is the least useful version string possible for a distributed daemon.
It should print **build version, platform, arch, Node version, and
protocol version**, and the same tuple should appear in the pairing
handshake and in `byollm status`.

The immediate payoff is support: "it doesn't work on Windows" with no
version attached is the most expensive sentence an open-source project
receives, and an issue template that captures `--version` first is
worth more than most triage. The structural payoff is that every
later capability — deprecation warnings, minimum-supported-version
policy, "your daemon is N releases behind" — needs this to exist and
is painful to retrofit.

This is a public-repo concern that a hosted layer would also depend
on; it belongs here regardless of whether one ever exists.

## 6. Smaller items from the same PR

- **Memoize `resolveClaudeLaunch`.** It runs on every `health()` and
  every `execute()`, and on Windows walks every `PATH` entry with two
  `existsSync` calls each. At concurrency 4 that blocks the event loop
  during job dispatch. Non-Windows returns before touching the
  filesystem, so this costs nothing today on the platforms CI runs —
  which is precisely how it would have gone unnoticed. The answer
  cannot meaningfully change within a process lifetime.
- **`edges.test.ts` hardcodes POSIX separators** against a path the
  daemon builds with `join()`. A test bug, not a daemon bug.
- **Issue templates by platform**, capturing `--version` output first.
  Landed with a caveat worth stating: the template asks for
  `byollm --version`, which today prints only a package version. It
  gets materially more useful when §5 lands and that becomes a tuple.

## 6a. What the matrix found on its first day

Two things, both security-relevant, neither of which any amount of
reasoning on a Mac would have produced:

1. **What Windows injects into a child** (§3, answered above).
2. **The daemon's device key file is not `0600` on Windows.** Node
   synthesizes `mode` there — a writable file reports `0o666` whatever
   `writeFile` was given, and `chmod` only toggles read-only. The mode
   we pass is ignored; the ACL inherited from the user profile is what
   protects it. Worse, the "warn if widened" check would have fired on
   every Windows start and claimed to fix something it had not.

   Found by a test asserting `0600` and failing. `docs/security.md`
   §3.4 now states it, and the tests are platform-specific in both
   directions — Windows asserts the mode is *not* what protects the
   key, so nobody deletes the awkward assertion and restores a false
   one.

   Open: hardening it with an explicit ACL (`icacls`). Worth doing,
   not done — it means spawning a process from the startup path, which
   deserves its own change.

## 7. What this does not cover

Installers, a tray app, auto-start, and code signing are distribution,
not platform support. They are real work and they are elsewhere. This
spec is only about the thing we currently assert without evidence:
that the daemon works where we let people install it.

## Done when

CI runs the daemon and adversarial suites on Linux, macOS and Windows;
the release workflow gates on all three; the Windows environment
question in §3 is answered on a real runner and the adversarial
assertion updated deliberately (or the platform documented as
unverified, in `docs/security.md`, until it is); `byollm --version`
prints the full tuple and an issue template asks for it; and
`resolveClaudeLaunch` resolves once per process.

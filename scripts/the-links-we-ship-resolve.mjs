#!/usr/bin/env node
/**
 * The links this repository ships to strangers actually resolve — B224.
 *
 *     node scripts/the-links-we-ship-resolve.mjs
 *
 * ## The one it found
 *
 * The root README's last line is the byline: *"Built by [Of Tomorrow]"*,
 * linking `https://oftomorrow.dev`. **That domain has no A record.** Measured
 * against a control rather than assumed — `dig +short oftomorrow.dev A` is
 * empty while `byo-llm.com` answers with two addresses.
 *
 * The repository is already public, so that is live now, on the last line a
 * reader sees, under the company's own name. Nothing in the repository would
 * ever have said so: a dead link is invisible to every check that reads files,
 * because the file is perfectly well-formed.
 *
 * ## Prose links only, and that is the whole trick
 *
 * A README is full of URLs nobody should visit — `https://your-app.com`,
 * `http://127.0.0.1:11434/v1`, `https://your-relay.example`. They are examples,
 * and a checker that reported them would be reporting the documentation for
 * doing its job.
 *
 * The discriminator is not a list of placeholder domains — that list would go
 * stale and would have to guess. **A URL inside a code fence is an example; a
 * URL in prose is a claim.** Stripping fenced and inline code from the root
 * README leaves five links and every placeholder disappears, which is what
 * makes this checkable at all.
 *
 * ## The three states, because two of them are not failures
 *
 *   - **dead** — no DNS record, or the server says 404/410. Confident.
 *   - **ok** — 2xx or 3xx.
 *   - **could not judge** — 403, 429, a timeout, a TLS error. `npmjs.com`
 *     answers 403 to anything that does not look like a browser, and a
 *     checker that called our own npm org link dead would be switched off
 *     within a day. Reported apart, and never as a failure.
 *
 * Advisory, and deliberately NOT in `verify`: it needs the network, and a gate
 * that fails on a train is a gate somebody removes from the chain.
 *
 * **And nothing runs it on a schedule either**, which is a larger limit than
 * the paragraph above and was not stated until now: no workflow invokes this
 * file, so it reports only when somebody types it. The reason it is out of
 * `verify` is an argument for a cron, not against one — a weekly run costs
 * nobody a push — but a scheduled workflow spends Actions minutes, and that
 * budget is Todd's to commit. Raised in the note for this landing rather than
 * decided here. Until it is decided, a link can die and this will not say so.
 */

import { resolve4, resolve6, resolveCname } from "node:dns/promises";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env["LINK_CHECK_ROOT"] ?? join(HERE, ".."));

/**
 * Our own hostnames in shipped SOURCE, which is a different surface.
 *
 * **Kevin's team put `https://relay.byollm.cloud` in every app's
 * `.env.example` and then worked out why nothing connected.** It came from
 * `CloudLaneOptions.relayOrigin`'s doc comment, which ships in the published
 * `.d.ts` — so it is among the first things a site author reads, and the host
 * has no DNS record. The markdown scan above could never have found it,
 * because a `.d.ts` is not markdown.
 *
 * Narrowed to hosts under our OWN domains on purpose. Source is full of
 * example URLs that must not resolve — `https://your-app.com`,
 * `http://127.0.0.1:11434/v1`, `https://your-relay.example` — and the
 * code-fence discriminator that separates them in markdown has no equivalent
 * here. A hostname under a domain we operate is never a placeholder, so this
 * is the one rule that can be applied to source without inventing alarms.
 */
const OURS = /^https:\/\/[a-z0-9.-]*(byollm\.cloud|byo-llm\.com)/u;

const shippedSource = (root) => {
  const dir = join(root, "packages");
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        /* Built output and dependencies are copies of what is already read. */
        if (/^(node_modules|dist|\.tsbuild|coverage)$/u.test(entry.name))
          continue;
        walk(path);
      } else if (
        /\.ts$/u.test(entry.name) &&
        !/\.test\.ts$/u.test(entry.name)
      ) {
        out.push(path);
      }
    }
  };
  walk(dir);
  return out;
};

/** The markdown a stranger reads: the root, every package README, the rest. */
const shipped = (root) => {
  const files = ["README.md", "CONTRIBUTING.md", "SECURITY.md"]
    .map((name) => join(root, name))
    .filter((path) => existsSync(path));
  const packages = join(root, "packages");
  if (existsSync(packages))
    for (const entry of readdirSync(packages)) {
      const readme = join(packages, entry, "README.md");
      if (existsSync(readme)) files.push(readme);
    }
  return files;
};

/**
 * Every URL a reader is invited to follow, which is every URL NOT in code.
 *
 * Fenced blocks first, then inline spans — in that order, because an inline
 * backtick inside a fence would otherwise cut the fence in half and leak its
 * contents back into the prose.
 *
 */
const claimedLinks = (markdown) => {
  const prose = markdown
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/`[^`\n]*`/gu, "");
  return [
    ...new Set(
      [...prose.matchAll(/https?:\/\/[^\s)<>"'\]]+/gu)].map((match) =>
        (match[0] ?? "").replace(/[).,;:]+$/u, ""),
      ),
    ),
  ];
};

/**
 * What the world says, or what a fixture says it says.
 *
 * Same seam and same reason as `release-check.mjs` and the first-publish
 * announcement: a test that needs DNS and the network to say what this logic
 * does is a test that reports the weather. The real world is exercised by the
 * script doing its job; the suite proves the reasoning, including the two
 * states that are not failures.
 *
 * `{ "<url>": { "dns": false } }` for a name that does not resolve,
 * `{ "status": 404 }` for a server that answers, `{ "unreachable": true }` for
 * a request that never completes.
 */
const fixturePath = process.env["LINK_CHECK_FIXTURE"];
const fixture =
  fixturePath === undefined
    ? undefined
    : JSON.parse(readFileSync(fixturePath, "utf8"));

/**
 * Does the name resolve at all? A dead domain is the confident failure.
 *
 * `node:dns` rather than shelling out to `dig`: knip caught the dependency,
 * and it was the right catch — `dig` is absent from most minimal CI images,
 * and a missing binary would have degraded every link to "could not judge"
 * silently. A checker whose answer depends on which container it runs in is
 * not answering about the link.
 *
 * `null` means the question could not be asked; `false` means it was asked and
 * the name has no address.
 */
/**
 * Is this resolver answering faithfully, or is it answering for somebody else?
 *
 * **Every "dead name" verdict this script prints is a claim about the world
 * made from inside one machine's network**, and CW was right to say so: I
 * reported `oftomorrow.press` as having no records an hour after two people
 * had loaded it, and a resolver behind an allowlist would look exactly like
 * that. A control that merely resolves is not enough — it proves some names
 * resolve, not that none are being withheld.
 *
 * Two questions, asked once per run, that a filtering resolver fails:
 *
 *   - a **known-good** name resolves, so the resolver works at all;
 *   - a name that **cannot exist** comes back not-found, so the resolver is
 *     not synthesising answers or sinkholing what it does not like.
 *
 * If either is wrong, no name can be called dead here — every verdict becomes
 * unjudged, because the instrument is the thing that is broken. That is the
 * difference between a finding and a faulty prover, and this script exists to
 * report the first.
 *
 * It does **not** prove the resolver is unfiltered. A filter that faithfully
 * proxies a zone and hides one record type would pass both. What it rules out
 * is the ordinary shapes — no DNS, a sinkhole, a wildcard — and what is left
 * is small enough to name in the output rather than to hide.
 */
/** @typedef {"answered" | "not-found" | "failed"} Observation */

const KNOWN_GOOD = "one.one.one.one";
const CANNOT_EXIST = "nxdomain-probe-4f2a9c.invalid";

/**
 * The judgement, separated from the two lookups that feed it.
 *
 * Exported and pure because the lookups cannot be staged: every case in this
 * suite runs through the fixture, which short-circuits before any real DNS —
 * so the rule below was written and never asked, and a mutation trusting a
 * resolver that invents names survived every one of them. The seam hid the
 * live path, which is the third time in this file.
 *
 * `good` is what a known-good name returned; `bogus` is what a name that
 * cannot exist returned. Both are `"answered"`, `"not-found"` or `"failed"`.
 *
 */
const resolverVerdict = ({ good, bogus }) => {
  /* A resolver that cannot answer for a name it should know is not in a
     position to say anything is missing. */
  if (good !== "answered") return false;
  /* A resolver that answers for a name that cannot exist is inventing them —
     a sinkhole or a wildcard — and its not-founds mean nothing either. */
  return bogus === "not-found";
};

/**
 * One lookup, reduced to the three answers the verdict cares about.
 *
 * The lookup is injectable for the reason `beatWriterIsGone` takes its `kill`:
 * there is no other way to stage a timeout, and a mutation reporting one as
 * `not-found` survived otherwise. It matters in exactly one shape — the
 * control resolves and the bogus probe times out — where treating the timeout
 * as an admission would trust a resolver that had told us nothing.
 *
 */
const observe = async (host, lookup = resolve4) => {
  try {
    const answers = await lookup(host);
    return Array.isArray(answers) && answers.length > 0
      ? "answered"
      : "not-found";
  } catch (error) {
    const code = String(error.code ?? "");
    return code === "ENOTFOUND" || code === "ENODATA" ? "not-found" : "failed";
  }
};

/**
 * The two probes, from the fixture rather than the network.
 *
 * `{ good, bogus }` name what each lookup should do: an array is what it
 * resolved, a string is the error code it threw. They go through the same
 * `observe` and the same `resolverVerdict` the real run uses — the point is
 * to exercise that rule, not to restate it here, and the first version of
 * this fixture short-circuited before both and left them untested.
 */
const stagedLookup = (answer) => (_name) =>
  Array.isArray(answer)
    ? Promise.resolve(answer)
    : Promise.reject(
        Object.assign(new Error(String(answer)), { code: answer }),
      );

const resolverIsAnswering = async () => {
  if (fixture !== undefined) {
    const staged = fixture["__resolver"];
    if (staged === undefined) return true;
    if (staged === "broken") return false;
    return resolverVerdict({
      good: await observe(KNOWN_GOOD, stagedLookup(staged.good)),
      bogus: await observe(CANNOT_EXIST, stagedLookup(staged.bogus)),
    });
  }
  return resolverVerdict({
    good: await observe(KNOWN_GOOD),
    bogus: await observe(CANNOT_EXIST),
  });
};

const resolves = async (url) => {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  })();
  /* Not a URL at all. A reader cannot follow it either. */
  if (host === null) return false;
  if (fixture !== undefined) {
    const entry = fixture[url];
    if (entry === undefined) return true;
    if (entry.dns === false) return false;
    return entry.noResolver === true ? null : true;
  }
  /* A record, then AAAA, then CNAME. Any one of them is a name that points
     somewhere; only all three failing with a not-found is a dead name. */
  for (const ask of [resolve4, resolve6, resolveCname]) {
    try {
      const answers = await ask(host);
      if (Array.isArray(answers) && answers.length > 0) return true;
    } catch (error) {
      const code = String(error.code ?? "");
      /* ENOTFOUND/NODATA are answers about the name. Anything else — a
         timeout, a refused resolver — is the network, and is not one. */
      if (code !== "ENOTFOUND" && code !== "ENODATA") return null;
    }
  }
  return false;
};

/**
 * What to ASK for a URL, which is not always the URL.
 *
 * `npmjs.com` answers 403 to anything that does not look like a browser, so
 * every package link lands in "could not judge" — and that was eight of the
 * thirteen, which is most of a checker reporting nothing.
 *
 * The registry answers the same question without the bot wall, and it answers
 * it better: `registry.npmjs.org/<name>` 404s for a package that does not
 * exist. That is how it found a real one: six package READMEs linked
 * `@byollm/agreements`, which had never been published, and the website's 403
 * was hiding all six. That link resolved itself by disappearing — Todd ruled
 * the package out of existence on 2026-09-19 — which is the cheapest way a
 * dead link has ever been fixed here and no reason to trust the next one.
 *
 * Only the question moves. What is reported is still the link the reader
 * clicks, so nobody is sent to an address they did not write.
 */
const askFor = (url) => {
  const parsed = (() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  })();
  if (parsed === null) return url;
  if (!/^(www\.)?npmjs\.com$/u.test(parsed.hostname)) return url;
  const name = /^\/package\/(.+)$/u.exec(parsed.pathname)?.[1];
  return name === undefined
    ? url
    : `https://registry.npmjs.org/${name.replace(/\/$/u, "")}`;
};

/** Does the name exist? The whole question for a host you configure. */
const nameExists = async (url) => {
  const named = await resolves(url);
  if (named === null) return { state: "unjudged", why: "no resolver here" };
  return named
    ? { state: "ok", why: "resolves" }
    : { state: "dead", why: "the name does not resolve" };
};

const judge = async (url) => {
  const named = await resolves(url);
  if (named === null) return { state: "unjudged", why: "no resolver here" };
  if (named === false)
    return { state: "dead", why: "the name does not resolve" };
  if (fixture !== undefined) {
    /* Keyed by what is ASKED, not by what is printed. That is what makes the
       npm→registry translation observable from outside: a case whose fixture
       only answers for the registry URL goes green only if the translation
       happened. `scripts/*.mjs` are standalone executables by this repo's own
       eslint note, so nothing here is imported and behaviour is the only
       surface a test has. */
    const entry = fixture[askFor(url)] ?? {};
    if (entry.unreachable === true)
      return { state: "unjudged", why: "request never completed" };
    const status = entry.status ?? 200;
    if (status === 404 || status === 410)
      return { state: "dead", why: `HTTP ${String(status)}` };
    if (status < 400) return { state: "ok", why: String(status) };
    return { state: "unjudged", why: `HTTP ${String(status)}` };
  }
  try {
    const response = await fetch(askFor(url), {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404 || response.status === 410)
      return { state: "dead", why: `HTTP ${String(response.status)}` };
    if (response.ok || (response.status >= 300 && response.status < 400))
      return { state: "ok", why: String(response.status) };
    return { state: "unjudged", why: `HTTP ${String(response.status)}` };
  } catch (error) {
    return { state: "unjudged", why: String(error).slice(0, 60) };
  }
};

const main = async () => {
  const files = shipped(ROOT);
  if (files.length < 2) {
    console.error(
      `only ${String(files.length)} shipped markdown file(s) found — the layout moved`,
    );
    return 2;
  }

  const where = new Map();
  /**
   * Hosts found in SOURCE are judged by DNS alone, not by status.
   *
   * The first version asked them for a page and called `hub.byollm.cloud`
   * dead on its `404` — which is an API host with no index, answering
   * correctly at `/readyz` and every endpoint a daemon calls. That is the
   * false-alarm direction, in the checker whose own docstring says an alarm
   * nobody believes gets deleted.
   *
   * And it is not the defect either: what Kevin hit was a host with **no DNS
   * record at all**. A hostname in a type's example is something you
   * configure, not a page you visit, so "does this name exist" is the whole
   * question.
   */
  const fromSource = new Set();

  /* Our own hostnames in shipped source — see `OURS`. Added to the same map,
     so a dead host is reported once with every file that carries it however
     it got there. */
  for (const file of shippedSource(ROOT))
    for (const match of readFileSync(file, "utf8").matchAll(
      /https:\/\/[A-Za-z0-9.-]+/gu,
    )) {
      const url = match[0];
      if (!OURS.test(url)) continue;
      const at = where.get(url) ?? [];
      at.push(
        file
          .slice(ROOT.length + 1)
          .split(sep)
          .join("/"),
      );
      where.set(url, at);
      fromSource.add(url);
    }

  /* What the MARKDOWN reader found, kept apart from the source scan because
     the emptiness guard below is a claim about that reader specifically. */
  const fromMarkdown = new Set();

  for (const file of files)
    for (const url of claimedLinks(readFileSync(file, "utf8"))) {
      fromMarkdown.add(url);
      const at = where.get(url) ?? [];
      /* Forward slashes, on every platform. `join` gives `packages\\a\\README.md`
         on Windows, and every other path this project prints — git's output,
         a GitHub link, the READMEs themselves — uses `/`. A report somebody
         pastes into a search box should match what they will find. Caught by
         CI on windows-latest, which is the whole argument for the commit
         before this one. */
      at.push(
        file
          .slice(ROOT.length + 1)
          .split(sep)
          .join("/"),
      );
      where.set(url, at);
    }

  if (fromMarkdown.size === 0) {
    /* Asked of the markdown reader ALONE, which is what the sentence says.
       Counting the combined map would make this pass on a tree whose prose
       extractor had broken, so long as some source file mentioned a host of
       ours — an unreadable answer promoted to a positive one by an unrelated
       scan standing next to it. */
    console.error(
      "no prose links found in any shipped markdown — the reader found nothing, which is not the same as nothing being wrong",
    );
    return 2;
  }

  /* Asked once, before any verdict is believed — see `resolverIsAnswering`. */
  const trustworthy = await resolverIsAnswering();

  const dead = [];
  const unjudged = [];
  for (const [url, files_] of where) {
    const { state, why } = fromSource.has(url)
      ? await nameExists(url)
      : await judge(url);
    if (state === "dead" && !trustworthy) {
      /* The instrument, not the finding. A resolver that cannot answer for a
         name it should know, or that invents one it cannot, is in no position
         to tell anybody a link is dead. */
      unjudged.push({ url, why: "this resolver is not answering faithfully" });
    } else if (state === "dead") dead.push({ url, why, files: files_ });
    else if (state === "unjudged") unjudged.push({ url, why });
  }

  /* On stdout, with the rest of the report. This is a caveat on the result
     rather than a failure — the same place "could not judge" is printed, and
     the run does not exit non-zero for it. It went to stderr first, where a
     passing run's harness never saw it: a warning nobody can read is a warning
     that is not there. */
  if (!trustworthy)
    console.log(
      "\nTHE RESOLVER HERE IS NOT ANSWERING FAITHFULLY, so no name is called\n" +
        "dead in this run. A known-good name did not resolve, or a name that\n" +
        "cannot exist did — either way the verdicts would be about this\n" +
        "machine's network rather than about the links.\n" +
        "\n" +
        "Run it somewhere else before believing anything is broken.\n",
    );

  console.log(
    `${String(where.size)} link(s) a reader is invited to follow, across ${String(files.length)} file(s).`,
  );
  if (unjudged.length > 0)
    console.log(
      `\ncould not judge (NOT failures — npmjs answers 403 to anything unbrowsery):\n` +
        unjudged.map(({ url, why }) => `  ${url}  ${why}`).join("\n"),
    );

  if (dead.length > 0) {
    console.error(
      `\n${String(dead.length)} DEAD link(s) shipped to readers:\n` +
        dead
          .map(
            ({ url, why, files: f }) =>
              `  ${url}\n    ${why}\n    in ${f.join(", ")}`,
          )
          .join("\n") +
        "\n\nThis repository is public, so these are live. A dead link is\n" +
        "invisible to every check that reads files, because the file is\n" +
        "perfectly well-formed.",
    );
    return 1;
  }
  console.log("\nEvery link a reader is invited to follow resolves.");
  return 0;
};

if (realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  main().then((code) => {
    process.exit(code);
  });

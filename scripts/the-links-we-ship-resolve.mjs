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
 */

import { resolve4, resolve6, resolveCname } from "node:dns/promises";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env["LINK_CHECK_ROOT"] ?? join(HERE, ".."));

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
  for (const file of files)
    for (const url of claimedLinks(readFileSync(file, "utf8"))) {
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

  if (where.size === 0) {
    console.error(
      "no prose links found in any shipped markdown — the reader found nothing, which is not the same as nothing being wrong",
    );
    return 2;
  }

  const dead = [];
  const unjudged = [];
  for (const [url, files_] of where) {
    const { state, why } = await judge(url);
    if (state === "dead") dead.push({ url, why, files: files_ });
    else if (state === "unjudged") unjudged.push({ url, why });
  }

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

/**
 * The agent prompts name only things that exist — #601.
 *
 * `AGENT_PROMPTS` is what a person pastes into their AI, and the AI does what
 * it says. A command that is not real is an agent improvising one; a docs
 * anchor that is not there is an agent reading the top of the page and
 * guessing. Both are worse than no prompt.
 *
 * The first draft of these prompts named `byollm diagnose`, which has never
 * existed, and `byollm connect https://byollm.cloud`, which pairs with the
 * marketing site rather than the hub. Neither was caught by reading. These
 * checks are what catch the next one.
 *
 * It lives in the daemon rather than beside `about.ts` because the daemon's
 * own help is the authority on commands, and the daemon depends on the
 * protocol — not the other way round.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_PROMPTS } from "@byollm/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ORIGIN, runCli } from "./cli.js";
import { daemonPaths } from "./paths.js";
import { noSupervisor, removeTemp } from "./test-support.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const all = AGENT_PROMPTS.map((p) => p.prompt).join("\n");

/** Every backticked span in a prompt — what the prompt tells an agent to type. */
const spans = (text: string): string[] =>
  [...text.matchAll(/`([^`]+)`/gu)].map((m) => m[1] ?? "");

/** `byollm …` invocations, as written. */
const commands = spans(all).filter((s) => /^byollm(\s|$)/u.test(s));

let help = "";
beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "byollm-prompts-"));
  try {
    await runCli(["--help"], {
      paths: daemonPaths(home),
      io: {
        out: (text) => {
          help += text;
        },
        err: () => undefined,
      },
      service: noSupervisor(),
    });
  } finally {
    await removeTemp(home);
  }
});

/**
 * Whether `byollm --help` lists a command. Its verbs are the words before the
 * first placeholder or flag; a flag-only command (`byollm --help`) is listed
 * if help is what it prints.
 */
function listed(command: string): boolean {
  const words = command.split(/\s+/u).slice(1);
  const verbs: string[] = [];
  for (const word of words) {
    if (!/^[a-z][a-z-]*$/u.test(word)) break;
    verbs.push(word);
  }
  if (verbs.length === 0) return words[0] === "--help";
  return new RegExp(`^ {2}byollm ${verbs.join(" ")}(\\s|$)`, "mu").test(help);
}

describe("AGENT_PROMPTS", () => {
  it("is set up my computer, then add to my site, then run my own relay", () => {
    /* Todd 10-06 (#2170): every BYOLLM user has an AI, so the computer prompt
       is the install path for everyone and comes first everywhere. */
    expect(AGENT_PROMPTS.map((p) => [p.id, p.audience])).toEqual([
      ["computer", "user"],
      ["site", "developer"],
      ["relay", "operator"],
    ]);
  });

  it("names byollm commands, so the next check has something to check", () => {
    expect(commands.length).toBeGreaterThan(4);
  });

  it.each(commands)("`%s` is in `byollm --help`", (command) => {
    expect(help).toContain("byollm connect");
    expect(listed(command)).toBe(true);
  });

  it("the check refuses a command help does not list", () => {
    /* The one the first draft named. If `listed` grows lenient enough to pass
       this, every case above is passing for nothing. */
    expect(listed("byollm diagnose")).toBe(false);
    expect(listed("byollm services frobnicate")).toBe(false);
  });

  it("pairs with the hub, or with a relay the person names", () => {
    /* `byollm connect https://byollm.cloud` pairs with the marketing site.
       The hub is the default, so a prompt either leaves the URL off or says
       whose relay it is. */
    for (const command of commands.filter((c) =>
      c.startsWith("byollm connect "),
    )) {
      const target = command.split(/\s+/u)[2] ?? "";
      expect(target === DEFAULT_ORIGIN || target.startsWith("<")).toBe(true);
    }
  });

  it("hands `byollm setup` to the person, because it refuses without a terminal", () => {
    /* `runSetup` returns early when stdin is not a TTY, and an agent's shell
       usually is not one. A prompt telling the agent to run it is a prompt
       that fails at its first real step. */
    const computer = AGENT_PROMPTS.find((p) => p.id === "computer")?.prompt;
    expect(computer).toMatch(/I run\s+`byollm setup`\s+myself/u);
  });

  it("works for somebody who has never opened a terminal", () => {
    /* #2170 (3): it says what Node is and where to get it, and it never
       assumes a terminal is already open. */
    const computer = AGENT_PROMPTS.find((p) => p.id === "computer")?.prompt;
    expect(computer).toContain("`node --version`");
    expect(computer).toContain("https://nodejs.org");
    expect(computer).toContain("Terminal (Mac)");
    expect(computer).toContain("PowerShell (Windows)");
  });

  it("asks for the Node the daemon actually requires", () => {
    const engines = (
      JSON.parse(
        readFileSync(join(ROOT, "packages/daemon/package.json"), "utf8"),
      ) as { engines: { node: string } }
    ).engines.node;
    const floor = /^>=(\d+\.\d+)$/u.exec(engines)?.[1];
    expect(floor).toBeDefined();
    expect(all).toContain(`below ${floor ?? ""}`);
  });

  it("names only packages this repository publishes", () => {
    const published = new Set(
      readdirSync(join(ROOT, "packages"))
        .map((dir) => join(ROOT, "packages", dir, "package.json"))
        .filter((path) => existsSync(path))
        .map(
          (path) =>
            JSON.parse(readFileSync(path, "utf8")) as {
              name: string;
              private?: boolean;
            },
        )
        .filter((pkg) => pkg.private !== true)
        .map((pkg) => pkg.name),
    );
    const named = [
      ...all.matchAll(/@byollm\/[a-z-]+/gu),
      ...all.matchAll(/npm install -g ([a-z@/-]+?)(?:@latest)?`/gu),
    ].map((m) => m[1] ?? m[0]);
    expect(named.length).toBeGreaterThan(3);
    for (const name of named) expect(published).toContain(name);
  });
});

// -- docs anchors ------------------------------------------------------------

const anchors = [
  ...new Set(
    [...all.matchAll(/https:\/\/docs\.byollm\.cloud\/#([a-z0-9-]+)/gu)].map(
      (m) => m[1] ?? "",
    ),
  ),
];

/**
 * Section ids as of byollm-cloud-web 2701736. Stable — they are linked from
 * the daemon's own messages and the FAQ — but a list in this file is a claim,
 * not a check. The test against the docs source is the check, and it runs
 * wherever the sibling repository is checked out.
 */
const KNOWN_ANCHORS = new Set([
  "what-is-byollm",
  "keep-daemon-running",
  "embed",
  "job-states",
  "stop-reason",
  "what-we-see",
]);

/** byollm-cloud-web's docs source, next to this checkout or the main one. */
function docsSource(): string | undefined {
  const near = [join(ROOT, "..", "byollm-cloud-web")];
  try {
    const common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: ROOT, encoding: "utf8" },
    ).trim();
    near.push(join(dirname(common), "..", "byollm-cloud-web"));
  } catch {
    // Not a git checkout (a tarball): only the sibling directory is looked at.
  }
  return near
    .map((repo) => join(repo, "apps/docs/src"))
    .find((src) => existsSync(src));
}

function idsIn(dir: string, into = new Set<string>()): Set<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) idsIn(path, into);
    else if (path.endsWith(".tsx")) {
      const text = readFileSync(path, "utf8");
      for (const m of text.matchAll(/\bid(?:=|: )"([a-z0-9-]+)"/gu)) {
        into.add(m[1] ?? "");
      }
    }
  }
  return into;
}

const docs = docsSource();

describe("AGENT_PROMPTS — docs anchors", () => {
  it("links the docs, so the next checks have something to check", () => {
    expect(anchors.length).toBeGreaterThan(3);
  });

  it.each(anchors)(
    "#%s is a section the prompts were written against",
    (id) => {
      expect(KNOWN_ANCHORS).toContain(id);
    },
  );

  /* Skipped, not passed, when byollm-cloud-web is not beside this checkout:
     an absent docs tree proves nothing either way. */
  it.skipIf(docs === undefined).each(anchors)(
    "#%s is an id in byollm-cloud-web apps/docs",
    (id) => {
      expect(idsIn(docs ?? "")).toContain(id);
    },
  );
});

// -- the generated copies ----------------------------------------------------

/**
 * A file as LF text. Windows checkouts can be CRLF, and these copies are
 * compared to LF constants — 0.1.3's Windows CI was red on exactly that (#706).
 */
const readText = (path: string): string =>
  readFileSync(path, "utf8").replace(/\r\n/gu, "\n");

/** Where the README carries a prompt, or -1. */
const readmeAt = (readme: string, prompt: string): number =>
  readme.indexOf(`\`\`\`text\n${prompt}\n\`\`\``);

describe("AGENT_PROMPTS — where they are shown", () => {
  const readme = readText(join(ROOT, "README.md"));
  const site = readText(join(ROOT, "site/index.html"));

  it.each(AGENT_PROMPTS.map((p) => [p.id, p] as const))(
    "README carries %s verbatim, before Why",
    (_, p) => {
      const at = readmeAt(readme, p.prompt);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(readme.indexOf("## Why"));
    },
  );

  it("finds the prompts in a CRLF checkout of the README", async () => {
    const dir = await mkdtemp(join(tmpdir(), "byollm-crlf-"));
    try {
      const path = join(dir, "README.md");
      writeFileSync(path, readme.replace(/\n/gu, "\r\n"));
      const raw = readFileSync(path, "utf8");
      const prompt = AGENT_PROMPTS[0]?.prompt ?? "";
      /* The failure itself, so this case is not passing for nothing. */
      expect(readmeAt(raw, prompt)).toBe(-1);
      expect(readmeAt(readText(path), prompt)).toBeGreaterThan(-1);
    } finally {
      await removeTemp(dir);
    }
  });

  it.each(AGENT_PROMPTS.map((p) => [p.id, p] as const))(
    "byo-llm.com carries %s verbatim, with a copy button",
    (_, p) => {
      const pre = new RegExp(
        `<pre class="block" id="agent-${p.id}-text">([^<]*)</pre>`,
        "u",
      ).exec(site)?.[1];
      const shown = (pre ?? "")
        .replace(/&lt;/gu, "<")
        .replace(/&gt;/gu, ">")
        .replace(/&amp;/gu, "&");
      expect(shown).toBe(p.prompt);
      expect(site).toContain(`data-copy="agent-${p.id}-text"`);
    },
  );

  it("the hero hands people to the prompts first", () => {
    expect(site).toContain('href="#agents">Hand this to your AI →</a>');
    expect(site).toContain("I'll do it myself → quick start");
  });
});

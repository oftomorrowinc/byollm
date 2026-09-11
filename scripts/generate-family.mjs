#!/usr/bin/env node
/**
 * Every package README links the rest of the family — B029.
 *
 * Six packages ship to npm and a reader arrives at exactly one of them. Before
 * this, `@byollm/daemon`'s README named one sibling and `@byollm/protocol`
 * named one, so somebody landing on either had no way to learn the other four
 * exist — and the family is the argument: a protocol, a relay, an SDK and a
 * daemon are only interesting together.
 *
 * **Generated, not typed into six files.** One list of six entries written six
 * times is five copies waiting to disagree about what a package is for, which
 * is instruction 9's subject — and the same arrangement `generate-about.mjs`
 * already uses: the source is here, the copies are derived, and `--check`
 * fails when they diverge rather than trusting anybody to remember.
 *
 * The blurbs are deliberately one line each. A README section that grows into
 * a second description of every package is a second thing to keep true.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const START = "<!-- family:start -->";
const END = "<!-- family:end -->";

/**
 * The family, and the order is the reading order rather than the dependency
 * order: somebody arriving cold wants to know what the thing IS before which
 * package imports which.
 */
const FAMILY = [
  ["byollm", "the daemon — runs models on your own machine and answers for it"],
  [
    "@byollm/protocol",
    "the wire: envelopes, signatures and the closed vocabularies both ends validate against",
  ],
  ["@byollm/server", "the SDK a site uses to ask a device for work"],
  [
    "@byollm/relay",
    "the broker that holds jobs between a site and a device, and can read neither",
  ],
  ["@byollm/control-plane", "who may ask whom, and the policy store behind it"],
  [
    "@byollm/conformance",
    "the kit that proves an implementation is one — including a posture audit that holds nothing but a URL",
  ],
];

const dir = (name) =>
  name === "byollm" ? "daemon" : name.replace("@byollm/", "");

function section(self) {
  const rows = FAMILY.filter(([name]) => name !== self)
    .map(
      ([name, blurb]) =>
        `- [\`${name}\`](https://www.npmjs.com/package/${name}) — ${blurb}`,
    )
    .join("\n");
  return [
    START,
    "",
    "## The rest of byollm",
    "",
    "Six packages, and they are only interesting together:",
    "",
    rows,
    "",
    END,
  ].join("\n");
}

const check = process.argv.includes("--check");
const wrong = [];

for (const [name] of FAMILY) {
  const path = join(ROOT, "packages", dir(name), "README.md");
  const text = readFileSync(path, "utf8");
  const want = section(name);

  const from = text.indexOf(START);
  const to = text.indexOf(END);
  const next =
    from === -1 || to === -1
      ? `${text.trimEnd()}\n\n${want}\n`
      : `${text.slice(0, from)}${want}${text.slice(to + END.length)}`;

  if (next === text) continue;
  if (check) {
    wrong.push(`packages/${dir(name)}/README.md`);
    continue;
  }
  writeFileSync(path, next);
  process.stdout.write(`  updated packages/${dir(name)}/README.md\n`);
}

if (check && wrong.length > 0) {
  process.stderr.write(
    "\n  These READMEs do not match the family list in\n" +
      "  scripts/generate-family.mjs:\n" +
      wrong.map((name) => `    ${name}\n`).join("") +
      "\n  Run `pnpm run family`. The list is the source; the sections are\n" +
      "  derived, so editing one by hand is editing a copy.\n\n",
  );
  process.exit(1);
}

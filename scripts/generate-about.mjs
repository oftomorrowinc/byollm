#!/usr/bin/env node
/**
 * Turn the two ABOUT files into a module `@byollm/protocol` can ship.
 *
 * The description of record is markdown at the root of this repository,
 * because that is what people edit and review. What a surface needs is a
 * string it can render — the dashboard bundles, the site is static, and
 * neither can read a file out of `node_modules` at runtime.
 *
 * So the markdown is the source and this generates the module, the same
 * arrangement `pnpm register` uses for migrations. `verify` runs it with
 * `--check`, which fails when the generated file and the markdown disagree —
 * the one-source rule enforced rather than remembered.
 *
 * It rides in the protocol package because every surface already depends on
 * it. Before this, the paragraph lived in two hand-kept copies in another
 * repository, which is the exact defect the one-source rule exists to
 * prevent, and it nearly shipped a superseded draft.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "packages/protocol/src/about.ts");
const CUT = "<!-- lede ends here.";

/**
 * A file as LF text. Windows checkouts can be CRLF, and everything here is
 * compared to LF constants — 0.1.3's Windows CI was red on exactly that (#706).
 */
const readText = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const full = readText(join(ROOT, "ABOUT.md")).trim();
const agents = readText(join(ROOT, "AGENT-PROMPTS.md"));
const short = readText(join(ROOT, "ABOUT-SHORT.md")).trim();

const at = short.indexOf(CUT);
if (at === -1) {
  process.stderr.write(
    "\n  ABOUT-SHORT.md has no cut mark, so there is no lede to show on its\n" +
      "  own. Restore the `<!-- lede ends here. … -->` comment.\n\n",
  );
  process.exit(1);
}
const lede = short.slice(0, at).trim();
const tail = short
  .slice(short.indexOf("-->", at) + 3)
  .replace(/\*\*Learn more →\*\*\s*$/, "")
  .trim();

const quote = (text) => JSON.stringify(text);

/**
 * The agent prompts — #601. Same arrangement as ABOUT: the markdown is what
 * people edit and review, and every surface renders from what this parses.
 *
 * The shape is strict and the parse refuses anything else, because a prompt
 * that quietly fails to parse is a prompt that quietly vanishes from three
 * pages at once.
 */
function refuse(why) {
  process.stderr.write(`\n  AGENT-PROMPTS.md: ${why}\n\n`);
  process.exit(1);
}
const field = (name) =>
  new RegExp(`^${name}: (.+)$`, "mu").exec(agents)?.[1] ??
  refuse(`no "${name}:" line.`);
const agentsHeading = field("Heading");
const agentsLede = field("Lede");
const prompts = agents
  .split(/^## /mu)
  .slice(1)
  .map((section) => {
    const title = section.slice(0, section.indexOf("\n")).trim();
    const meta =
      /^id: ([a-z][a-z-]*) · audience: (user|developer|operator)$/mu.exec(
        section,
      );
    const text = /^```text\n([\s\S]*?)\n```$/mu.exec(section);
    if (meta === null) {
      refuse(
        `"${title}" has no "id: … · audience: user|developer|operator" line.`,
      );
    }
    if (text === null) refuse(`"${title}" has no \`\`\`text block.`);
    return { id: meta[1], title, audience: meta[2], prompt: text[1] };
  });
if (prompts.length === 0) refuse("no prompts — each is a `## Title` section.");
if (new Set(prompts.map((p) => p.id)).size !== prompts.length) {
  refuse("two prompts share an id.");
}

/** Where each strip goes, in README.md and site/index.html alike. */
const STRIP_START = "<!-- agents:start -->";
const STRIP_END = "<!-- agents:end -->";

/** The README strip. */
const readmeStrip = [
  STRIP_START,
  "<!-- Generated from AGENT-PROMPTS.md by `pnpm run about`. Edit that. -->",
  "",
  `## ${agentsHeading}`,
  "",
  agentsLede,
  "",
  ...prompts.flatMap((p) => [
    "<details>",
    `<summary><b>${p.title}</b></summary>`,
    "",
    "```text",
    p.prompt,
    "```",
    "",
    "</details>",
    "",
  ]),
  STRIP_END,
].join("\n");

/** The byo-llm.com strip. Escaped, so the page shows the prompt verbatim. */
const html = (text) =>
  text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
const siteStrip = [
  STRIP_START,
  "<!-- Generated from AGENT-PROMPTS.md by `pnpm run about`. Edit that. -->",
  '<section id="agents" class="band"><div class="wrap">',
  '  <p class="eyebrow">Paste this into your agent</p>',
  `  <h2>${html(agentsHeading)}</h2>`,
  `  <p class="lead">${html(agentsLede)}</p>`,
  '  <div class="prompts">',
  ...prompts.flatMap((p) => [
    `    <div class="prompt" id="agent-${p.id}">`,
    `      <div class="ph"><h3>${html(p.title)}</h3><button class="cp" data-copy="agent-${p.id}-text" aria-label="Copy the ${html(p.title)} prompt">copy</button></div>`,
    `      <pre class="block" id="agent-${p.id}-text">${html(p.prompt)}</pre>`,
    "    </div>",
  ]),
  "  </div>",
  "</div></section>",
  STRIP_END,
].join("\n");

/** Replace what sits between two markers, or say there is nowhere to put it. */
function splice(path, want) {
  const text = readText(join(ROOT, path));
  const from = text.indexOf(STRIP_START);
  const to = text.indexOf(STRIP_END, from);
  if (from === -1 || to === -1) {
    refuse(`${path} has no ${STRIP_START} … ${STRIP_END} block to fill.`);
  }
  return `${text.slice(0, from)}${want}${text.slice(to + STRIP_END.length)}`;
}
const generated = [
  ["README.md", splice("README.md", readmeStrip)],
  ["site/index.html", splice("site/index.html", siteStrip)],
];

const body = `// Generated by scripts/generate-about.mjs. Do not edit.
//
// The description of record is ABOUT.md and ABOUT-SHORT.md at the root of the
// byollm repository. Edit those, then run \`pnpm run about\`. \`verify\` fails
// when this file and they disagree, which is the one-source rule with teeth:
// the paragraph previously lived in hand-kept copies in another repository and
// a superseded draft nearly shipped.

/** The full description — five sections, plus why it matters. */
export const ABOUT = ${quote(full)};

/**
 * The first paragraph, which stands alone.
 *
 * What the welcome screen shows: somebody deciding whether to trust a site's
 * button needs the whole idea in one breath, not a page.
 */
export const ABOUT_SHORT_LEDE = ${quote(lede)};

/** The rest, for surfaces with room. Shown before "Learn more →". */
export const ABOUT_SHORT_TAIL = ${quote(tail)};

/** Both halves, for a surface that wants the paragraph entire. */
export const ABOUT_SHORT = \`\${ABOUT_SHORT_LEDE}\\n\\n\${ABOUT_SHORT_TAIL}\`;

// -- agent prompts -------------------------------------------------------------
//
// From AGENT-PROMPTS.md. The README strip and byo-llm.com's are generated from
// the same file, and agent-prompts.test.ts holds every command, docs anchor
// and package a prompt names to something that exists.

/** Who a prompt is for, which is also which path it sets up. */
export type AgentPromptAudience = "user" | "developer" | "operator";

/** One "paste this into your agent" prompt. */
export interface AgentPrompt {
  /** Stable, for anchors: \`agent-<id>\` on byo-llm.com. */
  readonly id: string;
  readonly title: string;
  readonly audience: AgentPromptAudience;
  /** Verbatim, line breaks included — what the copy button copies. */
  readonly prompt: string;
}

/** The heading every surface shows above the prompts. */
export const AGENT_PROMPTS_HEADING = ${quote(agentsHeading)};

/** The one line under it. */
export const AGENT_PROMPTS_LEDE = ${quote(agentsLede)};

/** Set up my computer, add BYOLLM to my site, run my own relay — in that order. */
export const AGENT_PROMPTS: readonly AgentPrompt[] = ${JSON.stringify(prompts, null, 2)};
`;

if (process.argv.includes("--check")) {
  let current;
  try {
    current = readText(OUT);
  } catch {
    // No generated file yet is drift too: the package would ship nothing
    // where the description of record should be.
    current = "";
  }
  const copies = [
    ["packages/protocol/ABOUT.md", `${full}\n`],
    ["packages/protocol/ABOUT-SHORT.md", `${short}\n`],
  ];
  const staleGenerated = generated
    .filter(([where, want]) => readText(join(ROOT, where)) !== want)
    .map(([where]) => where);
  const staleCopy = copies.find(([where, want]) => {
    try {
      return readText(join(ROOT, where)) !== want;
    } catch {
      return true;
    }
  });
  if (staleGenerated.length > 0) {
    process.stderr.write(
      `\n  ${staleGenerated.join(" and ")} ${staleGenerated.length === 1 ? "does" : "do"} not carry what AGENT-PROMPTS.md\n` +
        "  says. The prompts are generated, so editing a copy is editing\n" +
        "  nothing. Run `pnpm run about`.\n\n",
    );
    process.exit(1);
  }
  if (current !== body || staleCopy !== undefined) {
    process.stderr.write(
      "\n  packages/protocol/src/about.ts is not what ABOUT.md and\n" +
        "  ABOUT-SHORT.md say. One of them has drifted, and a description in\n" +
        "  two states is the defect the one-source rule exists to prevent.\n" +
        "  Run `pnpm run about`.\n\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    "about: the shipped text and the agent prompts match their files\n",
  );
} else {
  writeFileSync(OUT, body);
  // Shipped as markdown too, for anybody reading the package rather than
  // importing it — npm renders these, and a description you have to run a
  // bundler to read is a description most people will not read.
  writeFileSync(join(ROOT, "packages/protocol/ABOUT.md"), `${full}\n`);
  writeFileSync(join(ROOT, "packages/protocol/ABOUT-SHORT.md"), `${short}\n`);
  for (const [where, want] of generated) writeFileSync(join(ROOT, where), want);
  process.stdout.write(
    `wrote ${OUT}, the two markdown copies, and the agent prompts in README.md and site/index.html\n`,
  );
}

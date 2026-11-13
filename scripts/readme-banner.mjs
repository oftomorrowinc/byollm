/**
 * Which README line is the live version banner — one rule, two readers (#8620).
 *
 * `bump-version.mjs` renumbers the banner; `alpha-claims-match-the-version.mjs`
 * reads the banner as the start of the live warning. Both used to carry their
 * own regex for it, and the two regexes disagreed with each other and with
 * `release-note.mjs` in opposite directions:
 *
 * - The bumper matched `> **\`0.1.1\` …` as the banner, which is ALSO exactly
 *   how a release note opens. So every bump since 0.1.1 renumbered the note
 *   under `<!-- release-note 0.1.1 -->`, and at 0.1.5 the npm pages said
 *   "`0.1.5` is documentation only — no schema moved" over a release that
 *   ships four migrations.
 * - The gate matched `> **\`` as a release ENTRY, which is ALSO how the
 *   banner opens since the 0.1.0 flip. So its live-warning region ended on the
 *   banner line itself and the warning body below it read as history.
 *
 * The marker is what tells them apart, which is the reason `release-note.mjs`
 * writes one: a line inside a marked note — the marker, and the blockquote
 * that follows it — is history and is never the banner. The banner is the
 * shape OUTSIDE a marked note.
 */

/** The banner's shapes: the alpha one, and `**\`0.1.0\` — early.**` since the flip. */
export const README_BANNER = /^\s*>\s*\*\*(?:Alpha \(`|`\d+\.\d+\.\d)/i;

/** What `release-note.mjs` writes above every note, and nothing else writes. */
const NOTE_MARKER = /^\s*<!--\s*release-note\s+\S+\s*-->\s*$/;

/**
 * The indices of every line inside a marked release note: the marker, any
 * blank lines straight after it, and the blockquote that follows — to the
 * first line that leaves the blockquote.
 */
export const markedNoteLines = (lines) => {
  const marked = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (!NOTE_MARKER.test(lines[i] ?? "")) continue;
    marked.add(i);
    let j = i + 1;
    while (j < lines.length && (lines[j] ?? "").trim() === "") j += 1;
    while (j < lines.length && /^\s*>/.test(lines[j] ?? "")) {
      marked.add(j);
      j += 1;
    }
    i = j - 1;
  }
  return marked;
};

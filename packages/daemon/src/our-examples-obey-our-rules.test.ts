import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BACKEND_IDS,
  backendDescriptor,
  type BackendId,
} from "@byollm/protocol";

/**
 * Our own config examples obey the rule we ask owners to follow — B118.
 *
 * CW typed `127.0.0.1:11434` as `openai-http` in a README and **every check
 * passed**, because `DaemonConfig` accepts it: `openai-http` is a legal type
 * and a base URL is a base URL. The schema cannot refuse it and should not —
 * somebody may genuinely be running something else on that port, and B116's
 * whole ruling is that we do not infer a provider from an address in
 * SOMEBODY'S config.
 *
 * **A README is different, because a README is us teaching.** We may assert
 * about our own examples what we refuse to infer about a stranger's machine —
 * and it matters more here than in any one config, because an example is
 * copied.
 *
 * What it costs to get wrong is not cosmetic. `startCommandFor` switches on
 * `type`, so **`openai-http` is the one shape that cannot be started on
 * demand**: an example teaching it at Ollama's port teaches a config whose
 * server byollm will never start for them, and the failure arrives later as a
 * job that did not run.
 *
 * ## The port table is the registry's, not ours
 *
 * Written as a second list here, this check would be the thing it guards
 * against: a copy of a fact, going stale beside its source. `backendDescriptor`
 * already knows every provider's default address, so a provider added next
 * month is covered without anybody editing this.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Every markdown file we ship, docs and specs alike. */
function markdown(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (
      ["node_modules", ".git", "dist", ".tsbuild", "_stale_locks"].includes(
        entry,
      )
    ) {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) markdown(path, found);
    else if (entry.endsWith(".md")) found.push(path);
  }
  return found;
}

/** Which provider owns this origin, asked of the registry. */
function ownerOf(baseUrl: string): BackendId | undefined {
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
  for (const id of BACKEND_IDS) {
    const address = backendDescriptor(id).defaultBaseUrl;
    if (address === undefined) continue;
    try {
      if (new URL(address).origin === origin) return id;
    } catch {
      /* A registry entry with an unparseable address matches nothing. */
    }
  }
  return undefined;
}

/**
 * Every `"type"`/`"baseUrl"` pair in our markdown, however it is laid out.
 *
 * Line-based rather than JSON-parsed, deliberately: our examples are fenced
 * snippets and fragments — `"services": { … }` with no enclosing object, a
 * `<!-- release-note -->` block quoted with `>` — and a parser would skip
 * exactly the ones a reader copies. The pairing is by proximity, which is what
 * a reader does too.
 */
function typedAddresses(): {
  file: string;
  line: number;
  type: string;
  baseUrl: string;
}[] {
  const found: { file: string; line: number; type: string; baseUrl: string }[] =
    [];
  for (const file of markdown(ROOT)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, at) => {
      const type = /"type"\s*:\s*"([^"]+)"/.exec(line)?.[1];
      if (type === undefined) return;
      /* Same line, or the next two — the three layouts our docs actually
         use. Looking further would start pairing across services. */
      for (const near of [line, lines[at + 1] ?? "", lines[at + 2] ?? ""]) {
        const baseUrl = /"baseUrl"\s*:\s*"([^"]+)"/.exec(near)?.[1];
        if (baseUrl !== undefined) {
          found.push({
            file: file.slice(ROOT.length),
            line: at + 1,
            type,
            baseUrl,
          });
          return;
        }
      }
    });
  }
  return found;
}

describe("the config examples in our own documentation", () => {
  it("finds examples at all, or this asserts nothing", () => {
    /* The control, and it is not ceremony: a regex that stopped matching —
       formatting change, a move to MDX — would make every case below pass by
       reading an empty list, which looks exactly like agreement. */
    expect(typedAddresses().length).toBeGreaterThan(2);
  });

  it("never teaches the generic type at an address a provider owns", () => {
    const taught = typedAddresses()
      .map((example) => ({ ...example, owner: ownerOf(example.baseUrl) }))
      .filter(
        (example) =>
          example.owner !== undefined && example.type !== example.owner,
      );

    expect(
      taught.map(
        (example) =>
          `${example.file}:${String(example.line)} teaches "${example.type}" ` +
          `at ${example.baseUrl}, which is ${String(example.owner)}`,
      ),
      "an example naming the generic type at a provider's own port teaches a " +
        "config byollm cannot start on demand — B116, B118",
    ).toEqual([]);
  });

  it("leaves an unknown port alone, which is what the generic type is FOR", () => {
    /**
     * The control on the rule, and the reason it is a port table rather than a
     * ban: `byollm_016` teaches `openai-http` at `127.0.0.1:6999`, and that is
     * exactly right — `openai-http` is how you name a server byollm does not
     * know. A check that flagged it would be teaching the opposite mistake.
     */
    expect(ownerOf("http://127.0.0.1:6999/v1")).toBeUndefined();
    expect(ownerOf("http://127.0.0.1:11434/v1")).toBe("ollama");
  });
});

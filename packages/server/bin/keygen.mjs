#!/usr/bin/env node
/**
 * `npx @byollm/server keygen` — make a site identity, once.
 *
 * Prints an env-file fragment. Deliberately not written to a file: key
 * material that lands on disk by default tends to end up committed, and the
 * one place it should live is wherever this deployment keeps its secrets.
 */
import { formatSiteKeys, generateSiteKeys } from "../dist/index.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(
    "usage: npx @byollm/server keygen\n\n" +
      "Generates this site's byollm identity and prints it as an env line.\n" +
      "Run it once. Store the result as a secret. Regenerating it makes every\n" +
      "daemon that has paired with this site pair again.\n",
  );
  process.exit(0);
}

process.stdout.write(formatSiteKeys(generateSiteKeys()));

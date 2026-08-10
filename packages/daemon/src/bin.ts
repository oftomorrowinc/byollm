#!/usr/bin/env node
/**
 * The `byollm` executable.
 *
 * Deliberately the only module in this package that *does* something on
 * import. `cli.ts` stays a pure module so it can be imported as a library —
 * and so the bundler cannot hoist the command implementations into a shared
 * chunk and leave this entry with nothing to run, which is exactly what
 * happened when the two were the same file.
 */
import { main } from "./cli.js";

process.exitCode = await main(process.argv.slice(2));

/**
 * Everything a BROWSER needs, and nothing that needs Node — B018c.
 *
 * ## Why this file exists rather than a subpath per module
 *
 * The browser end of a console session is a real implementation of this
 * protocol, and it cannot use `seal`/`open` because those sign with
 * `node:crypto`. What it must not have is its own idea of the FORMAT — so it
 * imports the same definitions the daemon does, through this door.
 *
 * The door had to be built twice. First `envelope-format.ts` was made portable
 * and proved portable, and a bundler still failed on `Can't resolve 'net'`:
 * the only export was the barrel, which pulls the whole protocol. Then the
 * format got its own export and a bundler failed AGAIN, because the console
 * types reached the browser only through `keys.ts`.
 *
 * **Portability is a property of the reachable graph, not of a file.** One
 * entry that names the whole reachable set is the shape that makes that
 * checkable, which `envelope-is-portable.test.ts` then does — on this file,
 * on what it re-exports, and on what the build emits.
 *
 * ## What is deliberately NOT here
 *
 * Key generation, signing, verifying, sealing. Those are primitives, and each
 * end brings its own — Node's on the daemon, libsodium's in the tab. The
 * format is shared; the crypto is not. That is option 2 as ruled, and this
 * file is the line it draws.
 */

export {
  ENVELOPE_BODY_VERSION,
  decodeEnvelopeInner,
  encodeEnvelopeInner,
  envelopeSignedBody,
  fromBase64Url,
  toBase64Url,
  type EnvelopeBodyContext,
  type EnvelopeInner,
} from "./envelope-format.js";

export { PublicIdentity } from "./public-identity.js";

export {
  CONSOLE_FRAME_VERSION,
  CONSOLE_MAX_DATA_BYTES,
  ConsoleBye,
  ConsoleFrame,
  ConsoleHello,
  ConsoleResize,
  ConsoleStdin,
  ConsoleStdout,
  consoleDataBytes,
  consoleEnvelope,
  consoleOrder,
  decodeConsoleData,
  encodeConsoleData,
  type ConsoleOrder,
  type ConsoleOrderFault,
  type ConsoleOrderResult,
} from "./console.js";

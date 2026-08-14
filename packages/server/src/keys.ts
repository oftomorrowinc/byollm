import { StoredKeys, generateKeys, publicIdentityOf } from "@byollm/protocol";
import { fingerprint } from "@byollm/protocol";

/**
 * A site's keypairs — byollm_009 §5.
 *
 * **Generate once, store, supply.** Not at startup, and not per process.
 *
 * A site is usually more than one process: several instances behind a load
 * balancer, or a serverless function whose module is evaluated per cold
 * start. Keys generated at startup would give each of those a different
 * identity. A daemon pins whichever one approved its pairing, and then every
 * request routed to a different instance fails a signature check with nothing
 * in the error explaining why — a failure that appears only under
 * horizontal scale, which is to say only in production.
 *
 * So the library takes keys as an input and never invents them. That is the
 * whole reason this module is three functions rather than a lazy singleton.
 */

/** Make a fresh site identity. Call this once, ever, and keep the result. */
export const generateSiteKeys = (now: number = Date.now()): StoredKeys =>
  generateKeys(now);

/**
 * Read site keys from an environment variable holding base64 JSON.
 *
 * The shape a deployment actually wants: one opaque secret, set the way every
 * other secret is set, with no file to mount and no key material in the
 * repository.
 *
 * @throws with a message naming the variable and the fix, because this fails
 * at boot and the person reading the log is the person who can fix it.
 */
export function siteKeysFromEnv(
  variable = "BYOLLM_SITE_KEYS",
  env: NodeJS.ProcessEnv = process.env,
): StoredKeys {
  const raw = env[variable];
  if (raw === undefined || raw === "") {
    throw new Error(
      `${variable} is not set. Generate a site identity once with ` +
        `\`npx @byollm/server keygen\` and set it as ${variable}. ` +
        `Do not generate keys at startup: every instance would get a ` +
        `different identity and daemons would pin one and be refused by ` +
        `another.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw new Error(
      `${variable} is not base64-encoded JSON. It should be exactly what ` +
        `\`npx @byollm/server keygen\` printed.`,
    );
  }

  const result = StoredKeys.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `${variable} does not contain a valid site identity. Regenerate it ` +
        `with \`npx @byollm/server keygen\` — and if this site has already ` +
        `paired daemons, they will need to pair again.`,
    );
  }
  return result.data;
}

/** What to print from `keygen`: the secret to store, and how to check it. */
export function formatSiteKeys(keys: StoredKeys): string {
  const encoded = Buffer.from(JSON.stringify(keys)).toString("base64");
  return (
    `# Set this as BYOLLM_SITE_KEYS. It is a secret: it is this site's\n` +
    `# identity, and anything holding it can be this site.\n` +
    `BYOLLM_SITE_KEYS=${encoded}\n` +
    `\n` +
    `# Fingerprint (not secret — show it to users so they can check what\n` +
    `# their daemon pinned):\n` +
    `# ${fingerprint(publicIdentityOf(keys).identity)}\n`
  );
}

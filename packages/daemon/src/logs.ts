import { stripControlChars, type IngressEntry } from "./ingress.js";

/**
 * `byollm logs` — what this device did with its jobs, one line per event, in
 * words a person reads at a console (#9547).
 *
 * Why it exists: on two hub rolls box-1 claimed the roll's proof job and
 * never answered, and the only way to learn that was `kubectl exec … grep` on
 * the ingress log. A hosted box's owner has a `byollm>` console and no
 * kubectl, and `byollm status` names the log file without being able to show
 * it.
 *
 * `byollm log` is still the prompt reader — the meter, whose subject is WHAT
 * ran. This is the event reader, whose subject is what HAPPENED: claimed,
 * started, answered, failed, or started and nothing since. It never prints a
 * prompt or a tool call's arguments, for anybody, whatever the log still
 * holds: only their size and the first characters of their hash. So it shows
 * none of another person's prompt, inside the 7-day window or after it.
 *
 * Every free-text field it does print — a failure's detail, a memory
 * decision's reason, a model or tool name — goes through {@link redact} and
 * {@link stripControlChars} on the way to the screen. The log is the device's
 * own record of what arrived, and a vendor CLI that echoed a key into its
 * error message is exactly the line somebody pastes into a support thread.
 */

/** Which job a line belongs to. A job id belongs to a site (V1-3). */
function jobKey(entry: { jobId: string; site?: string | undefined }): string {
  return `${entry.site ?? ""}\u0000${entry.jobId}`;
}

/** The time, as `byollm log` prints it — UTC, to the second. */
function clock(at: number): string {
  return new Date(at).toISOString().replace("T", " ").slice(0, 19);
}

/** `12.4 s`, or `412 s (6 min)` once the seconds stop being readable. */
function seconds(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  const whole = Math.round(s);
  if (whole < 120) return `${String(whole)} s`;
  const minutes = Math.floor(whole / 60);
  const human =
    minutes < 120
      ? `${String(minutes)} min`
      : `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`;
  return `${String(whole)} s (${human})`;
}

/**
 * Shapes that are credentials whatever field they turn up in.
 *
 * Not a promise to recognise every key ever issued — the promise is that the
 * log carries none, and this is the second fence for the one place one could
 * slip in: an error message somebody else's software wrote.
 */
const SECRET_SHAPES: readonly [RegExp, string][] = [
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "[redacted key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted token]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted key]"],
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    "[redacted token]",
  ],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [
    /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|authorization)["']?\s*[=:]\s*)["']?[^\s"',;]+/gi,
    "$1[redacted]",
  ],
];

/** An environment variable whose value is somebody's credential. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE/i;

/**
 * Remove anything that is, or looks like, a key, a token or a secret
 * environment value.
 *
 * The environment check is by value: whatever a variable named like a
 * credential holds on THIS machine is replaced wherever it appears, so a key
 * that does not match any shape above is still never printed by the process
 * that was handed it.
 */
export function redact(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < 6 || !SECRET_NAME.test(name)) {
      continue;
    }
    out = out.split(value).join(`[redacted ${name}]`);
  }
  for (const [shape, replacement] of SECRET_SHAPES) {
    out = out.replace(shape, replacement);
  }
  return out;
}

/** Free text from the log, made safe and kept to one line. */
function said(text: string, env: NodeJS.ProcessEnv, max = 240): string {
  const one = redact(stripControlChars(text), env).replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** `https://hub.byo-llm.com` → `hub.byo-llm.com`; anything else as it is. */
function host(site: string): string {
  try {
    return new URL(site).host;
  } catch {
    return site;
  }
}

/**
 * Turns log entries into lines, remembering what each job is.
 *
 * Stateful because the log is: the kind is on the claim and the prompt, the
 * service only on the prompt, and an outcome line carries neither. Fed in
 * order — a whole file, then each slice `--follow` reads — it can always name
 * both for a line that does not say them itself.
 */
export class LogRenderer {
  readonly #jobs = new Map<string, { kind?: string; service?: string }>();
  readonly #env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#env = env;
  }

  /** One line for one entry. */
  render(entry: IngressEntry): string {
    const id = "jobId" in entry ? entry.jobId : undefined;
    const known =
      id === undefined
        ? {}
        : (this.#jobs.get(jobKey({ jobId: id, site: siteOf(entry) })) ?? {});
    const job = { ...known };
    if (entry.type === "claim") job.kind = entry.kind;
    if (entry.type === "prompt") {
      job.kind = entry.kind;
      job.service = entry.backendId;
    }
    if (id !== undefined) {
      this.#jobs.set(jobKey({ jobId: id, site: siteOf(entry) }), job);
    }
    const service =
      entry.type === "memory" ? entry.backendId : (job.service ?? "-");
    return (
      `${clock(entry.at)}  ${(id ?? "-").slice(0, 8).padEnd(8)}  ` +
      `${(job.kind ?? "-").padEnd(6)}  ${said(service, this.#env).padEnd(7)}  ` +
      this.#what(entry)
    );
  }

  #what(entry: IngressEntry): string {
    const env = this.#env;
    switch (entry.type) {
      case "claim":
        return (
          `claimed — ${entry.audience === "private" ? "your own job" : `a ${entry.audience} job`}` +
          (entry.site === undefined
            ? ""
            : ` from ${said(host(entry.site), env)}`)
        );
      case "prompt":
        return (
          `started on ${said(entry.model, env)} — ` +
          `${entry.audience === "private" ? "your" : `a ${entry.audience}`} prompt of ` +
          `${String(entry.promptChars)} chars, not shown ` +
          `(sha256 ${entry.promptHash.slice(0, 12)}…` +
          `${entry.prompt === undefined ? ", text no longer kept" : ""})`
        );
      case "outcome": {
        const took =
          entry.durationMs === undefined
            ? ""
            : ` after ${seconds(entry.durationMs)}`;
        const why =
          entry.detail === undefined ? "" : `: ${said(entry.detail, env)}`;
        return {
          ok:
            `answered${took.replace(" after", " in")}` +
            (entry.outputChars === undefined
              ? ""
              : `, ${String(entry.outputChars)} chars`),
          error: `failed${took}${why}`,
          canceled: `canceled${took}${why}`,
          refused: `refused${why}`,
        }[entry.outcome];
      }
      case "memory":
        return (
          `memory ${entry.admit ? "admitted" : "REFUSED"} the job: ` +
          `${said(entry.why, env)} (pressure ${entry.pressure})`
        );
      case "tool-call":
        return (
          `tool call ${String(entry.seq)} asked for ${said(entry.name, env, 60)} ` +
          `— arguments not shown (${String(entry.argumentsChars)} chars)`
        );
      case "tool-outcome":
        return (
          `tool call ${String(entry.seq)} ${entry.outcome}` +
          (entry.chars === undefined ? "" : `, ${String(entry.chars)} chars`) +
          (entry.detail === undefined ? "" : `: ${said(entry.detail, env)}`)
        );
      case "tool-dropped":
        return `tool result dropped: ${said(entry.why, env)}`;
    }
  }
}

function siteOf(entry: IngressEntry): string | undefined {
  return "site" in entry ? entry.site : undefined;
}

/** The jobs in a log whose id starts with `prefix` — one per site and id. */
export function jobsMatching(
  entries: readonly IngressEntry[],
  prefix: string,
): { jobId: string; site?: string }[] {
  const found = new Map<string, { jobId: string; site?: string }>();
  for (const entry of entries) {
    if (!("jobId" in entry) || entry.jobId === undefined) continue;
    if (!entry.jobId.startsWith(prefix)) continue;
    const site = siteOf(entry);
    found.set(jobKey({ jobId: entry.jobId, site }), {
      jobId: entry.jobId,
      ...(site === undefined ? {} : { site }),
    });
  }
  /* An exact id is never ambiguous with the longer ids it prefixes. */
  const exact = [...found.values()].filter((job) => job.jobId === prefix);
  return exact.length > 0 ? exact : [...found.values()];
}

/** Whether an entry belongs to this job. */
export function isOf(
  entry: IngressEntry,
  job: { jobId: string; site?: string | undefined },
): boolean {
  return (
    "jobId" in entry &&
    entry.jobId === job.jobId &&
    (job.site === undefined || siteOf(entry) === job.site)
  );
}

/**
 * Where one job stands, in a sentence — from its own lines, oldest first.
 *
 * Read from the LAST of its claim, prompt and outcome lines, because a job
 * can be offered to a device more than once: what it did the first time is
 * history, and what it did last is the answer.
 */
export function standing(
  lines: readonly IngressEntry[],
  now: number,
  env: NodeJS.ProcessEnv = process.env,
): { settled: boolean; text: string } {
  const steps = lines.filter(
    (entry) =>
      entry.type === "claim" ||
      entry.type === "prompt" ||
      entry.type === "outcome",
  );
  const last = steps.at(-1);
  const starts = steps.filter((entry) => entry.type === "prompt");
  const again =
    starts.length > 1 ? ` (started ${String(starts.length)} times)` : "";
  if (last === undefined) {
    return {
      settled: false,
      text: "nothing recorded yet: no claim, start or result for this job",
    };
  }
  if (last.type === "claim") {
    return {
      settled: false,
      text:
        `claimed at ${clock(last.at)} and not started: ` +
        `no prompt line after ${seconds(now - last.at)}${again}`,
    };
  }
  if (last.type === "prompt") {
    return {
      settled: false,
      text:
        `started at ${clock(last.at)} and no result after ` +
        `${seconds(now - last.at)}${again}`,
    };
  }
  const why =
    last.detail === undefined ? "" : ` — ${said(last.detail, env, 400)}`;
  const took =
    last.durationMs === undefined ? "" : ` after ${seconds(last.durationMs)}`;
  const word = {
    ok: `answered at ${clock(last.at)}${took.replace(" after", ", in")}`,
    error: `failed at ${clock(last.at)}${took}${why}`,
    canceled: `canceled at ${clock(last.at)}${took}${why}`,
    refused: `refused at ${clock(last.at)}${why}`,
  }[last.outcome];
  return { settled: true, text: `${word}${again}` };
}

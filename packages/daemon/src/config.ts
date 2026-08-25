import { readFile } from "node:fs/promises";
import {
  BackendIdSchema,
  JobKind,
  OfferScope,
  backendDescriptor,
  effectiveOfferScope,
  resolveCost,
  type BackendCost,
  type BackendId,
} from "@byollm/protocol";
import { z } from "zod";
import { checkBaseUrl } from "./ssrf.js";

/**
 * One configured backend instance.
 *
 * `openai-http` may be configured many times — one per model server the owner
 * runs (Ollama here, `mlx_lm.server` there, a llama.cpp box on the LAN). That
 * is byollm_001 Rev 1 §A's "one backend, N base URLs".
 */
export const ServiceConfig = z
  .object({
    /**
     * How it is reached — the transport, not the thing.
     *
     * Renamed from `backend` because that was the noun doing the work, and it
     * named the wrong thing: an owner running two Ollama models has two
     * services and one transport. The service is what they think about and
     * what they will name; the transport is a detail of reaching it.
     */
    type: BackendIdSchema,
    /** Required for HTTP-class transports; meaningless for process-class. */
    baseUrl: z.string().optional(),
    /**
     * The model this service serves. Owner-chosen; a payload can never
     * influence it ({@link MUSTS.NO_PAYLOAD_ROUTING}).
     *
     * Moved here from the route, which is the whole reorganization in one
     * field: the model was a property of *what serves a kind*, and that thing
     * had no name. Now it does.
     */
    model: z.string().min(1),
    /**
     * What this service answers.
     *
     * Declared, then detected — declaring a kind does not advertise it
     * ({@link MUSTS.CAPABILITY_IS_DETECTED}). A kind that cannot be served is
     * dropped with a loud problem, never a silent advertisement.
     */
    kinds: z.array(JobKind).min(1),
    /**
     * What the owner is willing to run for others, **per service** — which is
     * what owners actually mean. Subscription-class services ignore this and
     * are locked to `self` ({@link MUSTS.SUBSCRIPTION_SELF_LOCK}).
     */
    offer: OfferScope.default("private"),
    /**
     * Name of an environment variable holding this backend's API key, for a
     * remote OpenAI-compatible server that needs one. The *name*, never the
     * value — a key does not belong in a config file the owner may share.
     */
    apiKeyEnv: z.string().optional(),
    /**
     * Required before a `metered` backend may be offered past `self`
     * ({@link MUSTS.METERED_DEFAULTS_SELF}). There is deliberately no `cost`
     * field: a provider's cost class comes from the protocol registry and is
     * not the owner's to declare ({@link MUSTS.COST_NOT_CONFIGURABLE}).
     */
    spend: z
      .object({
        /** Set by `byollm offer`, which states the consequence in words. */
        acknowledged: z.boolean().default(false),
        /**
         * Ceiling on community spend, in whole cents, per day. A widened
         * metered backend without one is refused
         * ({@link MUSTS.METERED_REQUIRES_CEILING}) — "unlimited" is not a
         * thing an owner can mean by accident.
         */
        dailyCapCents: z.number().int().positive().optional(),
        /**
         * What this provider charges, for the ceiling estimate. Providers do
         * not return a price, so the owner supplies one; the default is
         * deliberately high so an unset rate trips the brake early rather
         * than late.
         */
        centsPerMillionTokens: z.number().positive().default(1500),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ServiceConfig = z.infer<typeof ServiceConfig>;

/**
 * Budgets applied to jobs whose owner is not this machine's owner
 * ({@link MUSTS.COMMUNITY_BUDGETS}).
 */
export const CommunityBudget = z
  .object({
    maxJobsPerHour: z.number().int().positive().default(20),
    maxJobsPerDay: z.number().int().positive().default(100),
    /** Wall-clock ceiling for one community job. */
    maxWallClockMs: z.number().int().positive().default(120_000),
    /** Output-size ceiling for one community job. */
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .default(256 * 1024),
    /** Payload-size ceiling — stricter than the protocol's absolute limit. */
    maxPayloadChars: z.number().int().positive().default(100_000),
  })
  .strict();
export type CommunityBudget = z.infer<typeof CommunityBudget>;

/** Ingress-log retention (byollm_004 Rev 1). */
export const IngressRetention = z
  .object({
    /**
     * How long a `named`/`public` prompt is kept in full before being reduced
     * to a hash. A volunteer must not indefinitely retain strangers' content.
     */
    communityPromptDays: z.number().int().positive().default(7),
    /** Whether the owner's own prompts are kept in full. Their call. */
    keepSelfPrompts: z.boolean().default(true),
  })
  .strict();
export type IngressRetention = z.infer<typeof IngressRetention>;

/** Ceilings applied to every job, community or not. */
export const Limits = z
  .object({
    maxWallClockMs: z.number().int().positive().default(600_000),
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .default(4 * 1024 * 1024),
  })
  .strict();
export type Limits = z.infer<typeof Limits>;

export const DaemonConfig = z
  .object({
    /**
     * The services this device runs, by the names their owner gave them.
     *
     * A name is the owner's word — `qwen`, `gwen-voice`, `claude` — and it is
     * what a job may later select. It is never a model id and never a vendor.
     */
    services: z.record(z.string().min(1), ServiceConfig),
    /**
     * Which service serves a kind when a job does not say.
     *
     * Optional, and it earns its place only under ambiguity: one service
     * offering a kind simply serves it. Two or more and the config will not
     * load without a default — loudly, in the owner's terminal, rather than
     * as a job-time mystery three hops away.
     *
     * `partialRecord`, not `record`: an owner with an ambiguous
     * `llm.generate` and a single `llm.chat` needs a default for one and not
     * the other.
     */
    defaults: z.partialRecord(JobKind, z.string().min(1)).prefault({}),
    /** How many jobs to run at once. */
    concurrency: z.number().int().min(1).max(32).default(2),
    // `prefault`, not `default`: zod 4's `.default()` takes an *output* value,
    // which would mean restating every nested default here where it could
    // drift. `prefault` feeds `{}` through the schema so the nested defaults
    // stay the single source of truth.
    community: CommunityBudget.prefault({}),
    ingress: IngressRetention.prefault({}),
    limits: Limits.prefault({}),
  })
  .strict();
export type DaemonConfig = z.infer<typeof DaemonConfig>;

/** One kind, served by one named service, ready to execute. */
export interface ResolvedRoute {
  readonly kind: z.infer<typeof JobKind>;
  /**
   * The owner's name for the service serving this kind.
   *
   * Carried onto the wire in the capability matrix, so a device advertises
   * *which* of its services answers a kind rather than only that something
   * does. Phase B lets a job select by this name.
   */
  readonly service: string;
  readonly backendId: BackendId;
  readonly backendClass: "http" | "process";
  readonly model: string;
  /** Who pays for this route's tokens. From the registry, never from config. */
  readonly cost: BackendCost;
  /** After the cost rules are applied — never the raw configured value. */
  readonly offerScope: z.infer<typeof OfferScope>;
  /** The owner's spend consent, for a `metered` route. */
  readonly spendAcknowledged: boolean;
  readonly spendDailyCapCents: number | undefined;
  readonly spendCentsPerMillionTokens: number;
  readonly baseUrl: string | undefined;
  readonly apiKeyEnv: string | undefined;
}

export interface ConfigProblem {
  readonly where: string;
  readonly message: string;
}

/**
 * A kind this device could serve and deliberately does not.
 *
 * Withholding has to be *loud on the owner's side*, in every surface that
 * could otherwise show absence. An owner who adds a second `llm.generate`
 * service and finds their team's jobs quietly stop matching, with nothing
 * anywhere saying why, has been failed by the correct behaviour — which is
 * the quiet kind of correct this project keeps deleting.
 */
interface WithheldKind {
  readonly kind: z.infer<typeof JobKind>;
  /** The services that answer it, any of which the owner could name. */
  readonly services: readonly string[];
}

export interface LoadedConfig {
  readonly config: DaemonConfig;
  readonly routes: readonly ResolvedRoute[];
  /** Kinds not advertised because the owner has not said which service wins. */
  readonly withheld: readonly WithheldKind[];
  /**
   * What this build cannot yet do, in the owner's words.
   *
   * Separate from `problems` on purpose: a problem means the config says
   * something wrong and something was dropped. A notice means the config is
   * fine and *the build* is behind it. Folding the two would make every
   * limitation read as an owner's mistake — and would make a genuine mistake
   * easier to miss among them.
   */
  readonly notices: readonly string[];
  /** Non-fatal problems: a route that cannot be served is dropped, not fatal. */
  readonly problems: readonly ConfigProblem[];
}

/** The config used when the owner has not written one. */
export const DEFAULT_CONFIG: DaemonConfig = DaemonConfig.parse({
  services: {
    ollama: {
      type: "openai-http",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      kinds: ["llm.generate", "llm.chat"],
    },
  },
});

/**
 * Read and resolve `~/.byollm/config.json`.
 *
 * A missing file yields {@link DEFAULT_CONFIG}; a malformed one throws,
 * because silently running with defaults when the owner *did* write a config
 * would execute work under rules they did not choose.
 */
export async function loadConfig(path: string): Promise<LoadedConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return resolveConfig(DEFAULT_CONFIG);
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : "unknown error"}`,
      { cause: error },
    );
  }

  const result = DaemonConfig.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`${path} is not a valid byollm config:\n${issues}`);
  }
  return resolveConfig(result.data);
}

/**
 * Turn a parsed config into executable routes, applying the subscription lock
 * and rejecting unusable backends.
 *
 * A problem here is not fatal: a machine with three routes and one broken
 * backend should serve the other two and say so, rather than refusing to
 * start. What it must never do is *advertise* the broken one
 * ({@link MUSTS.CAPABILITY_IS_DETECTED}).
 */
export function resolveConfig(config: DaemonConfig): LoadedConfig {
  const routes: ResolvedRoute[] = [];
  const problems: ConfigProblem[] = [];
  const withheld: WithheldKind[] = [];
  const notices: string[] = [];

  /**
   * Who claims each kind, decided before anything is resolved.
   *
   * Ambiguity is a property of the whole config, not of one service, so it
   * cannot be judged inside the loop that walks them.
   */
  const claimants = new Map<z.infer<typeof JobKind>, string[]>();
  for (const [name, service] of Object.entries(config.services)) {
    for (const kind of service.kinds) {
      claimants.set(kind, [...(claimants.get(kind) ?? []), name]);
    }
  }

  /**
   * Which service actually serves each kind.
   *
   * One claimant serves without ceremony. Two or more need the owner to say,
   * and until they do the kind is **not advertised at all** — a device that
   * announced a kind it could not resolve deterministically would turn a
   * config ambiguity into a job-time mystery three hops away, which is the
   * shape this whole reorganization exists to remove.
   */
  const serves = new Map<z.infer<typeof JobKind>, string>();
  for (const [kind, names] of claimants) {
    const [sole] = names;
    if (names.length === 1 && sole !== undefined) {
      serves.set(kind, sole);
      continue;
    }
    const chosen = config.defaults[kind];
    if (chosen === undefined) {
      problems.push({
        where: `defaults.${kind}`,
        message:
          `${String(names.length)} services answer ${kind} (${names.join(", ")}) ` +
          `— set defaults.${kind} to the one that should serve it. Until then ` +
          `${kind} is not advertised.`,
      });
      withheld.push({ kind, services: names });
      continue;
    }
    if (!names.includes(chosen)) {
      problems.push({
        where: `defaults.${kind}`,
        message: `"${chosen}" does not answer ${kind}. It is served by: ${names.join(", ")}.`,
      });
      // Withheld for the same reason and reported the same way: the owner
      // said something, and it did not resolve.
      withheld.push({ kind, services: names });
      continue;
    }
    serves.set(kind, chosen);
  }

  for (const [name, service] of Object.entries(config.services)) {
    const where = `services.${name}`;
    const descriptor = backendDescriptor(service.type);

    // A named provider supplies its own address; the generic transport and any
    // override still have to be given one.
    const baseUrl = service.baseUrl ?? descriptor.defaultBaseUrl;

    if (descriptor.class === "http") {
      if (baseUrl === undefined) {
        problems.push({
          where,
          message: "an HTTP-class service needs a baseUrl",
        });
        continue;
      }
      const check = checkBaseUrl(baseUrl);
      if (!check.ok) {
        problems.push({ where: `${where}.baseUrl`, message: check.detail });
        continue;
      }
    }

    // Cost comes from the registry, or from where the request goes — never
    // from config ({@link MUSTS.COST_NOT_CONFIGURABLE},
    // {@link MUSTS.REMOTE_IS_NEVER_FREE}).
    const cost = resolveCost(service.type, baseUrl, service.model);
    const acknowledged = service.spend?.acknowledged === true;
    const capCents = service.spend?.dailyCapCents;

    // A widened metered service without a ceiling is refused rather than
    // silently given an unlimited one ({@link MUSTS.METERED_REQUIRES_CEILING}).
    const widened = service.offer !== "private";
    if (
      cost === "metered" &&
      widened &&
      acknowledged &&
      capCents === undefined
    ) {
      problems.push({
        where: `${where}.spend`,
        message:
          "sharing a metered service needs spend.dailyCapCents — an " +
          "unlimited ceiling is not something anyone means on purpose",
      });
      continue;
    }

    const configured = service.offer;
    const offerScope = effectiveOfferScope(configured, cost, {
      acknowledged: acknowledged && capCents !== undefined,
    });
    if (offerScope !== configured) {
      problems.push({
        where: `${where}.offer`,
        message:
          cost === "subscription"
            ? `"${configured}" was ignored: ${descriptor.label} runs on your ` +
              `own subscription, so it is locked to your work only`
            : `"${configured}" was narrowed to "self": ${descriptor.label} ` +
              `bills you per token. \`byollm offer ${name} ` +
              `${configured}\` to share it deliberately, with a ceiling`,
      });
    }

    for (const kind of service.kinds) {
      // Only the service that serves this kind is advertised. A second
      // claimant is configured and idle until Phase B lets a job name it —
      // advertising it now would promise a selection nothing can make.
      if (serves.get(kind) !== name) continue;
      routes.push({
        kind,
        service: name,
        backendId: service.type,
        backendClass: descriptor.class,
        model: service.model,
        cost,
        offerScope,
        spendAcknowledged: acknowledged,
        spendDailyCapCents: capCents,
        spendCentsPerMillionTokens:
          service.spend?.centsPerMillionTokens ?? 1500,
        baseUrl,
        apiKeyEnv: service.apiKeyEnv,
      });
    }
  }

  /**
   * The build says what `team` currently means — byollm_016, 2026-08-24.
   *
   * `team` is named for central membership: the device follows the owner's
   * roster, synced down the projection path, with a local `disallow` surviving
   * as a veto. That sync is not built. Until it is, `team` enforces through the
   * same local allowlist `named` did.
   *
   * Announced here rather than in release notes, because release notes are not
   * where an owner is looking when they write `"offer": "team"` and reasonably
   * conclude their roster is now in force. A name that runs ahead of its
   * behaviour has to say so in the place the name is used.
   */
  if (Object.values(config.services).some((s) => s.offer === "team")) {
    notices.push(
      "team enforcement is local-allowlist in this build; roster sync lands " +
        "next. `byollm allow` still decides who may run work here.",
    );
  }

  return { config, routes, withheld, notices, problems };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

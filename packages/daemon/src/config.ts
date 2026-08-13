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
export const BackendConfig = z
  .object({
    backend: BackendIdSchema,
    /** Required for HTTP-class backends; meaningless for process-class. */
    baseUrl: z.string().optional(),
    /**
     * What the owner is willing to run for others. Subscription-class
     * backends ignore this and are locked to `self`
     * ({@link MUSTS.SUBSCRIPTION_SELF_LOCK}).
     */
    offer: OfferScope.default("self"),
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
export type BackendConfig = z.infer<typeof BackendConfig>;

/** Which backend instance and model serves a job kind. */
export const RouteConfig = z
  .object({
    /** Key into {@link DaemonConfig.backends}. */
    backend: z.string().min(1),
    /** The model name, owner-chosen. A payload can never influence this. */
    model: z.string().min(1),
  })
  .strict();
export type RouteConfig = z.infer<typeof RouteConfig>;

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
    backends: z.record(z.string().min(1), BackendConfig),
    // `partialRecord`, not `record`: zod 4's `record` with an enum key
    // demands every member be present, which would force an owner who only
    // wants `llm.generate` to also configure `llm.chat`. Routing one kind and
    // not the other is a legitimate setup — the unrouted kind is simply never
    // advertised.
    routes: z.partialRecord(JobKind, RouteConfig),
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

/** A route resolved against its backend, ready to execute. */
export interface ResolvedRoute {
  readonly kind: z.infer<typeof JobKind>;
  readonly backendKey: string;
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

export interface LoadedConfig {
  readonly config: DaemonConfig;
  readonly routes: readonly ResolvedRoute[];
  /** Non-fatal problems: a route that cannot be served is dropped, not fatal. */
  readonly problems: readonly ConfigProblem[];
}

/** The config used when the owner has not written one. */
export const DEFAULT_CONFIG: DaemonConfig = DaemonConfig.parse({
  backends: {
    ollama: { backend: "openai-http", baseUrl: "http://127.0.0.1:11434/v1" },
  },
  routes: {
    "llm.generate": { backend: "ollama", model: "llama3.2" },
    "llm.chat": { backend: "ollama", model: "llama3.2" },
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

  for (const [kind, route] of Object.entries(config.routes)) {
    const where = `routes.${kind}`;
    const backend = config.backends[route.backend];
    if (!backend) {
      problems.push({
        where,
        message: `backend "${route.backend}" is not defined in backends`,
      });
      continue;
    }

    const descriptor = backendDescriptor(backend.backend);

    // A named provider supplies its own address; the generic backend and any
    // override still have to be given one.
    const baseUrl = backend.baseUrl ?? descriptor.defaultBaseUrl;

    if (descriptor.class === "http") {
      if (baseUrl === undefined) {
        problems.push({
          where: `backends.${route.backend}`,
          message: "an HTTP-class backend needs a baseUrl",
        });
        continue;
      }
      const check = checkBaseUrl(baseUrl);
      if (!check.ok) {
        problems.push({
          where: `backends.${route.backend}.baseUrl`,
          message: check.detail,
        });
        continue;
      }
    }

    // Cost comes from the registry, or from where the request goes — never
    // from config ({@link MUSTS.COST_NOT_CONFIGURABLE},
    // {@link MUSTS.REMOTE_IS_NEVER_FREE}).
    const cost = resolveCost(backend.backend, baseUrl);
    const acknowledged = backend.spend?.acknowledged === true;
    const capCents = backend.spend?.dailyCapCents;

    // A widened metered backend without a ceiling is refused rather than
    // silently given an unlimited one ({@link MUSTS.METERED_REQUIRES_CEILING}).
    const widened = backend.offer !== "self";
    if (
      cost === "metered" &&
      widened &&
      acknowledged &&
      capCents === undefined
    ) {
      problems.push({
        where: `backends.${route.backend}.spend`,
        message:
          "sharing a metered backend needs spend.dailyCapCents — an " +
          "unlimited ceiling is not something anyone means on purpose",
      });
      continue;
    }

    const configured = backend.offer;
    const offerScope = effectiveOfferScope(configured, cost, {
      acknowledged: acknowledged && capCents !== undefined,
    });
    if (offerScope !== configured) {
      problems.push({
        where: `backends.${route.backend}.offer`,
        message:
          cost === "subscription"
            ? `"${configured}" was ignored: ${descriptor.label} runs on your ` +
              `own subscription, so it is locked to your work only`
            : `"${configured}" was narrowed to "self": ${descriptor.label} ` +
              `bills you per token. \`byollm offer ${route.backend} ` +
              `${configured}\` to share it deliberately, with a ceiling`,
      });
    }

    routes.push({
      kind: kind as z.infer<typeof JobKind>,
      backendKey: route.backend,
      backendId: backend.backend,
      backendClass: descriptor.class,
      model: route.model,
      cost,
      offerScope,
      spendAcknowledged: acknowledged,
      spendDailyCapCents: capCents,
      spendCentsPerMillionTokens: backend.spend?.centsPerMillionTokens ?? 1500,
      baseUrl,
      apiKeyEnv: backend.apiKeyEnv,
    });
  }

  return { config, routes, problems };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * What the control plane reads, and never owns.
 *
 * byollm_016 Amendment L. Every fact the engine needs to author one grant —
 * whether a person consented to a site, whether they may use somebody's
 * devices, and which of that owner's services their mapping resolves to —
 * comes from here. The engine holds none of it.
 *
 * ## Why this is an interface rather than a table
 *
 * The policy store is where accounts, consents, memberships, mappings and
 * billing live, and it is the part of byollm.cloud that stays proprietary.
 * The *law* over that data is not: it is the engine, and it is open, so a
 * self-hoster runs the same resolution against their own store and a reader
 * can check what the hosted product does with theirs.
 *
 * The split is drawn where it is because these are genuinely different kinds
 * of thing. Who is on whose team is somebody's data. What that membership
 * *entitles* is a rule, and a rule nobody can read is a rule nobody can
 * check.
 *
 * ## The contract
 *
 * `@byollm/control-plane/store-contract` is a suite any implementation can
 * run against itself. It ships in the package for the reason the routing
 * store's does: the implementation that matters most lives in another
 * repository, and a contract only its author can run is a description.
 */

/**
 * The purpose a site gets when it declares a flat list of kinds.
 *
 * A manifest may say `{ "writing_assistant": ["llm.chat"] }` or simply
 * `["llm.chat"]`, and the second is sugar for one site-wide purpose. That
 * purpose needs an id, mappings are keyed by it, and an id chosen from the
 * site's own vocabulary could collide the day the site declares real
 * purposes.
 *
 * So it is reserved: a manifest may not declare it, and registration refuses
 * one that tries, naming the remedy.
 *
 * **Never rendered.** "default → your Claude" tells a person nothing. The
 * consent page shows the *site's own name* for this slot, which is what a
 * flat-list site's single purpose actually is: everything that site does.
 */
export const RESERVED_PURPOSE = "default";

/**
 * One slot a user has filled: this site's purpose, for this kind, runs there.
 *
 * Keyed by (purpose, kind) because a purpose may span kinds — "writing
 * assistant" might use both `llm.chat` and `llm.generate` — and a person may
 * reasonably want different services behind them.
 *
 * `service` is a service id in the **device owner's** namespace, which is why
 * a mapping is only meaningful alongside the owner it was authored against.
 */
export interface Mapping {
  readonly purpose: string;
  readonly kind: string;
  /** The owner's own id for the service, from their config. */
  readonly service: string;
}

/**
 * Everything the engine needs about one (site, user, owner) triple.
 *
 * One read rather than three, because this happens on every claim and a
 * control plane that made three round trips per job would be the reason
 * somebody ran their own.
 */
export interface PolicySnapshot {
  /**
   * May this user's work move for this site **right now**?
   *
   * Three states collapse into this one boolean, and the collapse is
   * deliberate: never authorised, authorised then revoked, and authorised but
   * *paused* are different things to a person and the same thing to a grant.
   * A store must report a paused consent as `false` — a relay's projection
   * can be a few seconds behind, and a grant authored in that window would
   * run work its owner had just stopped.
   *
   * Distinct from having mappings, which is a different real state: a person
   * can consent and leave a slot unmapped, because it had two candidates and
   * they have not chosen. "Not authorised" and "authorised, this slot empty"
   * send them to different places, so the engine is told which.
   */
  readonly consented: boolean;
  /**
   * May this user's work run on this owner's devices?
   *
   * The store answers for other people. It is **not** consulted for the
   * owner's own work — see {@link PolicyStore.read}.
   */
  readonly member: boolean;
  /** This user's mappings for this site. Order is not meaningful. */
  readonly mappings: readonly Mapping[];
}

export interface PolicyStore {
  /**
   * Read the policy for one job's worth of question.
   *
   * **`owner === user` is not asked about here.** A device always runs its
   * own owner's work, and routing that through a store would put a law in a
   * place any implementation could get wrong — including by returning
   * `member: false` for somebody's own account and quietly stopping their
   * device. The engine short-circuits it; this method is only ever asked
   * about other people.
   *
   * Returning a snapshot with `consented: false` is the ordinary answer for a
   * site this user has never authorised. Throwing is for a store that could
   * not answer, which is a different thing and must not be turned into a
   * refusal — see the engine's failure handling.
   */
  read(input: {
    /** The site's id in the control plane's namespace, not its key id. */
    readonly siteId: string;
    /** Whose job it is. */
    readonly user: string;
    /** Whose device is asking. */
    readonly owner: string;
  }): Promise<PolicySnapshot>;
}

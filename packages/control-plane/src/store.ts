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
  /** The service id, in {@link Mapping.owner}'s namespace. */
  readonly service: string;
  /**
   * Whose service it is. `null` means the mapper's own.
   *
   * **Not optional decoration.** Service ids are namespace-local: alice may
   * be on two teams that both have a service called `qwen`, and the consent
   * screen shows them as the two different choices they are. A mapping that
   * stored only the name could not tell them apart — so her work would be
   * admitted on whichever of those machines claimed it first, which is
   * exactly the substitution this design exists to forbid.
   *
   * The first draft of this interface had only the name, and the consent
   * screen's own test — "keeps a teammate's identical service name separate
   * from your own" — was already asserting the distinction that the storage
   * could not keep.
   */
  readonly owner: string | null;
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
   * May this user's work move for this site **right now**, and if not, is
   * that reversible?
   *
   * This was a boolean, and the collapse was defended: never authorised,
   * revoked, and *paused* are different to a person and identical to a grant.
   * True of the grant, and the engine does not only decide grant-or-not — it
   * decides whether the refusal is **permanent**, and the three states are
   * emphatically not identical there.
   *
   * byollm-review 2026-08-27. `decline("not-consented")` is in the permanent
   * set, and the relay releases a permanent decline as `refused`: never offer
   * this job to this device again. A pause is the hosted product's own
   * everyday path — a consent auto-pauses the moment its author joins a team,
   * with no row changing — so somebody's queued work was permanently unpicked
   * from every device that claimed during the window, and re-consenting
   * minutes later did not bring it back. The engine's own law, stated two
   * lines above its permanence table: a permanent mark must not outlive the
   * condition that caused it.
   *
   * So the states that differ in remedy are told apart:
   *
   * - `"yes"` — authorised, and nothing is in the way.
   * - `"paused"` — authorised, and temporarily not routing. The person can
   *   lift it themselves by reading the sentence they have not read; the job
   *   must still be there when they do.
   * - `"no"` — never authorised, or revoked. Somebody decided this, and a
   *   queued job cannot outlive that decision.
   *
   * Distinct from having mappings, which is a different real state: a person
   * can consent and leave a slot unmapped, because it had two candidates and
   * they have not chosen. "Not authorised" and "authorised, this slot empty"
   * send them to different places, so the engine is told which.
   */
  readonly consented: "yes" | "paused" | "no";
  /**
   * May this user's work run on this owner's devices?
   *
   * The store answers for other people. It is **not** consulted for the
   * owner's own work — see {@link PolicyStore.read}.
   */
  readonly member: boolean;
  /** This user's mappings for this site. Order is not meaningful. */
  readonly mappings: readonly Mapping[];
  /**
   * The purpose keys this site declares, when the store can say.
   *
   * `undefined` means "this store does not answer that", which is not the
   * same as "declares nothing" — a store that could not tell us must not make
   * every purpose undeclared. A site with no manifest declares everything
   * implicitly, which is the reading the consent screen and the engine
   * already share.
   */
  readonly declares?: ReadonlySet<string> | undefined;
  /**
   * Which of this person's services are being advertised right now — 019 §3.3.
   *
   * Keys are `owner\u0000service`, matching {@link Mapping.owner} and
   * {@link Mapping.service}, with the mapper's own services under their own
   * user id rather than `null` — a set cannot hold "whoever asked".
   *
   * This is how a quota block reaches the enqueue question without a new wire
   * field. A daemon withdraws a blocked service, so it simply stops appearing
   * in what the device advertises, and the fact arrives through the presence
   * the hub already keeps. Device offline, service unhealthy and account
   * blocked all look identical here, which is deliberate: they are one bit
   * about the slot's future, not three facts about somebody's day.
   *
   * **`undefined` means "cannot say", and must never brake.** A store with no
   * presence to read — and every store that predates this — leaves it absent,
   * and a slot with a mapping stays satisfiable exactly as it does today. The
   * same discipline {@link PolicyStoreSnapshot.declares} states, for the same
   * reason: a fact we could not read is not a negative answer.
   */
  readonly advertised?: ReadonlySet<string> | undefined;
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
   * Returning a snapshot with `consented: "no"` is the ordinary answer for a
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

import type { Mapping, PolicySnapshot, PolicyStore } from "./store.js";

/**
 * A policy store in a `Map`, for tests and for a single-process self-hoster.
 *
 * It is the reference implementation in the sense that matters: the contract
 * suite runs against it, so it is the thing anybody else's store is compared
 * to. It is not a suggestion about how to build one — a real store is a
 * database, and this one forgets everything when the process ends.
 */
export class MemoryPolicyStore implements PolicyStore {
  /** (siteId, user) to what that person authorised for that site. */
  readonly #consents = new Map<string, Mapping[]>();
  /** (siteId, user) pairs whose owner has paused them. */
  readonly #paused = new Set<string>();
  /** owner to the people who may use their devices. */
  readonly #members = new Map<string, Set<string>>();

  /**
   * Record a consent, with the mapping it carries.
   *
   * One call because they are one act: the mapping **is** the consent
   * (Amendment L), and a store that let them be written separately would
   * allow a state — consented, no mappings, no way to have got there — that
   * the product cannot produce.
   *
   * Consenting with an empty list is the real signup state, though: a person
   * whose slots all had two candidates and who has not chosen yet.
   */
  consent(input: {
    siteId: string;
    user: string;
    mappings?: readonly Mapping[];
  }): void {
    this.#consents.set(key(input.siteId, input.user), [
      ...(input.mappings ?? []),
    ]);
    this.#paused.delete(key(input.siteId, input.user));
  }

  /**
   * Pause a consent without withdrawing it.
   *
   * A real product state and not the same as revoking: the mapping survives,
   * so resuming does not ask somebody to author their choices again. What it
   * must not do is let work through — a relay's projection can lag by
   * seconds, and a grant authored in that window would run work whose owner
   * had just stopped it.
   */
  pause(input: { siteId: string; user: string }): void {
    this.#paused.add(key(input.siteId, input.user));
  }

  /** Let it move again. */
  resume(input: { siteId: string; user: string }): void {
    this.#paused.delete(key(input.siteId, input.user));
  }

  /**
   * Withdraw consent, which deletes the mapping with it.
   *
   * Not two operations. "Revoking consent deletes the mapping — the mapping
   * is the consent, so un-consenting unmaps" (hole 2), and a store that could
   * leave one behind would leave a resolution pointing at a service the
   * person no longer authorises anybody to reach.
   */
  revoke(input: { siteId: string; user: string }): void {
    this.#consents.delete(key(input.siteId, input.user));
    this.#paused.delete(key(input.siteId, input.user));
  }

  /** Add somebody to an owner's team. */
  addMember(input: { owner: string; user: string }): void {
    const members = this.#members.get(input.owner) ?? new Set<string>();
    members.add(input.user);
    this.#members.set(input.owner, members);
  }

  /**
   * Remove somebody from an owner's team.
   *
   * There is no "blocked but still a member": a team **is** access to its
   * owner's devices and nothing else, so member-but-blocked is not a deferred
   * feature, it is an empty state (Amendment J).
   */
  removeMember(input: { owner: string; user: string }): void {
    this.#members.get(input.owner)?.delete(input.user);
  }

  read(input: {
    siteId: string;
    user: string;
    owner: string;
  }): Promise<PolicySnapshot> {
    const id = key(input.siteId, input.user);
    const mappings = this.#consents.get(id);
    return Promise.resolve({
      // The three states the reference store can be in, told apart rather
      // than collapsed: a pause is somebody's own to lift, and the engine
      // needs to know that before it decides whether a refusal is forever.
      consented:
        mappings === undefined ? "no" : this.#paused.has(id) ? "paused" : "yes",
      member: this.#members.get(input.owner)?.has(input.user) ?? false,
      mappings: mappings ?? [],
    });
  }
}

/**
 * NUL-joined, for the reason `routeKey` is.
 *
 * A composite key is a parser waiting to meet an id containing its separator.
 * NUL cannot appear in either half, so no arrangement of a site id and a user
 * id can spell a different pair.
 */
const key = (siteId: string, user: string): string => `${siteId}\u0000${user}`;

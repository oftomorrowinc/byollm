import type { ClaimedStub, SealedEnvelope } from "@byollm/protocol";
import type {
  ClaimInput,
  HolderRefusal,
  Presence,
  ReleaseReason,
  RoutedJob,
  RoutedState,
  RoutingStore,
} from "../src/index.js";

/**
 * `RoutingStore` is implementable from the package's public surface.
 *
 * Not a behavioural test — it never runs. It exists to fail the **build** if a
 * parameter type of the interface is not exported, which has now happened
 * twice: `ClaimInput` and `HolderRefusal` the first time, `ReleaseReason` the
 * second. Both were found by the hub failing to compile, which is a consumer
 * in another repository discovering a packaging bug for us.
 *
 * An exported interface whose parameter types are private is a contract
 * nobody can sign. This is that sentence as a check.
 *
 * Deliberately written the way a third party would write it: relay types from
 * the relay's entry point, protocol types from `@byollm/protocol`, none from
 * a deep path. Reaching into `../src/state.js` here would make it pass while
 * the published package stayed unimplementable — which is precisely the
 * failure being guarded against.
 */
declare const _contract: RoutingStore;

/** Each signature restated, so a changed parameter type has to be exported. */
declare const _claim: (input: ClaimInput) => Promise<ClaimedStub[]>;
declare const _release: (input: {
  runnerId: string;
  leases: readonly { jobId: string; leaseId: string }[];
  reason?: ReleaseReason;
}) => Promise<string[]>;
declare const _complete: (input: {
  jobId: string;
  runnerId: string;
  leaseId: string;
  envelope: SealedEnvelope;
  disposition: "ok" | "error" | "canceled";
}) => Promise<
  { accepted: boolean; state: RoutedState } | { refused: HolderRefusal }
>;
declare const _seen: (
  presence: Omit<Presence, "lastSeenAt">,
) => Promise<Presence>;
declare const _sweep: () => Promise<RoutedJob[]>;

export type Contract = typeof _contract &
  typeof _claim &
  typeof _release &
  typeof _complete &
  typeof _seen &
  typeof _sweep;

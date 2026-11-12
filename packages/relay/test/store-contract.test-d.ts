import type {
  BlobDirection,
  ClaimedStub,
  SealedEnvelope,
} from "@byollm/protocol";
import type {
  BlobAddress,
  BlobJobRecord,
  BlobLedger,
  BlobSlot,
  BlobStore,
  ClaimInput,
  PairingCodes,
  PendingPairing,
  PutResult,
  Grant,
  HolderRefusal,
  OutstandingToolCall,
  Presence,
  ReleaseReason,
  RoutedJob,
  RoutedState,
  RoutingStore,
  SignedBlobUrl,
  StoredBlob,
  ToolCallRefusal,
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
 * **It missed the third one, and the reason is worth keeping.** `Grant`
 * (V1-3) is a *result* type, and `declare const _contract: RoutingStore`
 * requires only `RoutingStore` itself to be nameable — everything reachable
 * through it is structural. What actually bites is the restated signatures
 * below, and `renewLeases` and `cancelRequests` had none, so the hub
 * discovered it a release later. Every method whose parameters *or results*
 * are named types is restated now.
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
declare const _renew: (input: {
  runnerId: string;
  leases: readonly { jobId: string; leaseId: string }[];
  leaseMs: number;
}) => Promise<{
  renewed: readonly { jobId: string; expiresAt: number }[];
  lost: readonly Grant[];
}>;
declare const _cancelRequests: (runnerId: string) => Promise<Grant[]>;
declare const _recordToolCall: (input: {
  jobId: string;
  runnerId: string;
  leaseId: string;
  callId: string;
  envelope: SealedEnvelope;
}) => Promise<
  | { callId: string; expiresAt: number; duplicate?: true }
  | { refused: ToolCallRefusal }
>;
declare const _toolCalls: (siteId: string) => Promise<OutstandingToolCall[]>;

export type Contract = typeof _contract &
  typeof _claim &
  typeof _release &
  typeof _complete &
  typeof _seen &
  typeof _sweep &
  typeof _renew &
  typeof _cancelRequests &
  typeof _recordToolCall &
  typeof _toolCalls;

/**
 * `RelayOptions` is satisfiable from the package's public surface too.
 *
 * The same packaging bug, a fourth time, in a new place: `pairingCodes` was
 * added to `RelayOptions` and its type was not exported, so the hub could
 * declare the option and had no way to name what goes in it. Found — again —
 * by another repository failing to compile, one release after publishing.
 *
 * The rule these keep teaching: **a public option whose type is private is an
 * option nobody outside can fill.** `declare const _options: RelayOptions` is
 * not enough on its own, for the reason the `Grant` note above gives — the
 * shape is structural. So the seam is restated by name, which is what actually
 * requires the export to exist.
 */
declare const _pairingCodes: PairingCodes;
declare const _pending: PendingPairing;
declare const _relayOptions: {
  pairingCodes?: PairingCodes;
  verificationUrl?: string;
};

/**
 * And the *result* type `put` answers with, restated by name.
 *
 * The `Grant` note above is exactly this trap: a declared `PairingCodes` is
 * satisfied structurally, so a private `PutResult` would sail through and
 * break the hub's build a release later. Writing the signature out is what
 * requires the export.
 */
declare const _putResult: (pending: PendingPairing) => Promise<PutResult>;
void _putResult;

/**
 * And the blob option, the fifth place this could happen (#7875).
 *
 * The hub supplies `blobs.store` from another repository — a bucket — and a
 * shared `blobs.ledger` once it runs more than one replica. Every type either
 * interface takes or answers is restated by name here, for the reason the
 * `Grant` note gives: a declared `BlobStore` alone would be satisfied
 * structurally and a private `BlobAddress` would break the hub's build a
 * release later.
 */
declare const _blobOptions: {
  blobs?: { store: BlobStore; ledger?: BlobLedger };
};
declare const _blobSlot: (
  address: BlobAddress,
  bytes: number,
) => Promise<SignedBlobUrl>;
declare const _blobList: (job: {
  siteId: string;
  jobId: string;
}) => Promise<{ direction: BlobDirection; blob: string }[]>;
declare const _blobStoredBefore: (time: number) => Promise<StoredBlob[]>;
declare const _ledgerIssue: (input: {
  siteId: string;
  jobId: string;
  slot: BlobSlot;
  max: number;
  deleteAt: number;
}) => Promise<{ issued: boolean; displaced: BlobSlot[] }>;
declare const _ledgerDue: (now: number) => Promise<BlobJobRecord[]>;
export type BlobContract = typeof _blobOptions &
  typeof _blobSlot &
  typeof _blobList &
  typeof _blobStoredBefore &
  typeof _ledgerIssue &
  typeof _ledgerDue;

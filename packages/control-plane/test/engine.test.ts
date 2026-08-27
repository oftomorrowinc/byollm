import {
  RESERVED_PURPOSE,
  generateKeys,
  verifyGrant,
  type ClaimedStub,
} from "@byollm/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ControlPlane,
  MemoryPolicyStore,
  keypairSigner,
  type GrantOutcome,
  type PolicyStore,
} from "../src/index.js";

/**
 * The resolution law, and the two shapes of "no".
 *
 * Every case here is one job's worth of question, answered against a store
 * this test wrote. What is being checked is not that the store works — the
 * contract does that — but that the engine asks the right things in the right
 * order and says something a relay can act on correctly when the answer is no.
 */
const NOW = 1_800_000_000_000;
const SITE = "site_demo";
/**
 * The same site, as the device knows it.
 *
 * Two ids on purpose: the store is keyed by the control plane's own id, and
 * the grant carries the key id the device pinned. A fixture that used one
 * value for both would pass while proving nothing about the field the device
 * actually compares.
 */
const SITE_KEY = "BYOLLM-SITE-KEY-ID";
const OWNER = "bob";
const USER = "alice";

const keys = generateKeys(NOW);
let store: MemoryPolicyStore;
let plane: ControlPlane;

const engine = (over: { store?: PolicyStore } = {}) =>
  new ControlPlane({
    store: over.store ?? store,
    signer: keypairSigner(keys),
    now: () => NOW,
    newGrantId: () => "grant_fixed",
  });

const job = (over: Partial<ClaimedStub> = {}): ClaimedStub => ({
  id: "job_1",
  kind: "llm.generate",
  owner: USER,
  site: SITE_KEY,
  audience: "team",
  sizeClass: "small",
  streaming: false,
  deadlineAt: NOW + 60_000,
  lease: { id: "lease_1", runnerId: "runner_1", expiresAt: NOW + 60_000 },
  ...over,
});

/** What the device advertised: one `qwen` for `llm.generate`. */
const capabilities = [
  {
    kind: "llm.generate" as const,
    service: "qwen",
    isDefault: true,
    backendId: "openai-http" as const,
    backendClass: "http" as const,
    model: "qwen3",
    offerScope: "team" as const,
  },
];

type AuthorInput = Parameters<ControlPlane["authorGrant"]>[0];

const author = (over: Partial<AuthorInput> = {}) =>
  plane.authorGrant({
    job: job(),
    siteId: SITE,
    siteKey: SITE_KEY,
    owner: OWNER,
    capabilities,
    ...over,
  });

const mapped = () => {
  store.consent({
    siteId: SITE,
    user: USER,
    mappings: [
      {
        purpose: RESERVED_PURPOSE,
        kind: "llm.generate",
        service: "qwen",
        owner: OWNER,
      },
    ],
  });
  store.addMember({ owner: OWNER, user: USER });
};

beforeEach(() => {
  store = new MemoryPolicyStore();
  plane = engine();
});

describe("a grant, when everything agrees", () => {
  it("is signed by the key it advertises", async () => {
    // The signer holds both halves, so these cannot drift apart. A relay
    // hands `publicKey` to devices at pairing and this is what they check.
    mapped();
    const { granted } = await author();
    expect(granted).toBeDefined();
    expect(
      verifyGrant({
        grant: granted!,
        owner: OWNER,
        jobId: "job_1",
        controlPlanePublic: plane.publicKey,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("carries the service the mapping resolved to, not one it invented", async () => {
    mapped();
    const { granted } = await author();
    expect(granted).toMatchObject({
      grantId: "grant_fixed",
      jobId: "job_1",
      // The key id, not the control plane's own. The device knows sites only
      // by what it pinned, so this is the one it can compare against the
      // stub without asking anybody.
      site: SITE_KEY,
      user: USER,
      owner: OWNER,
      purpose: RESERVED_PURPOSE,
      kind: "llm.generate",
      service: "qwen",
      issuedAt: NOW,
    });

    /**
     * And the control plane's own id is **not** in the document.
     *
     * Ruled after the cross-site lift: never leave a signed field the device
     * ignores. `siteId` was signed and read by nobody, which is not a weak
     * guarantee but the appearance of one — the design said "the grant
     * carries the site" while nothing compared it to anything. Carrying both
     * would have recreated exactly that, one field checked and one not.
     */
    expect(granted).not.toHaveProperty("siteId");
  });

  it("uses the site's default purpose when the caller names none", async () => {
    // Until purposes reach the wire every job is the site's one purpose. The
    // engine is already written for the other case; the caller catches up.
    mapped();
    expect((await author()).granted).toBeDefined();
  });
});

describe("a device runs its own owner's work", () => {
  it("without asking any store about membership", async () => {
    /**
     * Asserted against a store that says no.
     *
     * This is a law, not an optimisation, and putting it in the store would
     * put it somewhere an implementation could get wrong — including by
     * answering `member: false` for somebody's own account and silently
     * stopping their own device. So the store is given every opportunity to
     * break it, and cannot.
     */
    store.consent({
      siteId: SITE,
      user: OWNER,
      mappings: [
        {
          purpose: RESERVED_PURPOSE,
          kind: "llm.generate",
          service: "qwen",
          owner: OWNER,
        },
      ],
    });
    // Deliberately never `addMember(bob, bob)`.
    const { granted } = await author({
      job: job({ owner: OWNER }),
      siteId: SITE,
      owner: OWNER,
      capabilities,
    });
    expect(granted?.user).toBe(OWNER);
  });

  it("but still needs their consent to the site", async () => {
    // Owning the hardware is not authorising the site. A person's own device
    // running work for a site they never agreed to is the same disclosure
    // problem as anybody else's.
    const { declined } = await author({
      job: job({ owner: OWNER }),
      siteId: SITE,
      owner: OWNER,
      capabilities,
    });
    expect(declined?.reason).toBe("not-consented");
  });
});

describe("the two shapes of no", () => {
  /**
   * A relay releases a declined job, and a release can carry `refused`, which
   * means never offer this job to this device again. So each reason has to
   * say whether it is forever.
   *
   * Getting it wrong permissively is a claim-refuse loop, which is noisy and
   * self-announcing. Getting it wrong strictly is a job that can never reach
   * the machine it was always meant for, with no error anywhere — which is
   * why the permanent set is the short one.
   */
  const cases: [string, () => Promise<GrantOutcome>, string, boolean][] = [
    [
      "somebody who never authorised the site",
      () => author(),
      "not-consented",
      true,
    ],
    [
      "somebody removed from the team",
      async () => {
        store.consent({
          siteId: SITE,
          user: USER,
          mappings: [
            {
              purpose: RESERVED_PURPOSE,
              kind: "llm.generate",
              service: "qwen",
              owner: OWNER,
            },
          ],
        });
        return author();
      },
      "not-a-member",
      true,
    ],
    [
      "a slot its owner has not filled",
      async () => {
        store.consent({ siteId: SITE, user: USER, mappings: [] });
        store.addMember({ owner: OWNER, user: USER });
        return author();
      },
      "unmapped",
      false,
    ],
    [
      "a mapping this device cannot honour",
      async () => {
        store.consent({
          siteId: SITE,
          user: USER,
          mappings: [
            {
              purpose: RESERVED_PURPOSE,
              kind: "llm.generate",
              service: "somewhere-else",
              owner: null,
            },
          ],
        });
        store.addMember({ owner: OWNER, user: USER });
        return author();
      },
      "resolved-elsewhere",
      false,
    ],
  ];

  for (const [what, run, reason, permanent] of cases) {
    it(`declines ${what} as ${reason}${permanent ? ", forever" : ", for now"}`, async () => {
      const outcome = await run();
      expect(outcome.granted).toBeUndefined();
      expect(outcome.declined?.reason).toBe(reason);
      expect(outcome.declined?.permanent).toBe(permanent);
    });
  }

  it("never marks a store failure permanent", async () => {
    // A database blip must not permanently unpick a job from a device. It
    // says nothing about the job, so it may not be recorded as if it did.
    mapped();
    const broken = engine({
      store: {
        read: () => Promise.reject(new Error("the database is on fire")),
      },
    });
    plane = broken;
    const outcome = await author();
    expect(outcome.declined).toEqual({
      reason: "store-unavailable",
      permanent: false,
    });
  });

  it("only ever marks two things permanent", async () => {
    // Stated over the whole set rather than case by case, so a reason added
    // later has to be argued for here before it can become permanent.
    const permanent = new Set(["not-a-member", "not-consented"]);
    for (const [, run, reason] of cases) {
      const outcome = await run();
      expect(outcome.declined?.permanent, reason).toBe(permanent.has(reason));
      store = new MemoryPolicyStore();
      plane = engine();
    }
  });
});

describe("the relay's filter is not the authority", () => {
  it("refuses a job the relay was willing to route", async () => {
    /**
     * One routes, one authorises, only one signs.
     *
     * A relay pre-filters by consent and membership from a projection that
     * can be stale — a person removed a second ago is still in it. The job
     * arriving here at all means the relay said yes; the engine asks again,
     * and when they disagree this one wins. If it did not, the grant would
     * assert something that was true when something upstream last looked.
     */
    store.consent({
      siteId: SITE,
      user: USER,
      mappings: [
        {
          purpose: RESERVED_PURPOSE,
          kind: "llm.generate",
          service: "qwen",
          owner: OWNER,
        },
      ],
    });
    store.addMember({ owner: OWNER, user: USER });
    expect((await author()).granted).toBeDefined();

    store.removeMember({ owner: OWNER, user: USER });
    const outcome = await author();
    expect(outcome.declined?.reason).toBe("not-a-member");
    expect(outcome.declined?.permanent).toBe(true);
  });
});

describe("a mapping names whose service, not just which", () => {
  it("refuses a device that merely shares the service name", async () => {
    /**
     * The bug the schema had for one commit, as a test.
     *
     * Alice is on two teams and both run something called `qwen`. She chose
     * carol's. Bob's device advertises a `qwen` too, admits alice, and claims
     * the job — and a mapping holding only the *name* would have let it run
     * there. Her work would land on a machine she never picked, which is the
     * substitution this whole design forbids.
     *
     * The check sits before the capability list deliberately: a device that
     * shares a name is not offering the wrong service, it is the wrong
     * machine, and the capabilities of the wrong machine say nothing either
     * way.
     */
    store.consent({
      siteId: SITE,
      user: USER,
      mappings: [
        {
          purpose: RESERVED_PURPOSE,
          kind: "llm.generate",
          service: "qwen",
          owner: "carol",
        },
      ],
    });
    store.addMember({ owner: OWNER, user: USER });

    // Bob's device, advertising a `qwen` of his own.
    const outcome = await author();
    expect(outcome.granted).toBeUndefined();
    expect(outcome.declined?.reason).toBe("resolved-elsewhere");
    // Transient, because carol's machine is where this belongs and it may
    // yet claim it — a permanent mark here would take the job off every
    // device including the right one.
    expect(outcome.declined?.permanent).toBe(false);
  });

  it("reads a null owner as the mapper's own machine", async () => {
    // The other half. `null` is not "anybody" — it is "mine", and it resolves
    // against the person whose job it is, so a teammate's device with the
    // same service name is still the wrong machine.
    store.consent({
      siteId: SITE,
      user: USER,
      mappings: [
        {
          purpose: RESERVED_PURPOSE,
          kind: "llm.generate",
          service: "qwen",
          owner: null,
        },
      ],
    });
    store.addMember({ owner: OWNER, user: USER });

    // Alice's job, alice's own service, offered to bob's device.
    expect((await author()).declined?.reason).toBe("resolved-elsewhere");

    // And on her own device it runs.
    const hers = await plane.authorGrant({
      job: job(),
      siteId: SITE,
      siteKey: SITE_KEY,
      owner: USER,
      capabilities,
    });
    expect(hers.granted?.service).toBe("qwen");
  });
});

describe("a mapping is keyed by purpose and kind together", () => {
  it("does not answer one kind with another kind's mapping", async () => {
    // A purpose may span kinds and a person may want different services
    // behind them. Matching on purpose alone would put a chat job on the
    // service somebody chose for image generation.
    store.consent({
      siteId: SITE,
      user: USER,
      mappings: [
        {
          purpose: RESERVED_PURPOSE,
          kind: "llm.chat",
          service: "qwen",
          owner: OWNER,
        },
      ],
    });
    store.addMember({ owner: OWNER, user: USER });
    expect((await author()).declined?.reason).toBe("unmapped");
  });

  it("does not answer one purpose with another purpose's mapping", async () => {
    store.consent({
      siteId: SITE,
      user: USER,
      mappings: [
        {
          purpose: "advertising",
          kind: "llm.generate",
          service: "qwen",
          owner: OWNER,
        },
      ],
    });
    store.addMember({ owner: OWNER, user: USER });
    expect((await author()).declined?.reason).toBe("unmapped");
    expect(
      (
        await author({
          job: job(),
          siteId: SITE,
          owner: OWNER,
          capabilities,
          purpose: "advertising",
        })
      ).granted,
    ).toBeDefined();
  });
});

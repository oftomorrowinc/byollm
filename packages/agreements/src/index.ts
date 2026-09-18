/**
 * Facts more than one byollm repository has to state identically.
 *
 * The admission criterion is in the package's name and it is the thing that
 * keeps this from becoming a junk drawer: something belongs here when two
 * repositories would otherwise write it out separately and drift. A constant
 * used in one repository belongs in that repository.
 *
 * See `hub-fence.ts` for why a sentence is published rather than kept private.
 */
export { HUB_FENCE, HUB_FENCE_CLAUSES, type FenceClause } from "./hub-fence.js";

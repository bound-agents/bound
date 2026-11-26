/**
 * Typed marker for an aux dispatch rejection that no effect in a Yard run can
 * recover from. The aux tool sets it on its result metadata when the aux runner
 * refuses an errand because the parent's client session cannot be bound; a
 * nested yard carries it upward so the parent run ends too. Yard matches on
 * this metadata, never on the content text (#316).
 */
export const AUX_DISPATCH_REJECTED_KEY = "aux_dispatch_rejected";
export const AUX_DISPATCH_REASON_KEY = "aux_dispatch_reason";

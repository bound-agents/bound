/**
 * Progressive fidelity history — the "telescope" model.
 *
 * Replaces the binary truncation cliff in Stage 7 (BUDGET_VALIDATION)
 * of context assembly with a multi-tier gradient:
 *
 *   ┌─────────────────────────────────────────┐
 *   │ RECENT (~65%): full resolution messages  │
 *   ├─────────────────────────────────────────┤
 *   │ MIDDLE (~30%): tool-cycle folded digest  │
 *   ├─────────────────────────────────────────┤
 *   │ ANCIENT (~5%): thread summary + count    │
 *   └─────────────────────────────────────────┘
 *
 * The tier boundaries are a pure function of (historyMessages, historyBudget),
 * preserving the same cache stability property as the original truncation:
 * boundaries only shift on cold-path rebuilds, never between warm turns.
 *
 * When the middle tier has nothing meaningful to contribute (budget too
 * tight, fewer than 3 foldable lines), the system degrades gracefully to
 * the original binary behavior (ancient marker + recent slice).
 */

export {
	tieredHistoryTruncation,
	type TieredHistoryParams,
	type TieredHistoryResult,
	RECENT_RATIO,
	MIDDLE_RATIO,
	ANCIENT_RATIO,
} from "./tier-allocation";

export {
	foldMessages,
	type FoldedLine,
	MAX_FOLDED_LINE_CHARS,
} from "./tool-cycle-fold";

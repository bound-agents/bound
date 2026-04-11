import type { TieredEnrichment } from "./summary-extraction.js";
import { formatMemoryEntry } from "./summary-extraction.js";

const L2_PRESSURE_CAP = 5;
const L0_L1_WARNING_THRESHOLD = 20;
const L2_TASK_DIGEST_CAP = 3;

export interface SheddingResult {
	memoryDeltaLines: string[];
	taskDigestLines: string[];
	warning?: string; // set when L0+L1 alone exceed what budget can accommodate
}

/**
 * Applies tier-aware budget degradation to the structured TieredEnrichment.
 *
 * Degradation sequence:
 * 1. Always keep L0+L1 intact (but log warning if together > 20)
 * 2. Shed L3 entirely
 * 3. Reduce L2 to at most L2_PRESSURE_CAP (5) entries
 * 4. Reduce task digest to 3
 *
 * This operates on structured tier data only — no second database call.
 */
export function shedMemoryTiers(
	tiers: TieredEnrichment,
	taskDigestLines: string[],
	logger?: { warn: (msg: string) => void },
): SheddingResult {
	const memoryDeltaLines: string[] = [];

	// Step 1: Always format L0 entries (pinned)
	for (const entry of tiers.L0) {
		memoryDeltaLines.push(formatMemoryEntry(entry));
	}

	// Step 2: Always format L1 entries (summary, stale-detail)
	for (const entry of tiers.L1) {
		memoryDeltaLines.push(formatMemoryEntry(entry));
	}

	// Check if L0+L1 alone exceed warning threshold
	let warning: string | undefined;
	const l0l1Count = tiers.L0.length + tiers.L1.length;
	if (l0l1Count > L0_L1_WARNING_THRESHOLD) {
		warning = `Budget pressure warning: L0+L1 entries (${l0l1Count}) exceed threshold (${L0_L1_WARNING_THRESHOLD}). L0 and L1 are never truncated.`;
		logger?.warn(warning);
	}

	// Step 3: Reduce L2 to at most L2_PRESSURE_CAP
	const keptL2 = tiers.L2.slice(0, L2_PRESSURE_CAP);
	for (const entry of keptL2) {
		memoryDeltaLines.push(formatMemoryEntry(entry));
	}

	// Step 4: L3 is shed entirely (no entries added)

	// Step 5: Reduce task digest to L2_TASK_DIGEST_CAP (3)
	const reducedTaskDigest = taskDigestLines.slice(0, L2_TASK_DIGEST_CAP);

	return {
		memoryDeltaLines,
		taskDigestLines: reducedTaskDigest,
		warning,
	};
}

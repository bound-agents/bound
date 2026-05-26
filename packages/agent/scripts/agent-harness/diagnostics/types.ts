/**
 * Diagnostic plugin interface.
 *
 * Each diagnostic implements two pure functions:
 *   - `collect(turnData)` extracts per-turn data into a record.
 *   - `render(perTurnRecords)` formats the final report once all turns ran.
 *
 * The driver loop calls `collect` after each turn and `render` once at the
 * end. Diagnostics never mutate shared state; they receive the same
 * `DiagnosticTurnData` snapshot each turn.
 *
 * v1 ships the `cache` diagnostic (wire markers, cr/cw, byte-diff).
 * Future diagnostics drop in alongside without touching `run.ts` — the
 * registry in `diagnostics/index.ts` is the dispatch surface.
 */

import type { ContextDebugInfo } from "@bound/shared";
import type { CapturedRequest } from "../capture";

/**
 * Per-turn data delivered to every selected diagnostic. Fields are read
 * from the in-memory `turns` row written by `recordTurn` plus the per-turn
 * captured fetch entries.
 */
export interface DiagnosticTurnData {
	/**
	 * 1-indexed inference number within the harness run. ONE per LLM
	 * inference call. A single user-turn iteration (one operator-driven
	 * input) drives N inferences via the agent loop's inner-loop tool-
	 * call/result cycle.
	 */
	turn: number;
	/**
	 * 1-indexed user-turn iteration within the harness run. Multiple
	 * inferences share the same `userTurn`; the user-message boundary
	 * is the natural compaction boundary diagnostics may want to group on.
	 */
	userTurn: number;
	/** Cold/warm/unknown — read from `context_debug.cachePath`. */
	cachePath: "cold" | "warm" | "unknown";
	/**
	 * Raw wire bodies captured for this inference. Always exactly one
	 * entry — the harness pairs each `done` chunk's wire body with its
	 * own diagnostic record, so a multi-inference user-turn yields N
	 * `DiagnosticTurnData` records each with its own single wire body.
	 */
	wireBodies: ReadonlyArray<CapturedRequest>;
	/**
	 * Already-normalized usage from `StreamChunk.done.usage`. Cache metrics
	 * (`cache_read_tokens` / `cache_write_tokens`) are normalized across
	 * providers by `ai-sdk-bridge.mapChunks`. Null when no usage was
	 * recorded (e.g., interrupted turn).
	 */
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_read_tokens: number | null;
		cache_write_tokens: number | null;
		estimated: boolean;
	} | null;
	/** Full `context_debug` record from the in-memory `turns` row. Null if absent. */
	contextDebug: ContextDebugInfo | null;
	/** Cost in USD for this turn, computed from `usage` and the backend's pricing. */
	costUsd: number;
}

/**
 * Diagnostic plugin contract. Each diagnostic registers in
 * `diagnostics/index.ts` keyed by `name` and is selected via the
 * `--diagnostic <name[,...]>` flag.
 */
export interface Diagnostic {
	/** Unique name (matches the CLI flag value). */
	name: string;
	/** One-line description for `--help`. */
	description: string;
	/**
	 * Called once per turn. Pure: extracts whatever the diagnostic cares
	 * about into a record. The driver collects records into an array and
	 * passes to `render` at the end.
	 */
	collect(data: DiagnosticTurnData): Record<string, unknown>;
	/**
	 * Called once after the final turn (or after an early budget-abort).
	 * Pure: returns a string for stdout. No I/O; the driver writes the
	 * returned string.
	 */
	render(perTurnRecords: ReadonlyArray<Record<string, unknown>>): string;
}

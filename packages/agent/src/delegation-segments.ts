/**
 * Unified-delegation context-segment codec (R-UD3).
 *
 * A delegated context ships over the inference relay as a `ContextSegment[]`
 * (see the type's doc comment in `@bound/shared`). This module is the single
 * producer/consumer pair that round-trips an assembled message list through
 * that wire format:
 *
 *   - {@link segmentAssembledMessages} (PRODUCER) compresses the longest
 *     confirmed-synced leading prefix of the producer's assembled messages into
 *     ONE `range` segment (a kilobytes-sized pointer regardless of token count)
 *     and ships the rest verbatim as `inline` segments.
 *   - {@link resolveSegments} (CONSUMER) rebuilds the exact same `LLMMessage[]`
 *     on the target host by re-running the Stage-1 projection finder + Stage-5
 *     annotation the producer used for the range, and trusting `inline` bytes.
 *
 * INVARIANT (tested): `resolveSegments(segmentAssembledMessages(p), db, nowMs)`
 * deep-equals `p.producerMessages` byte-for-byte.
 *
 * The consumer deliberately does NOT depend on `assembleContext` /
 * AssemblyAuthority — it knows only segments, the projection finder, and the
 * annotator. Keep it that way: the whole point of the range pointer is that a
 * confirmed-synced prefix is reproducible from the replicated DB alone.
 *
 * See docs/design/specs/2026-06-29-unified-delegation.md §3/§4.
 */

import type { Database } from "bun:sqlite";
import { listLiveMessageProjectionByThreadNewestFirst } from "@bound/core";
import type { LLMMessage } from "@bound/llm";
import type { ContextSegment, Message } from "@bound/shared";
import { annotateMessages } from "./annotation/annotate";
import { isYardClientBookkeepingRow } from "./yard-client-rows";

/**
 * Hard cap on how many live message rows the producer/consumer load when
 * reproducing a thread's history. A thread can never realistically reach this,
 * so it functions as "load everything" while staying a bounded query.
 */
const HARD_LIMIT = 100000;

/** Driver-agnostic deep equality via canonical JSON. */
function bytesEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Loads a thread's live message rows oldest-first (ASC), minus Yard
 * client-dispatch bookkeeping rows. The SAME filter must run on producer and
 * consumer (both call this loader) or the range's `count` stops describing
 * the same rows on both sides and R-UD10 fires. Mirrors cold Stage 1 and the
 * warm delta path — see yard-client-rows.ts.
 */
function loadRowsAsc(db: Database, threadId: string): Message[] {
	const newestFirst = listLiveMessageProjectionByThreadNewestFirst(db, threadId, HARD_LIMIT);
	// `.reverse()` mutates, but `newestFirst` is a fresh array from the finder.
	return newestFirst.reverse().filter((row) => !isYardClientBookkeepingRow(row));
}

export interface SegmentAssembledMessagesParams {
	db: Database;
	threadId: string;
	/**
	 * The fully-assembled annotated message list the producer is about to ship
	 * (history + volatile tail, possibly with purge stubs / truncation markers /
	 * a developer tail). The leading prefix that is byte-identical to what the
	 * consumer can independently reproduce becomes the range.
	 */
	producerMessages: LLMMessage[];
	/**
	 * The AssemblyClock instant used for annotation. MUST equal the `nowMs` the
	 * producer annotated history with, and the `nowMs` the consumer will resolve
	 * with, or the range bytes diverge.
	 */
	nowMs: number;
	/**
	 * The caller's confirmed-synced gate. A row that is NOT confirmed-synced ends
	 * the range run even if its annotated bytes match — the consumer might not
	 * have that row yet (R-UD6). Returns true for rows safe to point at.
	 */
	isRangeCoverable: (messageRow: Message) => boolean;
}

/**
 * PRODUCER. Builds the segment list. The range covers the LONGEST LEADING RUN
 * of `producerMessages` that is byte-identical to the consumer-reproducible
 * annotation of confirmed-synced Stage-1 rows; everything after ships inline.
 */
export function segmentAssembledMessages(params: SegmentAssembledMessagesParams): ContextSegment[] {
	const { db, threadId, producerMessages, nowMs, isRangeCoverable } = params;

	// 1. Live rows ASC + 2. annotate them exactly as the consumer will.
	const rows = loadRowsAsc(db, threadId);
	const annotatedRows = annotateMessages({ messages: rows, nowMs });

	// 3. Walk producerMessages against annotatedRows from i=0. Extend the run
	//    while indices align 1:1, the annotated bytes match, AND the underlying
	//    row is confirmed-synced. The first divergence ends the run.
	//
	//    `annotateMessages` can insert "Model switched" developer messages, so
	//    `annotatedRows` is not guaranteed 1:1 with `rows`. We index `rows` by a
	//    separate cursor that only advances on a NON-injected annotated message
	//    (injected developer messages carry no `host_origin`, unlike row-derived
	//    messages which always do). This keeps the coverable gate aligned to the
	//    real backing row while still comparing every annotated byte in order.
	let runLen = 0; // number of leading producerMessages covered by the range
	let rowCursor = 0; // index into `rows` for the coverable check + anchor
	const limit = Math.min(producerMessages.length, annotatedRows.length);
	for (let i = 0; i < limit; i++) {
		const annotated = annotatedRows[i];
		if (!bytesEqual(producerMessages[i], annotated)) break;

		// Advance the backing-row cursor for any annotated message that came from
		// a real row. Injected model-switch messages are `developer`-role with no
		// `host_origin`; they consume no row. (Defensive: if the cursor ever runs
		// past the rows array, treat the run as ended — cannot happen by
		// construction since each non-injected annotated message maps to a row.)
		const isInjected = annotated.role === "developer" && annotated.host_origin === undefined;
		if (!isInjected) {
			if (rowCursor >= rows.length) break;
			if (!isRangeCoverable(rows[rowCursor])) break;
			rowCursor++;
		}
		runLen = i + 1;
	}

	// 4. Nothing confirmed/reproducible: everything ships inline (cold start).
	if (runLen === 0) {
		return producerMessages.map((message) => ({ kind: "inline", message }));
	}

	// 5. One range over the first `rowCursor` rows, then inline for the tail.
	//    `rowCursor` is the count of backing rows the run consumed; the anchor is
	//    the last such row's created_at.
	const segments: ContextSegment[] = [
		{
			kind: "range",
			thread_id: threadId,
			anchor_created_at: rows[rowCursor - 1].created_at,
			count: rowCursor,
		},
	];
	for (let i = runLen; i < producerMessages.length; i++) {
		segments.push({ kind: "inline", message: producerMessages[i] });
	}
	return segments;
}

/**
 * CONSUMER. Rebuilds the `LLMMessage[]` the producer assembled, segment by
 * segment, using only the replicated DB + the same annotator. Throws if a range
 * points past the rows actually present (R-UD10: cannot happen by construction;
 * a missing row is a hard error, not a silent short context).
 */
export function resolveSegments(
	segments: ContextSegment[],
	db: Database,
	nowMs: number,
): LLMMessage[] {
	const out: LLMMessage[] = [];
	for (const segment of segments) {
		if (segment.kind === "inline") {
			out.push(segment.message as LLMMessage);
			continue;
		}

		// range: load live rows ASC, clamp to the anchor, take the leading count.
		const rowsAsc = loadRowsAsc(db, segment.thread_id);
		const upToAnchor = rowsAsc.filter((r) => r.created_at <= segment.anchor_created_at);
		if (upToAnchor.length < segment.count) {
			throw new Error(
				`resolveSegments: range for thread ${segment.thread_id} expects ${segment.count} rows up to ${segment.anchor_created_at} but only ${upToAnchor.length} are present (R-UD10: confirmed-synced prefix missing on consumer)`,
			);
		}
		const window = upToAnchor.slice(0, segment.count);
		for (const m of annotateMessages({ messages: window, nowMs })) {
			out.push(m);
		}
	}
	return out;
}

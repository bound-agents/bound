/**
 * Property tests for the unified-delegation context-segment codec
 * (`segmentAssembledMessages` / `resolveSegments`, R-UD3).
 *
 * The codec's contract is a round-trip identity: whatever the producer ships as
 * `ContextSegment[]` must resolve, on the consumer, to the exact same
 * `LLMMessage[]` byte-for-byte. The range pointer is a compression of the
 * longest confirmed-synced leading prefix; getting its length or anchor wrong
 * silently corrupts a delegated context (wrong history on the target host), so
 * we pin the contract with fast-check arbitraries rather than a handful of
 * hand-picked cases.
 *
 * Properties:
 *   P1 ROUND-TRIP — resolve(segment(producer)) deep-equals producer, for an
 *      arbitrary thread and an arbitrary confirmed-prefix length K (including
 *      K=0 all-inline, K=N full-range, and middle).
 *   P2 AT-MOST-ONE-RANGE — ≤1 "range" segment, and if present it is first.
 *   P3 RANGE NEVER COVERS UNCOVERABLE ROWS — range.count ≤ K.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { LLMMessage } from "@bound/llm";
import type { Message } from "@bound/shared";
import fc from "fast-check";
import { annotateMessages } from "../annotation/annotate";
import { resolveSegments, segmentAssembledMessages } from "../delegation-segments";

// ---------- DB harness ----------

const CREATE_MESSAGES =
	"CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, model_id TEXT, tool_name TEXT, created_at TEXT NOT NULL, modified_at TEXT, host_origin TEXT NOT NULL, deleted INTEGER DEFAULT 0)";

interface RowSeed {
	role: "user" | "assistant";
	content: string;
}

/**
 * Builds a fresh in-memory DB seeded with `seeds` as a thread of monotonic
 * created_at rows, and returns the ASC `Message[]` projection the producer
 * would see (mirroring the Stage-1 finder's column set — no `metadata`).
 */
function seedThread(threadId: string, seeds: RowSeed[]): { db: Database; rows: Message[] } {
	const db = new Database(":memory:");
	db.run(CREATE_MESSAGES);
	const insert = db.prepare(
		"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
	);
	seeds.forEach((s, i) => {
		// Zero-padded monotonic ISO-ish timestamps keep created_at ordering stable
		// and lexicographically comparable (the consumer filters on string <=).
		const created = `2026-06-29T00:00:${String(i).padStart(2, "0")}.000Z`;
		const modelId = s.role === "assistant" ? "model-a" : null;
		insert.run(
			`${threadId}-m${i}`,
			threadId,
			s.role,
			s.content,
			modelId,
			null,
			created,
			created,
			"hostA",
		);
	});
	// Read back through the exact Stage-1 projection the production finder uses
	// (no metadata column), then reverse to ASC — identical to loadRowsAsc.
	const rows = db
		.query(
			"SELECT id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY created_at DESC, rowid DESC LIMIT ?",
		)
		.all(threadId, 100000) as Message[];
	rows.reverse();
	return { db, rows };
}

// ---------- Arbitraries ----------

const rowSeed: fc.Arbitrary<RowSeed> = fc.record({
	role: fc.constantFrom("user" as const, "assistant" as const),
	// Reject NUL so seeded content survives the SQLite TEXT round-trip and the
	// one-line-per-row assumption holds. `String.fromCharCode(0)` keeps the
	// control char out of the source (biome's noControlCharactersInRegex).
	content: fc
		.string({ minLength: 1, maxLength: 60 })
		.filter((s) => !s.includes(String.fromCharCode(0))),
});

// 0..12 rows; K (confirmed prefix length) in 0..rows.length.
const scenario = fc.array(rowSeed, { minLength: 0, maxLength: 12 }).chain((seeds) =>
	fc.record({
		seeds: fc.constant(seeds),
		k: fc.integer({ min: 0, max: seeds.length }),
		tail: fc.string({ minLength: 0, maxLength: 40 }),
		nowMs: fc.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 }),
	}),
);

describe("delegation-segments codec", () => {
	it("P1 round-trips producer messages byte-for-byte", () => {
		fc.assert(
			fc.property(scenario, ({ seeds, k, tail, nowMs }) => {
				const threadId = "t-roundtrip";
				const { db, rows } = seedThread(threadId, seeds);

				// Producer assembles: annotated history + an inline developer tail.
				const producerMessages: LLMMessage[] = [
					...annotateMessages({ messages: rows, nowMs }),
					{ role: "developer", content: `tail:${tail}` },
				];

				// First K rows confirmed-synced, the rest not.
				const coverableIds = new Set(rows.slice(0, k).map((r) => r.id));
				const isRangeCoverable = (m: Message) => coverableIds.has(m.id);

				const segments = segmentAssembledMessages({
					db,
					threadId,
					producerMessages,
					nowMs,
					isRangeCoverable,
				});
				const resolved = resolveSegments(segments, db, nowMs);

				expect(JSON.stringify(resolved)).toBe(JSON.stringify(producerMessages));
			}),
			{ numRuns: 200 },
		);
	});

	it("P2 emits at most one range segment, first if present", () => {
		fc.assert(
			fc.property(scenario, ({ seeds, k, tail, nowMs }) => {
				const threadId = "t-onerange";
				const { db, rows } = seedThread(threadId, seeds);
				const producerMessages: LLMMessage[] = [
					...annotateMessages({ messages: rows, nowMs }),
					{ role: "developer", content: `tail:${tail}` },
				];
				const coverableIds = new Set(rows.slice(0, k).map((r) => r.id));
				const segments = segmentAssembledMessages({
					db,
					threadId,
					producerMessages,
					nowMs,
					isRangeCoverable: (m) => coverableIds.has(m.id),
				});

				const rangeIdxs = segments
					.map((s, i) => (s.kind === "range" ? i : -1))
					.filter((i) => i >= 0);
				expect(rangeIdxs.length).toBeLessThanOrEqual(1);
				if (rangeIdxs.length === 1) {
					expect(rangeIdxs[0]).toBe(0);
				}
			}),
			{ numRuns: 200 },
		);
	});

	it("P3 range count never exceeds the confirmed prefix length K", () => {
		fc.assert(
			fc.property(scenario, ({ seeds, k, tail, nowMs }) => {
				const threadId = "t-cover";
				const { db, rows } = seedThread(threadId, seeds);
				const producerMessages: LLMMessage[] = [
					...annotateMessages({ messages: rows, nowMs }),
					{ role: "developer", content: `tail:${tail}` },
				];
				const coverableIds = new Set(rows.slice(0, k).map((r) => r.id));
				const segments = segmentAssembledMessages({
					db,
					threadId,
					producerMessages,
					nowMs,
					isRangeCoverable: (m) => coverableIds.has(m.id),
				});

				const range = segments.find((s) => s.kind === "range");
				if (range && range.kind === "range") {
					expect(range.count).toBeLessThanOrEqual(k);
				}
			}),
			{ numRuns: 200 },
		);
	});

	// P4 (review-hardening): a producer transform that diverges from a pure row
	// re-annotation — a purge stub, truncation marker, cache marker, or any
	// non-row-derived message spliced INTO the history — must end the range at
	// that point, so the divergent material ships inline (never lost/duplicated)
	// and the whole thing still round-trips byte-for-byte. We model the splice by
	// inserting a synthetic developer message at an arbitrary mid-history index;
	// because it does not byte-match the annotated row at that index, the range
	// must stop before it.
	it("P4 a mid-history non-row message ends the range and still round-trips", () => {
		const midScenario = fc.array(rowSeed, { minLength: 2, maxLength: 12 }).chain((seeds) =>
			fc.record({
				seeds: fc.constant(seeds),
				spliceAt: fc.integer({ min: 1, max: seeds.length - 1 }),
				stub: fc.string({ minLength: 1, maxLength: 30 }),
				nowMs: fc.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 }),
			}),
		);
		fc.assert(
			fc.property(midScenario, ({ seeds, spliceAt, stub, nowMs }) => {
				const threadId = "t-splice";
				const { db, rows } = seedThread(threadId, seeds);
				const annotated = annotateMessages({ messages: rows, nowMs });

				// Splice a non-row developer message into the middle of the history.
				const producerMessages: LLMMessage[] = [
					...annotated.slice(0, spliceAt),
					{ role: "developer", content: `purge-stub:${stub}` },
					...annotated.slice(spliceAt),
				];

				// ALL rows are confirmed-synced — so only the splice (not the
				// watermark) can end the range.
				const segments = segmentAssembledMessages({
					db,
					threadId,
					producerMessages,
					nowMs,
					isRangeCoverable: () => true,
				});

				// Round-trips byte-for-byte regardless of where the splice landed.
				const resolved = resolveSegments(segments, db, nowMs);
				expect(JSON.stringify(resolved)).toBe(JSON.stringify(producerMessages));

				// The range (if any) never reaches past the splice: its count is at
				// most the number of leading annotated messages before the stub. (When
				// spliceAt lands amid injected model-switch messages the producer-index
				// boundary can map to fewer rows, so <= is the precise bound.)
				const range = segments.find((s) => s.kind === "range");
				if (range && range.kind === "range") {
					expect(range.count).toBeLessThanOrEqual(spliceAt);
				}
			}),
			{ numRuns: 200 },
		);
	});
});

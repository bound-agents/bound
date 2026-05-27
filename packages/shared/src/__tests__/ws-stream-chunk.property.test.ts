/**
 * Property tests for wsStreamChunkSchema — the Zod schema that validates
 * stream chunks on the WebSocket wire between server and UI clients.
 *
 * Properties:
 *
 *   P1 Round-trip preservation — any value that parses successfully through
 *      the schema can be serialized to JSON and re-parsed without loss.
 *
 *   P2 Heartbeat rejection — the `{ type: "heartbeat" }` shape (which the
 *      agent loop filters before emission) is never accepted by the schema.
 *
 *   P3 Discriminant completeness — for any valid chunk, the `type` field
 *      is one of exactly 7 expected discriminant values.
 *
 *   P4 Done chunk usage totality — a done chunk always carries all 5
 *      usage fields after successful parse.
 *
 *   P5 Arbitrary-object rejection — random objects without a valid `type`
 *      discriminant do not parse successfully.
 */

import { describe, it } from "bun:test";
import fc from "fast-check";
import { wsStreamChunkSchema } from "../relay-schemas";

const VALID_TYPES = [
	"text",
	"thinking",
	"tool_use_start",
	"tool_use_args",
	"tool_use_end",
	"done",
	"error",
] as const;

// Arbitraries for each chunk variant
const textChunkArb = fc.record({
	type: fc.constant("text" as const),
	content: fc.string(),
});

const thinkingChunkArb = fc.record({
	type: fc.constant("thinking" as const),
	content: fc.string(),
	signature: fc.option(fc.string(), { nil: undefined }),
	redacted_data: fc.option(fc.string(), { nil: undefined }),
});

const toolUseStartArb = fc.record({
	type: fc.constant("tool_use_start" as const),
	id: fc.string({ minLength: 1 }),
	name: fc.string({ minLength: 1 }),
});

const toolUseArgsArb = fc.record({
	type: fc.constant("tool_use_args" as const),
	id: fc.string({ minLength: 1 }),
	partial_json: fc.string(),
});

const toolUseEndArb = fc.record({
	type: fc.constant("tool_use_end" as const),
	id: fc.string({ minLength: 1 }),
});

const doneChunkArb = fc.record({
	type: fc.constant("done" as const),
	usage: fc.record({
		input_tokens: fc.nat(),
		output_tokens: fc.nat(),
		cache_write_tokens: fc.option(fc.nat(), { nil: null }),
		cache_read_tokens: fc.option(fc.nat(), { nil: null }),
		estimated: fc.boolean(),
	}),
	cost_usd: fc.option(fc.double({ min: 0, max: 100, noNaN: true }), { nil: undefined }),
});

const errorChunkArb = fc.record({
	type: fc.constant("error" as const),
	error: fc.string({ minLength: 1 }),
});

const anyValidChunkArb = fc.oneof(
	textChunkArb,
	thinkingChunkArb,
	toolUseStartArb,
	toolUseArgsArb,
	toolUseEndArb,
	doneChunkArb,
	errorChunkArb,
);

describe("wsStreamChunkSchema — property tests", () => {
	it("P1: round-trip preservation — parse → JSON → re-parse is lossless", () => {
		fc.assert(
			fc.property(anyValidChunkArb, (chunk) => {
				const first = wsStreamChunkSchema.safeParse(chunk);
				if (!first.success) return false; // generator made a valid chunk; schema must accept
				const serialized = JSON.parse(JSON.stringify(first.data));
				const second = wsStreamChunkSchema.safeParse(serialized);
				if (!second.success) return false;
				return JSON.stringify(first.data) === JSON.stringify(second.data);
			}),
			{ numRuns: 300 },
		);
	});

	it("P2: heartbeat rejection — heartbeat type never parses", () => {
		fc.assert(
			fc.property(fc.record({ type: fc.constant("heartbeat" as const) }), (heartbeat) => {
				const result = wsStreamChunkSchema.safeParse(heartbeat);
				return !result.success;
			}),
			{ numRuns: 10 },
		);
	});

	it("P2b: heartbeat with extra fields still rejected", () => {
		fc.assert(
			fc.property(
				fc.record({
					type: fc.constant("heartbeat" as const),
					content: fc.option(fc.string(), { nil: undefined }),
					extra: fc.option(fc.anything(), { nil: undefined }),
				}),
				(heartbeat) => {
					const result = wsStreamChunkSchema.safeParse(heartbeat);
					return !result.success;
				},
			),
			{ numRuns: 50 },
		);
	});

	it("P3: discriminant completeness — parsed type is one of exactly 7 values", () => {
		fc.assert(
			fc.property(anyValidChunkArb, (chunk) => {
				const result = wsStreamChunkSchema.safeParse(chunk);
				if (!result.success) return false;
				return (VALID_TYPES as readonly string[]).includes(result.data.type);
			}),
			{ numRuns: 300 },
		);
	});

	it("P4: done chunk usage totality — all 5 usage fields present after parse", () => {
		fc.assert(
			fc.property(doneChunkArb, (chunk) => {
				const result = wsStreamChunkSchema.safeParse(chunk);
				if (!result.success) return false;
				if (result.data.type !== "done") return false;
				const { usage } = result.data;
				return (
					typeof usage.input_tokens === "number" &&
					typeof usage.output_tokens === "number" &&
					(usage.cache_write_tokens === null || typeof usage.cache_write_tokens === "number") &&
					(usage.cache_read_tokens === null || typeof usage.cache_read_tokens === "number") &&
					typeof usage.estimated === "boolean"
				);
			}),
			{ numRuns: 100 },
		);
	});

	it("P5: arbitrary-object rejection — random objects without valid discriminant fail", () => {
		const invalidTypeArb = fc
			.string()
			.filter((s) => !(VALID_TYPES as readonly string[]).includes(s) && s !== "heartbeat");
		fc.assert(
			fc.property(
				fc.record({
					type: invalidTypeArb,
					content: fc.option(fc.string(), { nil: undefined }),
					id: fc.option(fc.string(), { nil: undefined }),
				}),
				(obj) => {
					const result = wsStreamChunkSchema.safeParse(obj);
					return !result.success;
				},
			),
			{ numRuns: 200 },
		);
	});

	it("P6: text chunk requires content — missing content field rejects", () => {
		fc.assert(
			fc.property(fc.record({ type: fc.constant("text" as const) }), (chunk) => {
				const result = wsStreamChunkSchema.safeParse(chunk);
				return !result.success;
			}),
			{ numRuns: 10 },
		);
	});

	it("P7: done chunk requires usage — missing or partial usage rejects", () => {
		// Done with missing usage
		fc.assert(
			fc.property(fc.record({ type: fc.constant("done" as const) }), (chunk) => {
				const result = wsStreamChunkSchema.safeParse(chunk);
				return !result.success;
			}),
			{ numRuns: 10 },
		);
		// Done with partial usage (missing estimated)
		fc.assert(
			fc.property(
				fc.record({
					type: fc.constant("done" as const),
					usage: fc.record({
						input_tokens: fc.nat(),
						output_tokens: fc.nat(),
					}),
				}),
				(chunk) => {
					const result = wsStreamChunkSchema.safeParse(chunk);
					return !result.success;
				},
			),
			{ numRuns: 50 },
		);
	});
});

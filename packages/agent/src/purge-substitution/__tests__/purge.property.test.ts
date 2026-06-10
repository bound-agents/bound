/**
 * Property tests for Stage 2 purge substitution.
 *
 * Tool-pair symmetric expansion is the load-bearing invariant.
 * Without it, purging a tool_call without its paired tool_result
 * would land an orphan that Bedrock / Anthropic 400 with the
 * "Each tool_use_id must have a corresponding tool_result block"
 * rejection.
 *
 * Properties:
 *
 *   P1 Purge messages themselves are dropped from output.
 *   P2 Tool-pair symmetric expansion — purging a tool_call also
 *      drops its paired tool_result (and vice versa).
 *   P3 Each purge group emits exactly one summary message.
 *   P4 Summary message carries the unverified-provenance prefix.
 *   P5 Non-purged messages survive.
 *   P6 Determinism — same input produces same output.
 *   P7 Malformed purge metadata is silently skipped (the row is
 *      still dropped from output but it doesn't crash).
 *   P8 Empty input → empty output.
 */

import { describe, it } from "bun:test";
import type { Message } from "@bound/shared";
import fc from "fast-check";
import { substitutePurgedMessages } from "../substitute";

const FIXED_NOW = "2026-05-25T12:00:00.000Z";
const THREAD_ID = "test-thread";

function msg(role: Message["role"], id: string, content: string): Message {
	return {
		id,
		thread_id: THREAD_ID,
		role,
		content,
		model_id: null,
		tool_name: null,
		created_at: FIXED_NOW,
		modified_at: FIXED_NOW,
		host_origin: "test",
		deleted: 0,
		exit_code: null,
		metadata: null,
	};
}

function purgeMsg(id: string, targetIds: string[], summary: string): Message {
	return msg("purge", id, JSON.stringify({ target_ids: targetIds, summary }));
}

const safeKey = fc
	.string({ minLength: 1, maxLength: 16 })
	.filter((s) => /^[a-zA-Z0-9_-]+$/.test(s));
const safeText = fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !/[\n\r"]/.test(s));

describe("substitutePurgedMessages — property tests", () => {
	it("P1: purge messages themselves are dropped from output", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(safeKey, { minLength: 1, maxLength: 5 }),
				safeText,
				(targetIds, summary) => {
					const purgeId = "p1";
					const msgs: Message[] = [
						msg("user", "u1", "hello"),
						purgeMsg(purgeId, targetIds, summary),
					];
					const out = substitutePurgedMessages({ messages: msgs, threadId: THREAD_ID });
					return !out.some((m) => m.id === purgeId);
				},
			),
			{ numRuns: 50 },
		);
	});

	it("P2: tool-pair symmetric expansion — purging tool_call drops paired tool_result", () => {
		const msgs: Message[] = [
			msg("user", "u1", "hi"),
			msg("tool_call", "tc1", '[{"type":"tool_use","id":"a","name":"x","input":{}}]'),
			msg("tool_result", "tr1", "result"),
			msg("user", "u2", "next"),
			purgeMsg("p1", ["tc1"], "purged the call"),
		];
		const out = substitutePurgedMessages({ messages: msgs, threadId: THREAD_ID });
		// Both halves of the pair must be gone.
		if (out.some((m) => m.id === "tc1")) throw new Error("tool_call survived purge");
		if (out.some((m) => m.id === "tr1")) throw new Error("tool_result not symmetrically purged");
	});

	it("P2b: symmetric expansion — purging tool_result drops paired tool_call", () => {
		const msgs: Message[] = [
			msg("user", "u1", "hi"),
			msg("tool_call", "tc1", '[{"type":"tool_use","id":"a","name":"x","input":{}}]'),
			msg("tool_result", "tr1", "result"),
			msg("user", "u2", "next"),
			purgeMsg("p1", ["tr1"], "purged the result"),
		];
		const out = substitutePurgedMessages({ messages: msgs, threadId: THREAD_ID });
		if (out.some((m) => m.id === "tc1")) throw new Error("tool_call not symmetrically purged");
		if (out.some((m) => m.id === "tr1")) throw new Error("tool_result survived purge");
	});

	it("P2c: multi-tool_result expansion — purging the call drops ALL its results", () => {
		// A tool_call carrying two tool_use blocks owns two tool_results.
		// The pre-fix positional index paired the call with only the FIRST
		// result, so tr2 survived its call's purge as an orphan.
		const tc = (id: string, tuIds: string[]) =>
			msg(
				"tool_call",
				id,
				JSON.stringify(tuIds.map((t) => ({ type: "tool_use", id: t, name: "x", input: {} }))),
			);
		const tr = (id: string, tuId: string) => ({
			...msg("tool_result", id, `result for ${tuId}`),
			tool_name: tuId,
		});
		const msgs: Message[] = [
			msg("user", "u1", "hi"),
			tc("tc1", ["a", "b"]),
			tr("tr1", "a"),
			tr("tr2", "b"),
			msg("user", "u2", "next"),
			purgeMsg("p1", ["tc1"], "purged the call"),
		];
		const out = substitutePurgedMessages({ messages: msgs, threadId: THREAD_ID });
		if (out.some((m) => m.id === "tc1")) throw new Error("tool_call survived purge");
		if (out.some((m) => m.id === "tr1")) throw new Error("first tool_result not purged");
		if (out.some((m) => m.id === "tr2")) throw new Error("second tool_result not purged");
	});

	it("P2d: multi-tool_result expansion — purging ONE result drops the call and sibling results", () => {
		const tc = (id: string, tuIds: string[]) =>
			msg(
				"tool_call",
				id,
				JSON.stringify(tuIds.map((t) => ({ type: "tool_use", id: t, name: "x", input: {} }))),
			);
		const tr = (id: string, tuId: string) => ({
			...msg("tool_result", id, `result for ${tuId}`),
			tool_name: tuId,
		});
		const msgs: Message[] = [
			msg("user", "u1", "hi"),
			tc("tc1", ["a", "b"]),
			tr("tr1", "a"),
			tr("tr2", "b"),
			msg("user", "u2", "next"),
			purgeMsg("p1", ["tr2"], "purged one result"),
		];
		const out = substitutePurgedMessages({ messages: msgs, threadId: THREAD_ID });
		// Dropping only tr2 would leave tc1's tool_use "b" unanswered —
		// the call and ALL its results must purge as a closure.
		if (out.some((m) => m.id === "tc1")) throw new Error("tool_call not symmetrically purged");
		if (out.some((m) => m.id === "tr1")) throw new Error("sibling tool_result not purged");
		if (out.some((m) => m.id === "tr2")) throw new Error("tool_result survived purge");
	});

	it("P2e: id-based pairing — interleaved id-less legacy pair is not stolen by an id-bearing call", () => {
		// Legacy call (non-JSON content, no ids) followed by its id-less
		// result, then an id-bearing pair. Purging the legacy call must
		// drop its positional partner only.
		const msgs: Message[] = [
			msg("user", "u1", "hi"),
			msg("tool_call", "tc-legacy", "bash: ls -la"),
			msg("tool_result", "tr-legacy", "file listing"),
			msg("tool_call", "tc1", '[{"type":"tool_use","id":"a","name":"x","input":{}}]'),
			{ ...msg("tool_result", "tr1", "result for a"), tool_name: "a" },
			msg("user", "u2", "next"),
			purgeMsg("p1", ["tc-legacy"], "purged legacy call"),
		];
		const out = substitutePurgedMessages({ messages: msgs, threadId: THREAD_ID });
		if (out.some((m) => m.id === "tc-legacy")) throw new Error("legacy tool_call survived");
		if (out.some((m) => m.id === "tr-legacy"))
			throw new Error("legacy tool_result not positionally purged");
		if (!out.some((m) => m.id === "tc1")) throw new Error("unrelated tool_call was purged");
		if (!out.some((m) => m.id === "tr1")) throw new Error("unrelated tool_result was purged");
	});

	it("P3: each purge group emits exactly one summary message", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(safeKey, { minLength: 2, maxLength: 5 }),
				safeText,
				(targetIds, summary) => {
					const msgs: Message[] = [
						...targetIds.map((id) => msg("user", id, "to-be-purged")),
						purgeMsg("p1", targetIds, summary),
					];
					const out = substitutePurgedMessages({ messages: msgs, threadId: THREAD_ID });
					const summaryRows = out.filter((m) => m.id.startsWith("purge-summary-"));
					return summaryRows.length === 1;
				},
			),
			{ numRuns: 50 },
		);
	});

	it("P4: summary carries the unverified-provenance prefix", () => {
		const msgs: Message[] = [msg("user", "u1", "purgeme"), purgeMsg("p1", ["u1"], "the gist")];
		const out = substitutePurgedMessages({ messages: msgs, threadId: THREAD_ID });
		const summary = out.find((m) => m.id.startsWith("purge-summary-"));
		if (!summary) throw new Error("no summary emitted");
		if (!summary.content.includes("agent-authored summary, unverified")) {
			throw new Error("provenance prefix regression");
		}
		if (!summary.content.includes("the gist")) {
			throw new Error("agent's summary text not preserved");
		}
	});

	it("P5: non-purged messages survive", () => {
		fc.assert(
			fc.property(
				fc.array(fc.tuple(safeKey, safeText), { minLength: 1, maxLength: 8 }),
				(triples) => {
					const userMsgs = triples.map(([id, content]) => msg("user", id, content));
					// No purge metadata at all.
					const out = substitutePurgedMessages({ messages: userMsgs, threadId: THREAD_ID });
					if (out.length !== userMsgs.length) return false;
					for (let i = 0; i < userMsgs.length; i++) {
						if (out[i].id !== userMsgs[i].id) return false;
						if (out[i].content !== userMsgs[i].content) return false;
					}
					return true;
				},
			),
			{ numRuns: 50 },
		);
	});

	it("P6: determinism — same input produces same output", () => {
		fc.assert(
			fc.property(
				fc.array(fc.tuple(safeKey, safeText), { minLength: 0, maxLength: 6 }),
				(triples) => {
					const msgs = triples.map(([id, content]) => msg("user", id, content));
					const a = JSON.stringify(
						substitutePurgedMessages({ messages: msgs, threadId: THREAD_ID }),
					);
					const b = JSON.stringify(
						substitutePurgedMessages({ messages: msgs, threadId: THREAD_ID }),
					);
					return a === b;
				},
			),
			{ numRuns: 50 },
		);
	});

	it("P7: malformed purge metadata is silently skipped", () => {
		const msgs: Message[] = [
			msg("user", "u1", "hi"),
			msg("purge", "p1", "this is not JSON {{{"),
			msg("user", "u2", "still here"),
		];
		const out = substitutePurgedMessages({ messages: msgs, threadId: THREAD_ID });
		// The purge metadata row is still dropped from output (it has
		// role:"purge" which is non-LLM-compatible).
		if (out.some((m) => m.id === "p1")) throw new Error("malformed purge row leaked");
		// User messages survive.
		if (!out.some((m) => m.id === "u1")) throw new Error("u1 dropped");
		if (!out.some((m) => m.id === "u2")) throw new Error("u2 dropped");
	});

	it("P8: empty input → empty output", () => {
		const out = substitutePurgedMessages({ messages: [], threadId: THREAD_ID });
		if (out.length !== 0) throw new Error("expected empty output");
	});
});

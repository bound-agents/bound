/**
 * Property tests for Stage 5 ANNOTATION.
 *
 * Properties:
 *
 *   N1 Determinism — same `(messages, nowMs)` produces byte-equal output.
 *   N2 Non-LLM roles dropped — alert/purge never reach output.
 *   N3 Model-switch cap — at most MODEL_SWITCH_CAP markers.
 *   N4 No model-switch on first assistant.
 *   N5 tool_use_id resolution — every tool_result has non-null tool_use_id.
 *   N6 Timestamp annotation only on user messages.
 *   N7 Recent-user no-annotation — < 60s old user messages.
 *   N8 Empty input → empty output.
 */

import { describe, it } from "bun:test";
import type { Message } from "@bound/shared";
import fc from "fast-check";
import { MODEL_SWITCH_CAP, annotateMessages } from "../annotate";

const NOW_ISO = "2026-05-25T12:00:00.000Z";
const NOW_MS = new Date(NOW_ISO).getTime();
const OLD_ISO = "2026-05-25T11:00:00.000Z"; // 1h ago
const RECENT_ISO = "2026-05-25T11:59:30.000Z"; // 30s ago

function msg(
	role: Message["role"],
	id: string,
	content: string,
	overrides: Partial<Message> = {},
): Message {
	return {
		id,
		thread_id: "test-thread",
		role,
		content,
		model_id: null,
		tool_name: null,
		created_at: OLD_ISO,
		modified_at: OLD_ISO,
		host_origin: "test",
		deleted: 0,
		exit_code: null,
		metadata: null,
		...overrides,
	};
}

describe("annotateMessages — property tests", () => {
	it("N1: determinism — same input + nowMs produces byte-equal output", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(
						fc.constantFrom<Message["role"]>(
							"user",
							"assistant",
							"developer",
							"tool_call",
							"tool_result",
						),
						fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !/[\n\r]/.test(s)),
					),
					{ maxLength: 6 },
				),
				(triples) => {
					const msgs = triples.map(([role, content], i) => msg(role, `id-${i}`, content));
					const a = JSON.stringify(annotateMessages({ messages: msgs, nowMs: NOW_MS }));
					const b = JSON.stringify(annotateMessages({ messages: msgs, nowMs: NOW_MS }));
					return a === b;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("N2: non-LLM roles dropped — alert and purge never reach output", () => {
		const msgs: Message[] = [
			msg("user", "u1", "hello"),
			msg("alert", "a1", "alert!"),
			msg("purge", "p1", "{}"),
			msg("assistant", "a2", "response"),
		];
		const out = annotateMessages({ messages: msgs, nowMs: NOW_MS });
		if (out.some((m) => (m as { role: string }).role === "alert")) {
			throw new Error("alert leaked");
		}
		if (out.some((m) => (m as { role: string }).role === "purge")) {
			throw new Error("purge leaked");
		}
	});

	it("N3: model-switch cap — never exceeds MODEL_SWITCH_CAP markers", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.string({ minLength: 1, maxLength: 8 }).filter((s) => /^[a-z0-9-]+$/.test(s)),
					{ minLength: 0, maxLength: 12 },
				),
				(modelIds) => {
					const msgs: Message[] = modelIds.map((modelId, i) =>
						msg("assistant", `a-${i}`, `r${i}`, { model_id: modelId }),
					);
					const out = annotateMessages({ messages: msgs, nowMs: NOW_MS });
					const switchMarkers = out.filter(
						(m) =>
							typeof m.content === "string" &&
							(m.content as string).startsWith("Model switched from "),
					);
					return switchMarkers.length <= MODEL_SWITCH_CAP;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("N4: first assistant message never produces a switch marker", () => {
		const msgs: Message[] = [
			msg("user", "u1", "hi"),
			msg("assistant", "a1", "first response", { model_id: "opus" }),
		];
		const out = annotateMessages({ messages: msgs, nowMs: NOW_MS });
		const hasMarker = out.some(
			(m) =>
				typeof m.content === "string" && (m.content as string).startsWith("Model switched from "),
		);
		if (hasMarker) throw new Error("first assistant produced switch marker");
	});

	it("N5: tool_use_id resolution — every tool_result has a non-null tool_use_id", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.constantFrom<Message["role"]>("user", "assistant", "tool_call", "tool_result"),
					{ minLength: 1, maxLength: 8 },
				),
				(roles) => {
					const msgs: Message[] = roles.map((role, i) =>
						msg(role, `id-${i}`, role === "tool_call" ? "[]" : `c${i}`),
					);
					const out = annotateMessages({ messages: msgs, nowMs: NOW_MS });
					for (const m of out) {
						if ((m as { role: string }).role === "tool_result") {
							if (!m.tool_use_id) return false;
						}
					}
					return true;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("N6: timestamp annotation only on user messages", () => {
		const msgs: Message[] = [
			msg("user", "u1", "hi"),
			msg("assistant", "a1", "response"),
			msg("developer", "d1", "note"),
		];
		const out = annotateMessages({ messages: msgs, nowMs: NOW_MS });
		// User message should be timestamp-prefixed (it's an hour old).
		const u = out.find((m) => m.role === "user");
		if (!u || typeof u.content !== "string" || !u.content.startsWith("[")) {
			throw new Error("user message should have timestamp prefix");
		}
		// Assistant + developer should NOT be prefixed.
		for (const m of out) {
			if (m.role === "assistant" || m.role === "developer") {
				if (
					typeof m.content === "string" &&
					m.content.startsWith("[") &&
					/^\[\w+ \d/.test(m.content)
				) {
					throw new Error(`role ${m.role} got timestamp prefix`);
				}
			}
		}
	});

	it("N7: recent-user no-annotation — < 60s old user messages", () => {
		const msgs: Message[] = [msg("user", "u1", "very recent", { created_at: RECENT_ISO })];
		const out = annotateMessages({ messages: msgs, nowMs: NOW_MS });
		if (out[0].content !== "very recent") {
			throw new Error("recent user message was annotated");
		}
	});

	it("N8: empty input → empty output", () => {
		const out = annotateMessages({ messages: [], nowMs: NOW_MS });
		if (out.length !== 0) throw new Error("expected empty output");
	});
});

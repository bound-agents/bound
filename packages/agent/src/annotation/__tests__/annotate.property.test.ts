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

	it("N7 (load-bearing): timestamp annotation is byte-stable across ANY nowMs — no age-based cliff", () => {
		// Live regression on thread `6fff1513-...` 2026-05-26: the prior
		// annotation rule applied a timestamp prefix only when the user
		// message was ≥ 60s old. For autonomous tasks (single user_1
		// followed by long inner loops), this caused a one-time byte shift
		// at exactly 60s into the conversation — user_1's wire content
		// went from `Let's implement...` to `[May 26, 15:53] Let's
		// implement...`, a +16-char shift. The cachePoint anchored on
		// user_1 thrashed across that boundary; cumulative cache stuck
		// at the system-anchor floor for the rest of the conversation.
		//
		// The contract: annotation output is a pure function of (msg,
		// msg.created_at) — independent of nowMs. Equivalently: the same
		// user message produces the same wire content regardless of when
		// the agent loop runs the annotation pass.
		//
		// Encoded as a property: for any user message age, the output is
		// byte-equal to the output at any other age.
		const userMsg = msg("user", "u1", "Let's implement issue #34", {
			created_at: "2026-05-25T11:00:00.000Z",
		});
		const ages = [
			0, // age 0s
			1_000, // 1s
			30_000, // 30s — was previously not annotated
			60_000, // exactly the old cliff
			61_000, // 1s past the old cliff
			3_600_000, // 1h
		];
		const outputs = ages.map((delta) => {
			const at = new Date(userMsg.created_at).getTime() + delta;
			return JSON.stringify(annotateMessages({ messages: [userMsg], nowMs: at }));
		});
		// All outputs must be byte-equal — no time-based cliff.
		for (let i = 1; i < outputs.length; i++) {
			if (outputs[i] !== outputs[0]) {
				throw new Error(
					`annotation output diverged at age ${ages[i]}ms: ${outputs[0]} vs ${outputs[i]}`,
				);
			}
		}
		// And the annotation must be PRESENT (timestamp prefix added) so
		// the model still sees when the user spoke.
		const out = annotateMessages({ messages: [userMsg], nowMs: NOW_MS });
		if (typeof out[0].content !== "string" || !out[0].content.startsWith("[")) {
			throw new Error("user message should always have timestamp prefix for byte stability");
		}
	});

	it("N7b (property): annotation is independent of nowMs for any user message", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 0, maxLength: 50 }).filter((s) => !/[\n\r]/.test(s)),
				fc.integer({ min: 0, max: 24 * 3600_000 }), // 0..24h ages
				fc.integer({ min: 0, max: 24 * 3600_000 }), // another age to compare
				(content, ageA, ageB) => {
					const created = "2026-05-25T11:00:00.000Z";
					const userMsg = msg("user", "u1", content, { created_at: created });
					const tA = new Date(created).getTime() + ageA;
					const tB = new Date(created).getTime() + ageB;
					const outA = JSON.stringify(annotateMessages({ messages: [userMsg], nowMs: tA }));
					const outB = JSON.stringify(annotateMessages({ messages: [userMsg], nowMs: tB }));
					return outA === outB;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("N8: empty input → empty output", () => {
		const out = annotateMessages({ messages: [], nowMs: NOW_MS });
		if (out.length !== 0) throw new Error("expected empty output");
	});
});

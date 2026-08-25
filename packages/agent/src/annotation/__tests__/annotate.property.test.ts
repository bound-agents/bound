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

import { describe, expect, it } from "bun:test";
import type { Message } from "@bound/shared";
import { countContentTokens } from "@bound/shared";
import fc from "fast-check";
import { MODEL_SWITCH_CAP, annotateMessages, annotateMessagesWithTokens } from "../annotate";

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
		// User message should be wrapped in the metadata envelope.
		const u = out.find((m) => m.role === "user");
		if (!u || typeof u.content !== "string" || !u.content.startsWith("<user-message")) {
			throw new Error("user message should be wrapped in the <user-message> envelope");
		}
		// Assistant + developer should NOT be enveloped.
		for (const m of out) {
			if (m.role === "assistant" || m.role === "developer") {
				if (typeof m.content === "string" && m.content.startsWith("<user-message")) {
					throw new Error(`role ${m.role} got the user-message envelope`);
				}
			}
		}
	});

	it("N7 (load-bearing): timestamp annotation is byte-stable across ANY nowMs — no age-based cliff", () => {
		// Live regression: the prior
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
		if (typeof out[0].content !== "string" || !out[0].content.startsWith("<user-message")) {
			throw new Error("user message should always be enveloped for byte stability");
		}
	});

	it("N9: user messages are wrapped in a <user-message> envelope carrying the send time", () => {
		const created = "2026-05-25T11:00:00.000Z";
		// String content: full wrap with a sent="..." attribute.
		const strOut = annotateMessages({
			messages: [msg("user", "u1", "hello there", { created_at: created })],
			nowMs: NOW_MS,
		});
		const strContent = strOut[0].content;
		if (typeof strContent !== "string") throw new Error("expected string content");
		if (!/^<user-message sent="[^"]+">\n/.test(strContent)) {
			throw new Error(`missing opening envelope tag: ${strContent}`);
		}
		if (!strContent.endsWith("\n</user-message>")) {
			throw new Error(`missing closing envelope tag: ${strContent}`);
		}
		if (!strContent.includes("hello there")) {
			throw new Error("original content lost inside envelope");
		}

		// ContentBlock[] content (e.g. an image message): wrap with leading +
		// trailing text blocks so the original blocks (including non-text) are
		// preserved between the envelope tags.
		const blocks = JSON.stringify([
			{ type: "text", text: "look at this" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
		]);
		const arrOut = annotateMessages({
			messages: [msg("user", "u2", blocks, { created_at: created })],
			nowMs: NOW_MS,
		});
		const arrContent = arrOut[0].content;
		if (!Array.isArray(arrContent)) throw new Error("expected ContentBlock[] content");
		if (arrContent.length !== 4) {
			throw new Error(`expected 4 blocks (open + 2 orig + close), got ${arrContent.length}`);
		}
		const first = arrContent[0] as { type: string; text?: string };
		const last = arrContent[3] as { type: string; text?: string };
		if (first.type !== "text" || !first.text?.startsWith("<user-message sent=")) {
			throw new Error("first block should open the envelope");
		}
		if ((arrContent[2] as { type: string }).type !== "image") {
			throw new Error("original image block should be preserved");
		}
		if (last.type !== "text" || last.text !== "</user-message>") {
			throw new Error("last block should close the envelope");
		}
	});

	it('N10: user message carries a from="..." attribute when metadata stamps a user_name', () => {
		const created = "2026-05-25T11:00:00.000Z";
		const out = annotateMessages({
			messages: [
				msg("user", "u1", "hello there", {
					created_at: created,
					metadata: JSON.stringify({ tz_offset: -420, user_name: "Kara" }),
				}),
			],
			nowMs: NOW_MS,
		});
		const content = out[0].content;
		if (typeof content !== "string") throw new Error("expected string content");
		if (!/^<user-message from="Kara" sent="[^"]+">\n/.test(content)) {
			throw new Error(`missing from attribute on envelope: ${content}`);
		}
	});

	it("N10b: no from attribute when metadata has no user_name (old rows unchanged)", () => {
		const created = "2026-05-25T11:00:00.000Z";
		// Both a null-metadata row and a tz-only row must render byte-identically
		// to the pre-feature envelope so existing threads keep their cachePoint.
		for (const metadata of [null, JSON.stringify({ tz_offset: -420 })]) {
			const out = annotateMessages({
				messages: [msg("user", "u1", "hello there", { created_at: created, metadata })],
				nowMs: NOW_MS,
			});
			const content = out[0].content;
			if (typeof content !== "string") throw new Error("expected string content");
			if (content.includes(" from=")) {
				throw new Error(`unexpected from attribute for metadata=${metadata}: ${content}`);
			}
			if (!/^<user-message sent="[^"]+">\n/.test(content)) {
				throw new Error(`envelope shape changed for metadata=${metadata}: ${content}`);
			}
		}
	});

	it("N10c: a user_name with XML-significant characters is escaped in the attribute", () => {
		const created = "2026-05-25T11:00:00.000Z";
		const out = annotateMessages({
			messages: [
				msg("user", "u1", "hi", {
					created_at: created,
					metadata: JSON.stringify({ user_name: 'A&B <"x">' }),
				}),
			],
			nowMs: NOW_MS,
		});
		const content = out[0].content as string;
		if (!content.includes('from="A&amp;B &lt;&quot;x&quot;&gt;"')) {
			throw new Error(`user_name not escaped: ${content}`);
		}
	});

	it('N11: user message carries a role="..." attribute when metadata stamps a sender_role', () => {
		const created = "2026-05-25T11:00:00.000Z";
		const out = annotateMessages({
			messages: [
				msg("user", "u1", "diagnose run 1234", {
					created_at: created,
					metadata: JSON.stringify({ user_name: "Polaris", sender_role: "main" }),
				}),
			],
			nowMs: NOW_MS,
		});
		const content = out[0].content;
		if (typeof content !== "string") throw new Error("expected string content");
		// #201 envelope attribute order is `from role sent`.
		if (!/^<user-message from="Polaris" role="main" sent="[^"]+">\n/.test(content)) {
			throw new Error(`missing or misordered role attribute on envelope: ${content}`);
		}
	});

	it("N11b: role attribute appears with sent even when no from is stamped", () => {
		const created = "2026-05-25T11:00:00.000Z";
		const out = annotateMessages({
			messages: [
				msg("user", "u1", "hi", {
					created_at: created,
					metadata: JSON.stringify({ sender_role: "user" }),
				}),
			],
			nowMs: NOW_MS,
		});
		const content = out[0].content;
		if (typeof content !== "string") throw new Error("expected string content");
		if (!/^<user-message role="user" sent="[^"]+">\n/.test(content)) {
			throw new Error(`missing role attribute without from: ${content}`);
		}
	});

	it("N11c: no role attribute when metadata has no sender_role (old rows unchanged)", () => {
		const created = "2026-05-25T11:00:00.000Z";
		// A null-metadata row, a tz-only row, and a from-only row must all render
		// with no role= so pre-feature envelopes keep their exact bytes (cachePoint).
		for (const metadata of [
			null,
			JSON.stringify({ tz_offset: -420 }),
			JSON.stringify({ user_name: "Kara" }),
		]) {
			const out = annotateMessages({
				messages: [msg("user", "u1", "hello there", { created_at: created, metadata })],
				nowMs: NOW_MS,
			});
			const content = out[0].content;
			if (typeof content !== "string") throw new Error("expected string content");
			if (content.includes(" role=")) {
				throw new Error(`unexpected role attribute for metadata=${metadata}: ${content}`);
			}
		}
	});

	it("N11d: a sender_role with XML-significant characters is escaped in the attribute", () => {
		const created = "2026-05-25T11:00:00.000Z";
		const out = annotateMessages({
			messages: [
				msg("user", "u1", "hi", {
					created_at: created,
					metadata: JSON.stringify({ sender_role: 'a&<"b>' }),
				}),
			],
			nowMs: NOW_MS,
		});
		const content = out[0].content as string;
		if (!content.includes('role="a&amp;&lt;&quot;b&gt;"')) {
			throw new Error(`sender_role not escaped: ${content}`);
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

	// N9: perMessageTokens is aligned 1:1 with the annotated output AND each entry
	// equals a from-scratch countContentTokens over that annotated message. This
	// pins the identity-cache optimization to be lossless — the precomputed counts
	// downstream stages reuse must equal what re-tokenizing would have produced.
	it("N9: perMessageTokens aligns with output and equals countContentTokens", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						role: fc.constantFrom("user", "assistant", "tool_result", "tool_call"),
						id: fc
							.string({ minLength: 1, maxLength: 12 })
							.filter((s) => /^[a-zA-Z0-9_-]+$/.test(s)),
						content: fc.string({ maxLength: 60 }).filter((s) => !/[\n\r]/.test(s)),
						model: fc.constantFrom("m1", "m2"),
					}),
					{ maxLength: 12 },
				),
				(specs) => {
					// Each message gets a globally-unique id so the identity cache's
					// invariant holds — (id, modified_at) uniquely determines content, as
					// it does in production (immutable rows). Reusing ids across
					// fast-check runs with different content would (correctly) return a
					// prior run's cached count.
					const runTag = `${Math.random()}`;
					const msgs: Message[] = specs.map((s, i) =>
						msg(s.role as Message["role"], `${runTag}-${s.id}-${i}`, s.content, {
							model_id: s.role === "assistant" ? s.model : null,
							tool_name: s.role === "tool_result" ? "t" : null,
						}),
					);
					const { messages: out, perMessageTokens } = annotateMessagesWithTokens({
						messages: msgs,
						nowMs: NOW_MS,
					});
					if (perMessageTokens.length !== out.length) return false;
					for (let i = 0; i < out.length; i++) {
						if (perMessageTokens[i] !== countContentTokens(out[i].content)) return false;
					}
					return true;
				},
			),
			{ numRuns: 300 },
		);
	});

	it("N9b: sum of perMessageTokens equals the old full-array reduce", () => {
		// Unique ids per run: the identity cache is process-global and persists
		// across tests, so fixed ids could collide with another test's entries
		// (which map the same id to different content). Production ids are UUIDs.
		const tag = `n9b-${Math.random()}`;
		const msgs: Message[] = [
			msg("user", `${tag}-u1`, "hello world this is a user message"),
			msg("assistant", `${tag}-a1`, "assistant reply with some tokens", { model_id: "m1" }),
			msg(
				"tool_call",
				`${tag}-tc1`,
				JSON.stringify([{ type: "tool_use", id: "x", name: "n", input: {} }]),
				{ model_id: "m1" },
			),
			msg("tool_result", `${tag}-tr1`, "the tool result body", { tool_name: "x" }),
		];
		const { messages: out, perMessageTokens } = annotateMessagesWithTokens({
			messages: msgs,
			nowMs: NOW_MS,
		});
		const sumViaCache = perMessageTokens.reduce((a, b) => a + b, 0);
		const sumViaReduce = out.reduce((a, m) => a + countContentTokens(m.content), 0);
		expect(sumViaCache).toBe(sumViaReduce);
	});
});

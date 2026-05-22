/**
 * Bridge layer tests — these are the correctness floor for the AI SDK
 * migration. If one of these changes unexpectedly, the relay/agent-loop
 * plumbing downstream of the drivers is likely about to behave differently.
 *
 * Grouped by function: toModelMessages, toToolSet, mapChunks, mapError.
 */

import { describe, expect, it } from "bun:test";
import {
	ANTHROPIC_ENVELOPE,
	BEDROCK_PERMISSIVE_ENVELOPE,
	MAX_TOOL_USE_ID_LENGTH,
	PERMISSIVE_ENVELOPE,
	mapChunks,
	mapError,
	sanitizeToolNameForEnvelope,
	sanitizeToolUseId,
	toModelMessages,
	toToolSet,
} from "../ai-sdk-bridge";
import type { LLMMessage, StreamChunk } from "../types";
import { LLMError } from "../types";

// Helper to drain an async iterable into an array.
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const x of iter) out.push(x);
	return out;
}

// Helper: AI SDK fullStream is an AsyncIterable of events; synthesize one.
async function* events(...parts: Array<Record<string, unknown>>): AsyncIterable<unknown> {
	for (const p of parts) yield p;
}

describe("toModelMessages — basic role mapping", () => {
	it("passes string user content through", () => {
		const out = toModelMessages([{ role: "user", content: "hello" }]);
		expect(out).toEqual([{ role: "user", content: "hello" }]);
	});

	it("passes string assistant content through", () => {
		// Prefix with a user message — the conversation-start invariant
		// (covered in its own describe block below) would otherwise prepend
		// a placeholder. We want to isolate the assistant-passthrough behavior.
		const out = toModelMessages([
			{ role: "user", content: "hi there" },
			{ role: "assistant", content: "hi" },
		]);
		expect(out).toEqual([
			{ role: "user", content: "hi there" },
			{ role: "assistant", content: "hi" },
		]);
	});

	it("passes string system content through", () => {
		const out = toModelMessages([
			{ role: "user", content: "hi" },
			{ role: "system", content: "sys" },
		]);
		expect(out).toEqual([
			{ role: "user", content: "hi" },
			{ role: "system", content: "sys" },
		]);
	});

	// developer-role messages carry volatile context (enrichment, platform
	// context, model switches). They are emitted interleaved with history —
	// the agent loop always appends one at the tail before calling the LLM,
	// so they can appear between user/assistant turns. Bedrock rejects
	// multiple system messages separated by user/assistant, so we merge
	// developer content into the neighboring user message, wrapped in a
	// <system-context> tag so the model can tell it apart from user input.
	// Contract: "mapped by drivers to <system-context>-wrapped text prepended
	// to the next user message" (CLAUDE.md).

	it("prepends developer content to the next user message", () => {
		const out = toModelMessages([
			{ role: "developer", content: "dev note" },
			{ role: "user", content: "hi" },
		]);
		expect(out).toEqual([
			{ role: "user", content: "<system-context>\ndev note\n</system-context>\n\nhi" },
		]);
	});

	it("emits a trailing user message when developer content follows an assistant turn (was: merged into earlier user, ended with assistant)", () => {
		// Regression: 2026-05-17, thread f096a101 / 98926e2d. The introspect
		// tool injects a developer-role message into the target thread AFTER
		// the trailing assistant turn. The bridge used to walk back to the
		// most recent user message and merge dev content into it, leaving
		// the conversation ending with the assistant — which Anthropic
		// strict mode rejects as "This model does not support assistant
		// message prefill. The conversation must end with a user message."
		//
		// New contract: dev content that arrives after an assistant turn
		// becomes a fresh trailing user message. This places it positionally
		// correct (after the assistant turn it followed in history) AND
		// satisfies the "must end with user" provider rule.
		const out = toModelMessages([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "there" },
			{ role: "developer", content: "enrichment tail" },
		]);
		expect(out).toEqual([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "there" },
			{ role: "user", content: "<system-context>\nenrichment tail\n</system-context>" },
		]);
	});

	it("merges multiple developer messages into one wrapped block", () => {
		const out = toModelMessages([
			{ role: "developer", content: "first" },
			{ role: "developer", content: "second" },
			{ role: "user", content: "hi" },
		]);
		expect(out).toEqual([
			{ role: "user", content: "<system-context>\nfirst\n\nsecond\n</system-context>\n\nhi" },
		]);
	});

	it("extracts text from developer block content before merging", () => {
		const out = toModelMessages([
			{
				role: "developer",
				content: [
					{ type: "text", text: "part-a " },
					{ type: "text", text: "part-b" },
				],
			},
			{ role: "user", content: "hi" },
		]);
		expect(out).toEqual([
			{
				role: "user",
				content: "<system-context>\npart-a part-b\n</system-context>\n\nhi",
			},
		]);
	});

	it("wraps developer-only input as a user message (conversation-start invariant)", () => {
		// Scheduler wakeup threads can have no pre-existing user message in
		// history; the bridge promotes the developer content into a synthetic
		// user-role message so the provider accepts the request. See the
		// "conversation-start invariant" describe block below for full coverage.
		const out = toModelMessages([{ role: "developer", content: "orphan" }]);
		expect(out.length).toBe(1);
		expect(out[0].role).toBe("user");
		expect(out[0].content).toEqual("<system-context>\norphan\n</system-context>");
	});

	it("merges developer into a user message that has content blocks", () => {
		const out = toModelMessages([
			{ role: "developer", content: "dev note" },
			{
				role: "user",
				content: [
					{ type: "text", text: "keep" },
					{ type: "text", text: "also" },
				],
			},
		]);
		expect(out).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "<system-context>\ndev note\n</system-context>" },
					{ type: "text", text: "keep" },
					{ type: "text", text: "also" },
				],
			},
		]);
	});
});

// Bedrock (and most providers) require the conversation to start with a
// user-role message. The scheduler produces wakeup threads shaped as
// [developer(wakeup), tool_call(retrieve_task), tool_result(payload)] with
// NO user message in history (by design — the task payload rides on the
// synthetic tool_result). The bridge must guarantee the resulting AI SDK
// ModelMessage[] starts with a user message, otherwise Bedrock returns
// "A conversation must start with a user message".
//
// This is the layer where the provider contract is enforced — individual
// drivers (bedrock-driver, openai-compatible-driver) both route through
// toModelMessages and share this invariant.
describe("toModelMessages — conversation-start invariant", () => {
	it("prepends a user message wrapping dev content when history starts with non-user (scheduler wakeup shape)", () => {
		const out = toModelMessages([
			{ role: "developer", content: "[Task wakeup] task triggered." },
			{
				role: "tool_call",
				content: [{ type: "tool_use", id: "tc1", name: "retrieve_task", input: {} }],
			},
			{
				role: "tool_result",
				tool_use_id: "tc1",
				content: [{ type: "text", text: "payload" }],
			},
		]);
		expect(out.length).toBe(3);
		expect(out[0].role).toBe("user");
		// Developer wakeup content survives — wrapped in <system-context>
		// so the model can distinguish it from user-authored input.
		expect(out[0].content).toEqual(
			"<system-context>\n[Task wakeup] task triggered.\n</system-context>",
		);
		expect(out[1].role).toBe("assistant");
		expect(out[2].role).toBe("tool");
	});

	it("prepends a neutral placeholder when no dev content and first message is non-user", () => {
		// Defense-in-depth: even without developer content, if the history
		// happens to lead with assistant/tool/system, the bridge must still
		// produce a user-starting conversation. The old toBedrockMessages
		// used "<system-notification />" for this; we preserve that shape.
		const out = toModelMessages([
			{
				role: "tool_call",
				content: [{ type: "tool_use", id: "tc1", name: "x", input: {} }],
			},
			{
				role: "tool_result",
				tool_use_id: "tc1",
				content: [{ type: "text", text: "r" }],
			},
		]);
		expect(out[0].role).toBe("user");
	});

	it("does nothing when the first message is already user", () => {
		const out = toModelMessages([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		]);
		expect(out.length).toBe(2);
		expect(out[0]).toEqual({ role: "user", content: "hi" });
	});

	it("wraps a developer-only input as a sendable user message (was: silently dropped)", () => {
		// Previously this returned [] — sendable nowhere. With the invariant
		// enforced, we produce a single user message carrying the dev content
		// so the model at least sees the context.
		const out = toModelMessages([{ role: "developer", content: "orphan dev" }]);
		expect(out.length).toBe(1);
		expect(out[0].role).toBe("user");
		expect(out[0].content).toEqual("<system-context>\norphan dev\n</system-context>");
	});
});

// Companion invariant to the conversation-start guard above: many providers
// (Anthropic strict, some GLM endpoints) ALSO require the conversation to
// END with a user-role message. A trailing assistant message gets rejected
// with "This model does not support assistant message prefill. The
// conversation must end with a user message."
//
// The introspect-into-claude-opus incident (2026-05-17, thread f096a101 /
// 98926e2d) was a direct hit on this constraint: the introspect tool injects
// a developer-role message AFTER the existing trailing assistant, and the
// bridge's old behavior buried the dev content into an earlier user message,
// leaving `assistant` as the last message. Both introspect attempts hit the
// adapter rejection with the prefill error.
describe("toModelMessages — conversation-end invariant (developer injection after assistant)", () => {
	it("introspect-shape: [user, assistant, developer] becomes a conversation ending with user", () => {
		const out = toModelMessages([
			{ role: "user", content: "original question" },
			{ role: "assistant", content: "original reply" },
			{
				role: "developer",
				content: "[introspect request from thread X] please review Y",
			},
		]);
		// Conversation must END with a user-role message.
		expect(out[out.length - 1].role).toBe("user");
		// The dev content is positionally AFTER the assistant turn it followed
		// in history (not buried into the earlier user).
		expect(out).toEqual([
			{ role: "user", content: "original question" },
			{ role: "assistant", content: "original reply" },
			{
				role: "user",
				content:
					"<system-context>\n[introspect request from thread X] please review Y\n</system-context>",
			},
		]);
	});

	it("notify-shape: [user, assistant, tool_call, tool_result, developer] also ends with user", () => {
		// Notification injection can land after a tool round-trip too. The
		// last assistant-side activity is the tool_result (which maps to a
		// `tool`-role message in result), so the dev still needs to become a
		// trailing user.
		const out = toModelMessages([
			{ role: "user", content: "kick off" },
			{
				role: "tool_call",
				content: [{ type: "tool_use", id: "tc1", name: "x", input: {} }],
			},
			{
				role: "tool_result",
				tool_use_id: "tc1",
				content: [{ type: "text", text: "result" }],
			},
			{
				role: "developer",
				content: "[notification from background task] heads up",
			},
		]);
		expect(out[out.length - 1].role).toBe("user");
		expect(out[out.length - 1].content).toEqual(
			"<system-context>\n[notification from background task] heads up\n</system-context>",
		);
	});

	it("multiple developer messages after an assistant collapse into ONE trailing user message", () => {
		// E.g., two notifications claimed in the same dispatch tick (introspect
		// + notify, or two separate notifies). Both should end up wrapped in a
		// single <system-context> block on a single trailing user message —
		// not split into two consecutive user messages, which can confuse
		// some adapters that disallow consecutive same-role turns.
		const out = toModelMessages([
			{ role: "user", content: "u" },
			{ role: "assistant", content: "a" },
			{ role: "developer", content: "first dev" },
			{ role: "developer", content: "second dev" },
		]);
		expect(out.length).toBe(3);
		expect(out[out.length - 1]).toEqual({
			role: "user",
			content: "<system-context>\nfirst dev\n\nsecond dev\n</system-context>",
		});
	});

	it("when last message is already user, dev content appends rather than creating a new user (no consecutive-user emission)", () => {
		// Regression guard: don't accidentally start emitting two consecutive
		// user-role messages — that's the failure case the original merge
		// behavior was protecting against. The new rule only emits a new
		// trailing user when the existing last message is non-user.
		const out = toModelMessages([
			{ role: "assistant", content: "a" },
			{ role: "user", content: "u" },
			{ role: "developer", content: "tail" },
		]);
		// The system-notification placeholder is prepended (start invariant),
		// then the assistant + user, then dev appended onto that user.
		const userMsgs = out.filter((m) => m.role === "user");
		expect(userMsgs.length).toBe(2); // placeholder + the real user with dev appended
		// The last message is still the SAME user message (not a new one).
		expect(out[out.length - 1].role).toBe("user");
		const lastContent = out[out.length - 1].content;
		// Dev got appended onto the existing user content.
		expect(typeof lastContent === "string" ? lastContent : "").toContain("u");
		expect(typeof lastContent === "string" ? lastContent : "").toContain(
			"<system-context>\ntail\n</system-context>",
		);
	});
});

describe("toModelMessages — content blocks", () => {
	it("converts text blocks to text parts, dropping empty", () => {
		const out = toModelMessages([
			{
				role: "user",
				content: [
					{ type: "text", text: "keep" },
					{ type: "text", text: "" }, // dropped
				],
			},
		]);
		expect(out[0].content).toEqual([{ type: "text", text: "keep" }]);
	});

	it("converts thinking blocks to reasoning parts", () => {
		const out = toModelMessages(
			[
				{ role: "user", content: "ask" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "reasoning text", signature: "sig-1" },
						{ type: "text", text: "answer" },
					],
				},
			],
			{ reasoningProviderOptions: "bedrock" },
		);
		expect(out[1].content).toEqual([
			{
				type: "reasoning",
				text: "reasoning text",
				providerOptions: { bedrock: { signature: "sig-1" } },
			},
			{ type: "text", text: "answer" },
		]);
	});

	it("emits anthropic-keyed providerOptions when target is anthropic", () => {
		const out = toModelMessages(
			[
				{ role: "user", content: "ask" },
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "reasoning text", signature: "sig-1" }],
				},
			],
			{ reasoningProviderOptions: "anthropic" },
		);
		expect(out[1].content).toEqual([
			{
				type: "reasoning",
				text: "reasoning text",
				providerOptions: { anthropic: { signature: "sig-1" } },
			},
		]);
	});

	it("omits providerOptions on reasoning when target is non-anthropic Bedrock", () => {
		// Reproduces the Kimi / MiniMax / GLM / Nova case: reasoningProviderOptions
		// is null because the target Bedrock model rejects
		// `reasoningContent.reasoningText.signature`. The reasoning text still
		// replays so the model retains context, but signature/redactedData are
		// dropped.
		const out = toModelMessages(
			[
				{ role: "user", content: "ask" },
				{
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "reasoning text",
							signature: "sig-1",
							redacted_data: "BLOB",
						},
						{ type: "text", text: "answer" },
					],
				},
			],
			{ reasoningProviderOptions: null },
		);
		expect(out[1].content).toEqual([
			{ type: "reasoning", text: "reasoning text" },
			{ type: "text", text: "answer" },
		]);
	});

	it("omits providerOptions on reasoning when reasoningProviderOptions is unset", () => {
		// Default behavior — callers that don't set reasoningProviderOptions
		// (e.g. openai-compatible-driver) get bare reasoning parts. The
		// providerOptions key is only meaningful when a provider has been
		// chosen by the driver layer.
		const out = toModelMessages([
			{ role: "user", content: "ask" },
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "reasoning text", signature: "sig-1" }],
			},
		]);
		expect(out[1].content).toEqual([{ type: "reasoning", text: "reasoning text" }]);
	});

	it("omits providerOptions on reasoning when no signature", () => {
		const out = toModelMessages([
			{ role: "user", content: "ask" },
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "bare" }],
			},
		]);
		expect(out[1].content).toEqual([{ type: "reasoning", text: "bare" }]);
	});

	it("converts base64 image blocks on user messages", () => {
		const data = Buffer.from("hello").toString("base64");
		const out = toModelMessages([
			{
				role: "user",
				content: [
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data },
					},
				],
			},
		]);
		const part = (out[0].content as Array<{ type: string }>)[0] as {
			type: string;
			image: Uint8Array;
			mediaType: string;
		};
		expect(part.type).toBe("image");
		expect(part.mediaType).toBe("image/png");
		expect(Array.from(part.image)).toEqual([...Buffer.from("hello")]);
	});

	it("emits a placeholder when a file_ref image has no resolver (no silent drop)", () => {
		const out = toModelMessages([
			{
				role: "user",
				content: [
					{
						type: "image",
						source: { type: "file_ref", file_id: "f1" },
					},
				],
			},
		]);
		// Caller didn't pass resolveFileRef → bridge surfaces the missing
		// image as a clear placeholder so the model is informed.
		expect(out[0].content).toEqual([{ type: "text", text: "[Image unavailable: file_id=f1]" }]);
	});

	it("resolves file_ref images via resolveFileRef callback", () => {
		const data = Buffer.from("png-bytes").toString("base64");
		const out = toModelMessages(
			[
				{
					role: "user",
					content: [
						{
							type: "image",
							source: { type: "file_ref", file_id: "f1", media_type: "image/png" },
						},
					],
				},
			],
			{
				resolveFileRef: (id) => (id === "f1" ? data : null),
			},
		);
		const part = (out[0].content as Array<Record<string, unknown>>)[0] as {
			type: string;
			mediaType: string;
			image: Uint8Array;
		};
		expect(part.type).toBe("image");
		expect(part.mediaType).toBe("image/png");
		expect(Array.from(part.image)).toEqual([...Buffer.from("png-bytes")]);
	});

	it("routes image blocks on assistant messages through FilePart (AssistantContent forbids ImagePart but allows FilePart)", () => {
		const data = Buffer.from("x").toString("base64");
		const out = toModelMessages([
			{ role: "user", content: "plot please" },
			{
				role: "assistant",
				content: [
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data },
						description: "a plot",
					},
					{ type: "text", text: "here it is" },
				],
			},
		]);
		const parts = out[1].content as Array<Record<string, unknown>>;
		expect(parts[0]).toMatchObject({
			type: "file",
			mediaType: "image/png",
			filename: "a plot",
		});
		expect((parts[0] as { data: Uint8Array }).data).toBeInstanceOf(Uint8Array);
		expect(parts[1]).toEqual({ type: "text", text: "here it is" });
	});

	it("emits placeholder for unresolved file_ref images alongside other content (no silent drop)", () => {
		const out = toModelMessages([
			{
				role: "user",
				content: [
					{
						type: "image",
						source: { type: "file_ref", file_id: "f1" },
					},
					{ type: "text", text: "describe this" },
				],
			},
		]);
		expect(out[0].content).toEqual([
			{ type: "text", text: "[Image unavailable: file_id=f1]" },
			{ type: "text", text: "describe this" },
		]);
	});

	it("routes document base64 blocks as FilePart with IANA mediaType", () => {
		const data = Buffer.from("%PDF-1.4 ...").toString("base64");
		const out = toModelMessages([
			{
				role: "user",
				content: [
					{
						type: "document",
						source: { type: "base64", media_type: "application/pdf", data },
						filename: "report.pdf",
						title: "Q3 Report",
					},
				],
			},
		]);
		const parts = out[0].content as Array<Record<string, unknown>>;
		expect(parts[0]).toMatchObject({
			type: "file",
			mediaType: "application/pdf",
			filename: "report.pdf",
		});
		expect((parts[0] as { data: Uint8Array }).data).toBeInstanceOf(Uint8Array);
	});

	it("routes document base64 on assistant messages through FilePart", () => {
		const data = Buffer.from("...").toString("base64");
		const out = toModelMessages([
			{ role: "user", content: "csv please" },
			{
				role: "assistant",
				content: [
					{
						type: "document",
						source: { type: "base64", media_type: "text/csv", data },
						filename: "out.csv",
					},
				],
			},
		]);
		expect(out[1].content).toMatchObject([
			{ type: "file", mediaType: "text/csv", filename: "out.csv" },
		]);
	});

	it("falls back to text_representation when document source is file_ref (unresolved)", () => {
		const out = toModelMessages([
			{
				role: "user",
				content: [
					{
						type: "document",
						source: { type: "file_ref", file_id: "doc1" },
						text_representation: "extracted pdf text",
					},
				],
			},
		]);
		expect(out[0].content).toEqual([{ type: "text", text: "extracted pdf text" }]);
	});

	it("emits a placeholder when a file_ref document has no resolver and no text_representation", () => {
		const out = toModelMessages([
			{
				role: "user",
				content: [
					{
						type: "document",
						source: { type: "file_ref", file_id: "orphan" },
					},
				],
			},
		]);
		// Per the no-silent-drop policy, the model is informed a document
		// was attempted instead of receiving an empty turn.
		expect(out[0].content).toEqual([
			{ type: "text", text: "[Document unavailable: file_id=orphan]" },
		]);
	});

	it("resolves file_ref documents via resolveFileRef callback (assistant FilePart route)", () => {
		// "JVBERi0=" is "%PDF-" — a 5-byte PDF header round-trip.
		const out = toModelMessages(
			[
				{
					role: "user",
					content: [
						{
							type: "document",
							source: {
								type: "file_ref",
								file_id: "doc-1",
								media_type: "application/pdf",
							},
							filename: "report.pdf",
						},
					],
				},
			],
			{ resolveFileRef: (id) => (id === "doc-1" ? "JVBERi0=" : null) },
		);
		expect(out[0].content).toMatchObject([
			{ type: "file", mediaType: "application/pdf", filename: "report.pdf" },
		]);
	});

	it("emits a placeholder when resolveFileRef returns null for a document", () => {
		const out = toModelMessages(
			[
				{
					role: "user",
					content: [
						{
							type: "document",
							source: { type: "file_ref", file_id: "missing-doc" },
							title: "the report",
						},
					],
				},
			],
			{ resolveFileRef: () => null },
		);
		expect(out[0].content).toEqual([
			{
				type: "text",
				text: '[Document unavailable: file_id=missing-doc title="the report"]',
			},
		]);
	});

	it("propagates thinking.redacted_data to providerOptions.bedrock.redactedData", () => {
		const out = toModelMessages(
			[
				{ role: "user", content: "ask" },
				{
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "",
							redacted_data: "BLOB",
						},
						{ type: "text", text: "answer" },
					],
				},
			],
			{ reasoningProviderOptions: "bedrock" },
		);
		expect(out[1].content).toEqual([
			{
				type: "reasoning",
				text: "",
				providerOptions: { bedrock: { redactedData: "BLOB" } },
			},
			{ type: "text", text: "answer" },
		]);
	});

	it("merges signature and redacted_data under the same bedrock bucket", () => {
		const out = toModelMessages(
			[
				{ role: "user", content: "ask" },
				{
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "visible reasoning",
							signature: "SIG",
							redacted_data: "RED",
						},
					],
				},
			],
			{ reasoningProviderOptions: "bedrock" },
		);
		expect(out[1].content).toEqual([
			{
				type: "reasoning",
				text: "visible reasoning",
				providerOptions: { bedrock: { signature: "SIG", redactedData: "RED" } },
			},
		]);
	});

	it("drops redactedData when target is anthropic (bedrock-only field)", () => {
		// redactedData is a Bedrock-specific reasoning artifact. When replaying
		// to an Anthropic-direct endpoint, only the signature is meaningful.
		const out = toModelMessages(
			[
				{ role: "user", content: "ask" },
				{
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "visible",
							signature: "SIG",
							redacted_data: "RED",
						},
					],
				},
			],
			{ reasoningProviderOptions: "anthropic" },
		);
		expect(out[1].content).toEqual([
			{
				type: "reasoning",
				text: "visible",
				providerOptions: { anthropic: { signature: "SIG" } },
			},
		]);
	});

	it("synthesizes empty text part when parts list would be empty", () => {
		const out = toModelMessages([
			{ role: "user", content: "ask" },
			{ role: "assistant", content: [] },
		]);
		expect(out[1].content).toEqual([{ type: "text", text: "" }]);
	});
});

describe("toModelMessages — tool call / result wrapping", () => {
	// These tests all prepend a user message so they exercise tool-call /
	// tool-result wrapping in isolation, unaffected by the conversation-start
	// invariant (covered separately above). out[0] is the user prefix;
	// wrapping outputs start at out[1].
	it("wraps tool_call message as assistant with tool-call part", () => {
		const out = toModelMessages([
			{ role: "user", content: "weather?" },
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "call_1",
						name: "get_weather",
						input: { city: "Tokyo" },
					},
				],
			},
		]);
		expect(out[1]).toEqual({
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "call_1",
					toolName: "get_weather",
					input: { city: "Tokyo" },
				},
			],
		});
	});

	it("wraps tool_result with resolved toolName from prior tool_call", () => {
		const out = toModelMessages([
			{ role: "user", content: "weather?" },
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "call_42",
						name: "get_weather",
						input: {},
					},
				],
			},
			{
				role: "tool_result",
				tool_use_id: "call_42",
				content: [{ type: "text", text: "72F" }],
			},
		]);
		expect(out[2]).toEqual({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call_42",
					toolName: "get_weather",
					output: { type: "text", value: "72F" },
				},
			],
		});
	});

	it("resolves toolName when tool_call appears inline in assistant message", () => {
		const out = toModelMessages([
			{ role: "user", content: "search x" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "calling" },
					{
						type: "tool_use",
						id: "inline_1",
						name: "search",
						input: { q: "x" },
					},
				],
			},
			{
				role: "tool_result",
				tool_use_id: "inline_1",
				content: [{ type: "text", text: "ok" }],
			},
		]);
		expect(out[2]).toEqual({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "inline_1",
					toolName: "search",
					output: { type: "text", value: "ok" },
				},
			],
		});
	});

	it("falls back to empty toolName when no matching call", () => {
		const out = toModelMessages([
			{ role: "user", content: "hi" },
			{
				role: "tool_result",
				tool_use_id: "orphan",
				content: [{ type: "text", text: "?" }],
			},
		]);
		expect(out[1]).toEqual({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "orphan",
					toolName: "",
					output: { type: "text", value: "?" },
				},
			],
		});
	});

	it("parses JSON string content on tool_call (DB serialization path)", () => {
		const blocks = [{ type: "tool_use", id: "x", name: "y", input: { a: 1 } }];
		const out = toModelMessages([
			{ role: "user", content: "go" },
			{ role: "tool_call", content: JSON.stringify(blocks) },
		]);
		expect(out[1]).toEqual({
			role: "assistant",
			content: [{ type: "tool-call", toolCallId: "x", toolName: "y", input: { a: 1 } }],
		});
	});

	it("treats unparseable string on tool_result as text", () => {
		const out = toModelMessages([
			{ role: "user", content: "do it" },
			{
				role: "tool_result",
				tool_use_id: "z",
				content: "plain string result",
			},
		]);
		expect(out[1]).toEqual({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "z",
					toolName: "",
					output: { type: "text", value: "plain string result" },
				},
			],
		});
	});

	it("preserves tool_result payloads whose JSON-array items are not content blocks", () => {
		// Real-world case from the connector tool: a JSON array of plain data
		// objects (no `type` field on items). Previously normalizeBlocks would
		// happily parse the string into the array and the downstream
		// `.filter(b.type === "text")` swallowed everything, leaving the model
		// with an empty tool result ("Tool ran without output or errors").
		const payload = JSON.stringify([
			{ name: "message.received", description: "Message received", bindings: [] },
			{ name: "user.joined", description: "User joined", bindings: [] },
		]);
		const out = toModelMessages([
			{ role: "user", content: "list channels" },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call_channels",
						name: "connector",
						input: { action: "channels", server_name: "discord" },
					},
				],
			},
			{
				role: "tool_result",
				tool_use_id: "call_channels",
				content: payload,
			},
		]);
		const toolMsg = out[out.length - 1] as {
			role: string;
			content: Array<{
				type: string;
				toolCallId: string;
				toolName: string;
				output: { type: string; value: string };
			}>;
		};
		expect(toolMsg.role).toBe("tool");
		const value = toolMsg.content[0].output.value;
		expect(value.length).toBeGreaterThan(0);
		expect(value).toContain("message.received");
		expect(value).toContain("user.joined");
	});
});

describe("toModelMessages — tool_use id sanitization (cross-provider id portability)", () => {
	// Some upstream providers (notably OpenAI-compatible chat-completions
	// servers fronting Moonshot/Kimi, where the AI SDK synthesizes ids from the
	// `function.name` field when the server emits no explicit id) persist
	// `tool_use.id` values like "functions.memory:5". Anthropic enforces
	// `^[a-zA-Z0-9_-]+$` on tool_use.id and rejects the request outright when
	// such an id appears in history. Bedrock Converse and OpenAI-compatible
	// targets accept the broader charset, but we sanitize universally — the
	// safe charset is a strict subset of every provider's accepted charset, so
	// rewriting is always lossless on the wire and eliminates the need for
	// per-provider branching. Pairing between tool_use and tool_result must be
	// preserved through the rewrite, including when tool_use appears inline on
	// an assistant content block and when tool_result resolves toolName from
	// the prior call.

	it("sanitizes illegal characters in tool_use.id on a tool_call message", () => {
		const out = toModelMessages([
			{ role: "user", content: "go" },
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "functions.memory:5",
						name: "memory",
						input: {},
					},
				],
			},
		]);
		const assistantMsg = out[1] as {
			role: string;
			content: Array<{ type: string; toolCallId: string }>;
		};
		expect(assistantMsg.content[0].toolCallId).toBe("functions_memory_5");
		expect(assistantMsg.content[0].toolCallId).toMatch(/^[a-zA-Z0-9_-]+$/);
	});

	it("sanitizes illegal characters in tool_use.id on an inline assistant tool_use", () => {
		const out = toModelMessages([
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "calling" },
					{
						type: "tool_use",
						id: "functions.bash:0",
						name: "bash",
						input: { cmd: "ls" },
					},
				],
			},
		]);
		const assistantMsg = out[1] as {
			role: string;
			content: Array<{ type: string; toolCallId?: string }>;
		};
		const toolCallPart = assistantMsg.content.find((p) => p.type === "tool-call");
		expect(toolCallPart?.toolCallId).toBe("functions_bash_0");
		expect(toolCallPart?.toolCallId).toMatch(/^[a-zA-Z0-9_-]+$/);
	});

	it("sanitizes tool_result.tool_use_id with the same transform so pairing survives", () => {
		const out = toModelMessages([
			{ role: "user", content: "go" },
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "functions.memory:5",
						name: "memory",
						input: {},
					},
				],
			},
			{
				role: "tool_result",
				tool_use_id: "functions.memory:5",
				content: [{ type: "text", text: "ok" }],
			},
		]);
		const assistantMsg = out[1] as {
			content: Array<{ toolCallId: string }>;
		};
		const toolMsg = out[2] as {
			role: string;
			content: Array<{ toolCallId: string; toolName: string }>;
		};
		expect(toolMsg.role).toBe("tool");
		// Same sanitized id on both sides — pairing preserved.
		expect(toolMsg.content[0].toolCallId).toBe(assistantMsg.content[0].toolCallId);
		expect(toolMsg.content[0].toolCallId).toBe("functions_memory_5");
		// toolName resolution survives sanitization (the index is keyed by
		// the sanitized id, so tool_result still finds the prior call's name).
		expect(toolMsg.content[0].toolName).toBe("memory");
	});

	it("leaves already-safe ids unchanged (no spurious rewriting)", () => {
		const out = toModelMessages([
			{ role: "user", content: "go" },
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "tooluse_af647139ca7a41dabdcac6",
						name: "memory",
						input: {},
					},
				],
			},
			{
				role: "tool_result",
				tool_use_id: "tooluse_af647139ca7a41dabdcac6",
				content: [{ type: "text", text: "ok" }],
			},
		]);
		const assistantMsg = out[1] as {
			content: Array<{ toolCallId: string }>;
		};
		const toolMsg = out[2] as {
			content: Array<{ toolCallId: string }>;
		};
		expect(assistantMsg.content[0].toolCallId).toBe("tooluse_af647139ca7a41dabdcac6");
		expect(toolMsg.content[0].toolCallId).toBe("tooluse_af647139ca7a41dabdcac6");
	});

	it("sanitizes orphan tool_result tool_use_id (no matching call) so the wire form stays legal", () => {
		const out = toModelMessages([
			{ role: "user", content: "hi" },
			{
				role: "tool_result",
				tool_use_id: "functions.query:99",
				content: [{ type: "text", text: "?" }],
			},
		]);
		const toolMsg = out[1] as {
			role: string;
			content: Array<{ toolCallId: string; toolName: string }>;
		};
		expect(toolMsg.role).toBe("tool");
		expect(toolMsg.content[0].toolCallId).toBe("functions_query_99");
		expect(toolMsg.content[0].toolCallId).toMatch(/^[a-zA-Z0-9_-]+$/);
	});
});

describe("sanitizeToolUseId — length bound", () => {
	// Bedrock Converse caps toolUseId at 64 chars. Anthropic does not advertise
	// a documented length cap on tool_use.id but accepts arbitrary lengths;
	// the 64-char bound is the strict subset across supported providers.
	// The motivating case for length truncation (vs charset-only) is the
	// Kimi/Moonshot OpenAI-compatible path occasionally streaming its own
	// `<|tool_call_argument_begin|>` template token mid-stream, producing
	// 200+ char ids and names that Bedrock rejects with `Member must have
	// length less than or equal to 64`.

	it("exposes MAX_TOOL_USE_ID_LENGTH = 64", () => {
		expect(MAX_TOOL_USE_ID_LENGTH).toBe(64);
	});

	it("preserves the empty string", () => {
		expect(sanitizeToolUseId("")).toBe("");
	});

	it("leaves a 64-char already-safe id unchanged", () => {
		const id = "a".repeat(64);
		expect(sanitizeToolUseId(id)).toBe(id);
	});

	it("truncates an oversized id to 64 chars", () => {
		const id = "a".repeat(200);
		const out = sanitizeToolUseId(id);
		expect(out.length).toBe(64);
		expect(out).toBe("a".repeat(64));
	});

	it("truncates AFTER charset rewrite so the wire form remains 64 chars", () => {
		// Pathological case from thread 81bd5e8d: 200+ chars containing template
		// tokens (`<|`, `|>`, spaces, braces, quotes). Charset rewrite expands
		// nothing (every illegal char becomes a single `_`), then truncate.
		const id = `tooluse_50148b62615141b1aa5faa44d74b17d5 <|tool_call_argument_begin|> {"action": "store"`;
		const out = sanitizeToolUseId(id);
		expect(out.length).toBe(64);
		expect(out).toMatch(/^[a-zA-Z0-9_-]+$/);
	});

	it("is idempotent — sanitizing twice yields the same result", () => {
		const id = `functions.memory:5 <|tool_call_argument_begin|> ${"x".repeat(200)}`;
		const once = sanitizeToolUseId(id);
		const twice = sanitizeToolUseId(once);
		expect(twice).toBe(once);
	});
});

describe("envelope-aware sanitization (rewrite-only-on-violation)", () => {
	// The envelope shape captures the (provider, model)-dependent wire
	// validation envelope as data. sanitizeToolUseId/sanitizeToolNameForEnvelope
	// rewrite ONLY when the input violates the envelope, so an id that's
	// already legal for the target round-trips byte-identical. This is what
	// preserves Kimi's native `functions.<name>:<index>` fallback ids on the
	// bedrock-converse envelope, fixing the regression where universal
	// rewriting put Kimi out-of-distribution against its own training data.

	describe("sanitizeToolUseId(id, envelope)", () => {
		const kimiNativeId = "functions.memory:5";

		it("BEDROCK_PERMISSIVE_ENVELOPE preserves `.` and `:` (Kimi's native fallback shape)", () => {
			expect(sanitizeToolUseId(kimiNativeId, BEDROCK_PERMISSIVE_ENVELOPE)).toBe(kimiNativeId);
		});

		it("ANTHROPIC_ENVELOPE rewrites `.` and `:` to `_`", () => {
			expect(sanitizeToolUseId(kimiNativeId, ANTHROPIC_ENVELOPE)).toBe("functions_memory_5");
		});

		it("PERMISSIVE_ENVELOPE passes arbitrary characters through", () => {
			expect(sanitizeToolUseId("anything goes !@# $", PERMISSIVE_ENVELOPE)).toBe(
				"anything goes !@# $",
			);
		});

		it("rewrite-only-on-violation: an already-legal id is byte-identical out under every envelope", () => {
			const safe = "tooluse_abc123";
			expect(sanitizeToolUseId(safe, ANTHROPIC_ENVELOPE)).toBe(safe);
			expect(sanitizeToolUseId(safe, BEDROCK_PERMISSIVE_ENVELOPE)).toBe(safe);
			expect(sanitizeToolUseId(safe, PERMISSIVE_ENVELOPE)).toBe(safe);
		});

		it("default envelope is ANTHROPIC_ENVELOPE (back-compat with pre-envelope callers)", () => {
			// Equivalent to the legacy universal-rewrite behavior — important
			// for any caller that imported sanitizeToolUseId before this revamp.
			expect(sanitizeToolUseId(kimiNativeId)).toBe(
				sanitizeToolUseId(kimiNativeId, ANTHROPIC_ENVELOPE),
			);
		});

		it("truncates only when exceeding the envelope's idMaxLength", () => {
			const long = "a".repeat(100);
			expect(sanitizeToolUseId(long, ANTHROPIC_ENVELOPE).length).toBe(64);
			expect(sanitizeToolUseId(long, BEDROCK_PERMISSIVE_ENVELOPE).length).toBe(64);
			expect(sanitizeToolUseId(long, PERMISSIVE_ENVELOPE).length).toBe(100); // 100 < 256 cap
		});

		it("re-application across envelopes is stable when the result is already legal under both", () => {
			// Round-trip property: ANTHROPIC output is a strict subset of
			// BEDROCK_PERMISSIVE, so re-sanitizing under either is a no-op.
			const out1 = sanitizeToolUseId(kimiNativeId, ANTHROPIC_ENVELOPE);
			expect(sanitizeToolUseId(out1, BEDROCK_PERMISSIVE_ENVELOPE)).toBe(out1);
			expect(sanitizeToolUseId(out1, ANTHROPIC_ENVELOPE)).toBe(out1);
		});
	});

	describe("sanitizeToolNameForEnvelope(name, envelope)", () => {
		// tool_use.name is strict on every envelope except PERMISSIVE — names
		// in our codebase don't carry `.:` in practice, so the variants matter
		// less here than for ids; the contract test is mainly about parity
		// with sanitizeToolUseId and the empty-string fallback.

		it("falls back to 'unknown' when sanitization yields an empty string", () => {
			expect(sanitizeToolNameForEnvelope("", ANTHROPIC_ENVELOPE)).toBe("unknown");
			expect(sanitizeToolNameForEnvelope("...", ANTHROPIC_ENVELOPE)).toBe("___");
		});

		it("preserves an already-legal name under every envelope", () => {
			const safe = "memory_store";
			expect(sanitizeToolNameForEnvelope(safe, ANTHROPIC_ENVELOPE)).toBe(safe);
			expect(sanitizeToolNameForEnvelope(safe, BEDROCK_PERMISSIVE_ENVELOPE)).toBe(safe);
			expect(sanitizeToolNameForEnvelope(safe, PERMISSIVE_ENVELOPE)).toBe(safe);
		});
	});

	describe("toModelMessages — targetEnvelope drives id rewriting at the read boundary", () => {
		// This is the regression test for the Kimi malformed-tool-call fix:
		// the same input message history must produce DIFFERENT wire ids
		// depending on the (provider, model) target envelope. kimi-on-bedrock
		// MUST see its native id shape; claude-on-bedrock and
		// claude-on-anthropic-direct MUST see a rewritten id.

		const messages: LLMMessage[] = [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "functions.memory:5", name: "memory", input: {} }],
			},
			{
				role: "tool_result",
				tool_use_id: "functions.memory:5",
				content: [{ type: "text", text: "ok" }],
			},
		];

		it("kimi-on-bedrock: BEDROCK_PERMISSIVE_ENVELOPE preserves `functions.memory:5`", () => {
			const out = toModelMessages(messages, { targetEnvelope: BEDROCK_PERMISSIVE_ENVELOPE });
			const assistantMsg = out.find((m) => m.role === "assistant");
			const toolMsg = out.find((m) => m.role === "tool");
			expect((assistantMsg as any)?.content[0].toolCallId).toBe("functions.memory:5");
			expect((toolMsg as any)?.content[0].toolCallId).toBe("functions.memory:5");
		});

		it("claude-on-bedrock OR anthropic-direct: ANTHROPIC_ENVELOPE rewrites to `functions_memory_5`", () => {
			const out = toModelMessages(messages, { targetEnvelope: ANTHROPIC_ENVELOPE });
			const assistantMsg = out.find((m) => m.role === "assistant");
			const toolMsg = out.find((m) => m.role === "tool");
			expect((assistantMsg as any)?.content[0].toolCallId).toBe("functions_memory_5");
			expect((toolMsg as any)?.content[0].toolCallId).toBe("functions_memory_5");
		});

		it("default (no targetEnvelope) is ANTHROPIC_ENVELOPE (back-compat)", () => {
			const out = toModelMessages(messages);
			const assistantMsg = out.find((m) => m.role === "assistant");
			expect((assistantMsg as any)?.content[0].toolCallId).toBe("functions_memory_5");
		});

		it("openai-compatible: PERMISSIVE_ENVELOPE preserves arbitrary upstream id shapes", () => {
			const oddId = "weird id with spaces and !@#";
			const odd: LLMMessage[] = [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: oddId, name: "tool", input: {} }],
				},
			];
			const out = toModelMessages(odd, { targetEnvelope: PERMISSIVE_ENVELOPE });
			const assistantMsg = out.find((m) => m.role === "assistant");
			expect((assistantMsg as any)?.content[0].toolCallId).toBe(oddId);
		});

		it("envelope choice does NOT affect already-legal ids (no spurious rewrites)", () => {
			const safe: LLMMessage[] = [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tooluse_abc", name: "memory", input: {} }],
				},
			];
			for (const env of [ANTHROPIC_ENVELOPE, BEDROCK_PERMISSIVE_ENVELOPE, PERMISSIVE_ENVELOPE]) {
				const out = toModelMessages(safe, { targetEnvelope: env });
				const assistantMsg = out.find((m) => m.role === "assistant");
				expect((assistantMsg as any)?.content[0].toolCallId).toBe("tooluse_abc");
			}
		});
	});
});

describe("toModelMessages — tool_use.name sanitization (cross-provider portability)", () => {
	// Same motivating case as the id-sanitization block above: when an upstream
	// provider streams a malformed tool_use (Kimi/Moonshot template-token
	// leakage on the OpenAI-compatible path), the persisted ContentBlock has a
	// `name` field that violates Anthropic's `^[a-zA-Z0-9_-]+$` regex AND
	// Bedrock's 64-char `[a-zA-Z0-9_-]{1,64}` validation. The bridge applies
	// the same sanitizeToolName transform that stream-utils.ts exports and
	// that the streaming-boundary path in mapChunks uses, so the wire form is
	// always within every provider's accepted charset and length cap.

	it("sanitizes illegal characters in tool_use.name on a tool_call message", () => {
		const out = toModelMessages([
			{ role: "user", content: "go" },
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "tooluse_aaa",
						name: "memory.store:0",
						input: {},
					},
				],
			},
		]);
		const assistantMsg = out[1] as {
			content: Array<{ type: string; toolName: string }>;
		};
		expect(assistantMsg.content[0].toolName).toBe("memory_store_0");
		expect(assistantMsg.content[0].toolName).toMatch(/^[a-zA-Z0-9_-]+$/);
	});

	it("sanitizes tool_use.name on an inline assistant tool_use", () => {
		const out = toModelMessages([
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "calling" },
					{
						type: "tool_use",
						id: "tooluse_bbb",
						name: "bash.exec:0",
						input: { cmd: "ls" },
					},
				],
			},
		]);
		const assistantMsg = out[1] as {
			content: Array<{ type: string; toolName?: string }>;
		};
		const toolCallPart = assistantMsg.content.find((p) => p.type === "tool-call");
		expect(toolCallPart?.toolName).toBe("bash_exec_0");
		expect(toolCallPart?.toolName).toMatch(/^[a-zA-Z0-9_-]+$/);
	});

	it("truncates an oversized tool_use.name to 64 chars", () => {
		const out = toModelMessages([
			{ role: "user", content: "go" },
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "tooluse_ccc",
						name: "x".repeat(200),
						input: {},
					},
				],
			},
		]);
		const assistantMsg = out[1] as {
			content: Array<{ toolName: string }>;
		};
		expect(assistantMsg.content[0].toolName.length).toBe(64);
	});

	it("falls back to 'unknown' when the name sanitizes to empty", () => {
		const out = toModelMessages([
			{ role: "user", content: "go" },
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "tooluse_ddd",
						// All chars get rewritten to `_`, then the toolName fallback
						// kicks in. (sanitizeToolName: "_____" stays as "_____" — only
						// the empty-result fallback engages "unknown". This test pins
						// the spec.)
						name: "",
						input: {},
					},
				],
			},
		]);
		const assistantMsg = out[1] as {
			content: Array<{ toolName: string }>;
		};
		expect(assistantMsg.content[0].toolName).toBe("unknown");
	});

	it("tool_result.toolName resolution survives name sanitization", () => {
		// The toolNameById index is keyed by sanitized id, valued by sanitized
		// name. tool_result lookups must resolve to the sanitized name so the
		// wire shape is consistent.
		const out = toModelMessages([
			{ role: "user", content: "go" },
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "functions.memory:5",
						name: "memory.store:0",
						input: {},
					},
				],
			},
			{
				role: "tool_result",
				tool_use_id: "functions.memory:5",
				content: [{ type: "text", text: "ok" }],
			},
		]);
		const toolMsg = out[2] as {
			role: string;
			content: Array<{ toolCallId: string; toolName: string }>;
		};
		expect(toolMsg.role).toBe("tool");
		expect(toolMsg.content[0].toolCallId).toBe("functions_memory_5");
		expect(toolMsg.content[0].toolName).toBe("memory_store_0");
	});
});

describe("toModelMessages — full recovery on the corrupted shape from thread 81bd5e8d", () => {
	// Reproduction of the exact ContentBlock that poisoned thread 81bd5e8d
	// on 2026-05-21: kimi-k2.5 via OpenAI-compatible Bedrock path leaked its
	// own `<|tool_call_argument_begin|>` template token into a tool_use,
	// resulting in a persisted block where both `id` and `name` are 200+ char
	// strings containing illegal characters (`.`, `:`, `<`, `|`, `>`, `{`,
	// `}`, `"`, spaces, braces). The next turn rebuilt context, sent to
	// Bedrock, and Bedrock returned 6 validation errors:
	//   - toolUse.name > 64 chars and doesn't match [a-zA-Z0-9_-]+
	//   - toolUseId > 64 chars and doesn't match [a-zA-Z0-9_.:-]+
	//   - same two for the matching toolResult.toolUseId
	// The bridge-level read-boundary sanitization is the recovery mechanism:
	// already-poisoned historical rows self-heal on next assembly without
	// manual DB surgery or task recreation.

	const corruptedId =
		'tooluse_50148b62615141b1aa5faa44d74b17d5 <|tool_call_argument_begin|> {"action": "store", "key": "_outcome:webhook-bound-org-maiden-flight-20260521T2321", "value": "STATUS: completed."}';
	const corruptedName =
		'tooluse_50148b62615141b1aa5faa44d74b17d5 <|tool_call_argument_begin|> {"action"';

	it("produces wire-legal output for the Anthropic charset", () => {
		const out = toModelMessages([
			{ role: "user", content: "ping" },
			{
				role: "tool_call",
				content: [
					{
						type: "text",
						text: "I'll log this as an outcome and complete the task.",
					},
					{
						type: "tool_use",
						id: corruptedId,
						name: corruptedName,
						input: {},
					},
				],
			},
			{
				role: "tool_result",
				tool_use_id: corruptedId,
				content: [{ type: "text", text: 'Error: unknown tool "tooluse_..."' }],
			},
		]);
		const assistantMsg = out[1] as {
			role: string;
			content: Array<{ type: string; toolCallId?: string; toolName?: string }>;
		};
		const toolMsg = out[2] as {
			role: string;
			content: Array<{ toolCallId: string; toolName: string }>;
		};

		const toolCall = assistantMsg.content.find((p) => p.type === "tool-call");
		expect(toolCall).toBeDefined();
		// Anthropic charset: ^[a-zA-Z0-9_-]+$
		expect(toolCall?.toolCallId).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(toolCall?.toolName).toMatch(/^[a-zA-Z0-9_-]+$/);
		// Length bound (the hard Bedrock cap; Anthropic accepts longer but
		// universal sanitization applies the strictest envelope)
		expect(toolCall?.toolCallId?.length).toBeLessThanOrEqual(64);
		expect(toolCall?.toolName?.length).toBeLessThanOrEqual(64);

		// Pairing: tool_result resolves to the same sanitized id as the call
		expect(toolMsg.content[0].toolCallId).toBe(toolCall?.toolCallId);
		expect(toolMsg.content[0].toolCallId.length).toBeLessThanOrEqual(64);
		expect(toolMsg.content[0].toolCallId).toMatch(/^[a-zA-Z0-9_-]+$/);
		// toolName resolution from the prior call survives the rewrite
		expect(toolMsg.content[0].toolName).toBe(toolCall?.toolName);
	});

	it("produces wire-legal output for the Bedrock charset", () => {
		// Bedrock validates toolUseId against [a-zA-Z0-9_.:-]+ and toolUse.name
		// against [a-zA-Z0-9_-]{1,64}. Our universal sanitization is the strict
		// subset of both, so the same output satisfies Bedrock.
		const out = toModelMessages([
			{ role: "user", content: "ping" },
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: corruptedId,
						name: corruptedName,
						input: {},
					},
				],
			},
		]);
		const assistantMsg = out[1] as {
			content: Array<{ toolCallId: string; toolName: string }>;
		};
		// Bedrock toolUseId: [a-zA-Z0-9_.:-]+, length <= 64
		expect(assistantMsg.content[0].toolCallId).toMatch(/^[a-zA-Z0-9_.:-]+$/);
		expect(assistantMsg.content[0].toolCallId.length).toBeLessThanOrEqual(64);
		// Bedrock toolUse.name: [a-zA-Z0-9_-]+, length <= 64
		expect(assistantMsg.content[0].toolName).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(assistantMsg.content[0].toolName.length).toBeLessThanOrEqual(64);
	});
});

describe("mapChunks — tool_use streaming-boundary semantics", () => {
	// As of the envelope-aware sanitization revamp, the streaming boundary is
	// pass-through: ids and names land in the persistence layer raw (no charset
	// rewrite, no length truncation). All envelope-conditional rewriting now
	// happens at the read boundary in toModelMessages, where the (provider,
	// model) pair is known. The streaming layer keeps a length-anomaly warn
	// log as the only operator-visible signal — that's the leak signature for
	// Kimi/Moonshot template-token corruption (200+ char ids/names).

	it("passes oversized id and name through unchanged (length-truncation deferred to read time)", async () => {
		const corruptedId = "x".repeat(200);
		const corruptedName = "memory.store:0".padEnd(200, "y");
		const stream = events(
			{ type: "tool-input-start", id: corruptedId, toolName: corruptedName },
			{ type: "tool-input-delta", id: corruptedId, delta: '{"k":1}' },
			{ type: "tool-input-end", id: corruptedId },
			{ type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } },
		);
		const chunks: StreamChunk[] = [];
		for await (const c of mapChunks(stream)) chunks.push(c);

		const start = chunks.find((c) => c.type === "tool_use_start");
		const args = chunks.find((c) => c.type === "tool_use_args");
		const end = chunks.find((c) => c.type === "tool_use_end");
		expect(start).toBeDefined();
		if (start && start.type === "tool_use_start") {
			// Pass-through: 200 chars in, 200 chars out.
			expect(start.id).toBe(corruptedId);
			expect(start.name).toBe(corruptedName);
		}
		// All three events MUST share the same id (no rewriting at this layer
		// means trivial pairing — but the invariant is still worth pinning).
		expect(args && args.type === "tool_use_args" && args.id).toBe(corruptedId);
		expect(end && end.type === "tool_use_end" && end.id).toBe(corruptedId);
	});

	it("passes an illegal-charset id through unchanged (envelope rewrite is read-time)", async () => {
		// `functions.memory:5` is the AI SDK fallback shape and Kimi's native
		// tool_call id format. The streaming layer used to rewrite this to
		// `functions_memory_5` universally; the envelope-aware revamp moves
		// that decision to toModelMessages, where the target envelope
		// determines whether it stays raw (bedrock-converse, permissive) or
		// gets rewritten (anthropic-strict).
		const upstreamId = "functions.memory:5";
		const stream = events(
			{ type: "tool-input-start", id: upstreamId, toolName: "memory" },
			{ type: "tool-input-delta", id: upstreamId, delta: '{"a":' },
			{ type: "tool-input-delta", id: upstreamId, delta: "1}" },
			{ type: "tool-input-end", id: upstreamId },
			{ type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } },
		);
		const chunks: StreamChunk[] = [];
		for await (const c of mapChunks(stream)) chunks.push(c);

		const ids = chunks
			.filter(
				(c) =>
					c.type === "tool_use_start" || c.type === "tool_use_args" || c.type === "tool_use_end",
			)
			.map((c) => (c as { id: string }).id);
		// All four events share the same raw id — no rewriting at this layer.
		expect(new Set(ids).size).toBe(1);
		expect(ids[0]).toBe("functions.memory:5");
	});

	it("does not log when an illegal-charset id passes through within the length cap", async () => {
		// Pathology signal == length-anomaly only. A 16-char `functions.memory:5`
		// id is well under the 64-char cap, so no warn fires; that's normal AI
		// SDK fallback-id behavior on the OpenAI-compatible path.
		const upstreamId = "functions.memory:5";
		const upstreamName = "memory";
		const stream = events(
			{ type: "tool-input-start", id: upstreamId, toolName: upstreamName },
			{ type: "tool-input-end", id: upstreamId },
			{ type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } },
		);
		const chunks: StreamChunk[] = [];
		for await (const c of mapChunks(stream)) chunks.push(c);
		const start = chunks.find((c) => c.type === "tool_use_start");
		expect(start).toBeDefined();
		if (start && start.type === "tool_use_start") {
			expect(start.id).toBe(upstreamId);
			expect(start.name).toBe(upstreamName);
			expect(start.id.length).toBeLessThanOrEqual(MAX_TOOL_USE_ID_LENGTH);
			expect(start.name.length).toBeLessThanOrEqual(MAX_TOOL_USE_ID_LENGTH);
		}
	});
});

describe("toModelMessages — tool_result with non-text content", () => {
	// MCP tools (vision-enabled servers, image-fetching tools, etc.) routinely
	// emit text + image content blocks in their tool_result. Pre-fix, the
	// tool_result handler stripped non-text blocks, dropping every image on
	// the floor before the model could see it. The fix routes these through
	// `output: {type:"content", value:[...]}` per LanguageModelV2ToolResultOutput.

	it("preserves text-only tool_result with the simple {type:'text'} shape (back-compat)", () => {
		const out = toModelMessages([
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "c1", name: "t", input: {} }],
			},
			{
				role: "tool_result",
				tool_use_id: "c1",
				content: [
					{ type: "text", text: "part one " },
					{ type: "text", text: "part two" },
				],
			},
		]);
		const tool = out[out.length - 1] as { content: Array<Record<string, unknown>> };
		expect(tool.content[0]).toMatchObject({
			type: "tool-result",
			toolCallId: "c1",
			output: { type: "text", value: "part one part two" },
		});
	});

	it("preserves base64 image blocks in tool_result via the {type:'content'} shape", () => {
		const data = Buffer.from("png-bytes").toString("base64");
		const out = toModelMessages([
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "c1", name: "screenshot", input: {} }],
			},
			{
				role: "tool_result",
				tool_use_id: "c1",
				content: [
					{ type: "text", text: "screenshot:" },
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data },
					},
				],
			},
		]);
		const tool = out[out.length - 1] as { content: Array<Record<string, unknown>> };
		const output = (tool.content[0] as { output: Record<string, unknown> }).output as {
			type: string;
			value: Array<Record<string, unknown>>;
		};
		expect(output.type).toBe("content");
		expect(output.value).toEqual([
			{ type: "text", text: "screenshot:" },
			{ type: "media", data, mediaType: "image/png" },
		]);
	});

	it("resolves file_ref images in tool_result via resolveFileRef", () => {
		const data = Buffer.from("jpg-bytes").toString("base64");
		const out = toModelMessages(
			[
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "c1", name: "fetch_image", input: {} }],
				},
				{
					role: "tool_result",
					tool_use_id: "c1",
					content: [
						{ type: "text", text: "got it" },
						{
							type: "image",
							source: { type: "file_ref", file_id: "f1", media_type: "image/jpeg" },
						},
					],
				},
			],
			{
				resolveFileRef: (id) => (id === "f1" ? data : null),
			},
		);
		const tool = out[out.length - 1] as { content: Array<Record<string, unknown>> };
		const output = (tool.content[0] as { output: Record<string, unknown> }).output as {
			type: string;
			value: Array<Record<string, unknown>>;
		};
		expect(output.type).toBe("content");
		expect(output.value).toEqual([
			{ type: "text", text: "got it" },
			{ type: "media", data, mediaType: "image/jpeg" },
		]);
	});

	it("emits placeholder text for unresolvable file_ref images in tool_result (no silent drop)", () => {
		const out = toModelMessages([
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "c1", name: "fetch_image", input: {} }],
			},
			{
				role: "tool_result",
				tool_use_id: "c1",
				content: [
					{ type: "text", text: "got it" },
					{
						type: "image",
						source: { type: "file_ref", file_id: "missing" },
					},
				],
			},
		]);
		const tool = out[out.length - 1] as { content: Array<Record<string, unknown>> };
		const output = (tool.content[0] as { output: Record<string, unknown> }).output as {
			type: string;
			value: Array<Record<string, unknown>>;
		};
		expect(output.type).toBe("content");
		expect(output.value).toEqual([
			{ type: "text", text: "got it" },
			{ type: "text", text: "[Image unavailable: file_id=missing]" },
		]);
	});

	it("preserves DB-serialized tool_result content with mixed blocks (string → JSON parse path)", () => {
		const data = Buffer.from("png-bytes").toString("base64");
		const blocks = [
			{ type: "text", text: "screenshot:" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data } },
		];
		const out = toModelMessages([
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "c1", name: "screenshot", input: {} }],
			},
			{
				role: "tool_result",
				tool_use_id: "c1",
				content: JSON.stringify(blocks),
			},
		]);
		const tool = out[out.length - 1] as { content: Array<Record<string, unknown>> };
		const output = (tool.content[0] as { output: Record<string, unknown> }).output as {
			type: string;
			value: Array<Record<string, unknown>>;
		};
		expect(output.type).toBe("content");
		expect(output.value).toEqual([
			{ type: "text", text: "screenshot:" },
			{ type: "media", data, mediaType: "image/png" },
		]);
	});

	it("preserves base64 document blocks in tool_result via {type:'content'} shape", () => {
		// Mirror the MCP-resource path: a tool returns a binary PDF that has
		// already been resolved to a base64 inline document by the time the
		// bridge sees it.
		const data = Buffer.from("%PDF-fake").toString("base64");
		const out = toModelMessages([
			{ role: "user", content: "fetch the report" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "c1", name: "fetch", input: {} }],
			},
			{
				role: "tool_result",
				tool_use_id: "c1",
				content: [
					{ type: "text", text: "here is the report:" },
					{
						type: "document",
						source: { type: "base64", media_type: "application/pdf", data },
					},
				],
			},
		]);
		const tool = out[out.length - 1] as { content: Array<Record<string, unknown>> };
		const output = (tool.content[0] as { output: Record<string, unknown> }).output as {
			type: string;
			value: Array<Record<string, unknown>>;
		};
		expect(output.type).toBe("content");
		expect(output.value).toEqual([
			{ type: "text", text: "here is the report:" },
			{ type: "media", data, mediaType: "application/pdf" },
		]);
	});

	it("resolves file_ref documents in tool_result via resolveFileRef callback", () => {
		const data = Buffer.from("csv,bytes").toString("base64");
		const out = toModelMessages(
			[
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "c1", name: "fetch", input: {} }],
				},
				{
					role: "tool_result",
					tool_use_id: "c1",
					content: [
						{ type: "text", text: "data:" },
						{
							type: "document",
							source: { type: "file_ref", file_id: "doc-77", media_type: "text/csv" },
						},
					],
				},
			],
			{ resolveFileRef: (id) => (id === "doc-77" ? data : null) },
		);
		const tool = out[out.length - 1] as { content: Array<Record<string, unknown>> };
		const output = (tool.content[0] as { output: Record<string, unknown> }).output as {
			type: string;
			value: Array<Record<string, unknown>>;
		};
		expect(output.type).toBe("content");
		expect(output.value).toEqual([
			{ type: "text", text: "data:" },
			{ type: "media", data, mediaType: "text/csv" },
		]);
	});

	it("falls back to text_representation when a tool_result document file_ref can't be resolved", () => {
		const out = toModelMessages(
			[
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "c1", name: "fetch", input: {} }],
				},
				{
					role: "tool_result",
					tool_use_id: "c1",
					content: [
						{
							type: "document",
							source: { type: "file_ref", file_id: "vanished" },
							text_representation: "extracted summary",
						},
					],
				},
			],
			{ resolveFileRef: () => null },
		);
		const tool = out[out.length - 1] as { content: Array<Record<string, unknown>> };
		const output = (tool.content[0] as { output: Record<string, unknown> }).output as {
			type: string;
			value: Array<Record<string, unknown>>;
		};
		expect(output.type).toBe("content");
		expect(output.value).toEqual([{ type: "text", text: "extracted summary" }]);
	});

	it("emits a placeholder when a tool_result document file_ref has neither resolver bytes nor text_representation", () => {
		const out = toModelMessages([
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "c1", name: "fetch", input: {} }],
			},
			{
				role: "tool_result",
				tool_use_id: "c1",
				content: [
					{
						type: "document",
						source: { type: "file_ref", file_id: "ghost" },
						filename: "missing.pdf",
					},
				],
			},
		]);
		const tool = out[out.length - 1] as { content: Array<Record<string, unknown>> };
		const output = (tool.content[0] as { output: Record<string, unknown> }).output as {
			type: string;
			value: Array<Record<string, unknown>>;
		};
		expect(output.type).toBe("content");
		expect(output.value).toEqual([
			{
				type: "text",
				text: '[Document unavailable: file_id=ghost filename="missing.pdf"]',
			},
		]);
	});
});

describe("toModelMessages — cache marker", () => {
	it("attaches bedrock cachePoint to previous message", () => {
		const out = toModelMessages(
			[
				{ role: "user", content: "hi" },
				{ role: "cache", content: "" },
			],
			{ cacheProvider: "bedrock" },
		);
		expect(out).toHaveLength(1);
		expect(out[0].providerOptions).toEqual({
			bedrock: { cachePoint: { type: "default" } },
		});
	});

	it("attaches anthropic cacheControl to previous message", () => {
		const out = toModelMessages(
			[
				{ role: "user", content: "hi" },
				{ role: "cache", content: "" },
			],
			{ cacheProvider: "anthropic" },
		);
		expect(out[0].providerOptions).toEqual({
			anthropic: { cacheControl: { type: "ephemeral" } },
		});
	});

	it("drops cache marker silently when provider is null", () => {
		const out = toModelMessages(
			[
				{ role: "user", content: "hi" },
				{ role: "cache", content: "" },
			],
			{ cacheProvider: null },
		);
		expect(out).toHaveLength(1);
		expect(out[0].providerOptions).toBeUndefined();
	});

	it("drops leading cache marker with no prior message", () => {
		const out = toModelMessages(
			[
				{ role: "cache", content: "" },
				{ role: "user", content: "hi" },
			],
			{ cacheProvider: "bedrock" },
		);
		expect(out).toHaveLength(1);
		expect(out[0].providerOptions).toBeUndefined();
	});
});

describe("toToolSet", () => {
	it("returns undefined when no tools", () => {
		expect(toToolSet()).toBeUndefined();
		expect(toToolSet([])).toBeUndefined();
	});

	it("builds a ToolSet keyed by function name", () => {
		const tools = toToolSet([
			{
				type: "function",
				function: {
					name: "get_weather",
					description: "Get weather for a city",
					parameters: {
						type: "object",
						properties: { city: { type: "string" } },
						required: ["city"],
					},
				},
			},
		]);
		expect(tools).toBeDefined();
		if (!tools) throw new Error("tools undefined");
		expect(Object.keys(tools)).toEqual(["get_weather"]);
		expect(tools.get_weather.description).toBe("Get weather for a city");
	});
});

describe("mapChunks — text and reasoning", () => {
	it("emits text chunks for text-delta events", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "text-delta", id: "t1", text: "hello " },
					{ type: "text-delta", id: "t1", text: "world" },
					{ type: "finish", finishReason: "stop", totalUsage: {} },
				),
			),
		);
		expect(out.filter((c) => c.type === "text")).toEqual([
			{ type: "text", content: "hello " },
			{ type: "text", content: "world" },
		]);
	});

	it("drops empty text-delta events", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "text-delta", id: "t1", text: "" },
					{ type: "finish", finishReason: "stop", totalUsage: {} },
				),
			),
		);
		expect(out.filter((c) => c.type === "text")).toHaveLength(0);
	});

	it("emits thinking chunks for reasoning-delta text", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "reasoning-delta", id: "r1", text: "analyzing..." },
					{ type: "finish", finishReason: "stop", totalUsage: {} },
				),
			),
		);
		expect(out.filter((c) => c.type === "thinking")).toEqual([
			{ type: "thinking", content: "analyzing..." },
		]);
	});

	it("emits signature on reasoning-delta with empty text + providerMetadata.bedrock.signature", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "reasoning-delta", id: "r1", text: "thinking" },
					{
						type: "reasoning-delta",
						id: "r1",
						text: "",
						providerMetadata: { bedrock: { signature: "SIG-ABC" } },
					},
					{ type: "finish", finishReason: "stop", totalUsage: {} },
				),
			),
		);
		const thinking = out.filter((c) => c.type === "thinking");
		expect(thinking).toEqual([
			{ type: "thinking", content: "thinking" },
			{ type: "thinking", content: "", signature: "SIG-ABC" },
		]);
	});

	it("emits anthropic signature from providerMetadata.anthropic.signature", async () => {
		const out = await collect(
			mapChunks(
				events(
					{
						type: "reasoning-delta",
						id: "r1",
						text: "",
						providerMetadata: { anthropic: { signature: "A-SIG" } },
					},
					{ type: "finish", finishReason: "stop", totalUsage: {} },
				),
			),
		);
		expect(out.filter((c) => c.type === "thinking")).toEqual([
			{ type: "thinking", content: "", signature: "A-SIG" },
		]);
	});

	it("emits redacted reasoning as a dedicated redacted_data field on the thinking chunk", async () => {
		const out = await collect(
			mapChunks(
				events(
					{
						type: "reasoning-delta",
						id: "r1",
						text: "",
						providerMetadata: { bedrock: { redactedData: "BLOB" } },
					},
					{ type: "finish", finishReason: "stop", totalUsage: {} },
				),
			),
		);
		expect(out.filter((c) => c.type === "thinking")).toEqual([
			{ type: "thinking", content: "", redacted_data: "BLOB" },
		]);
	});

	it("emits signature and redacted_data as separate chunks when both arrive in one delta", async () => {
		const out = await collect(
			mapChunks(
				events(
					{
						type: "reasoning-delta",
						id: "r1",
						text: "",
						providerMetadata: {
							bedrock: { signature: "SIG", redactedData: "BLOB" },
						},
					},
					{ type: "finish", finishReason: "stop", totalUsage: {} },
				),
			),
		);
		expect(out.filter((c) => c.type === "thinking")).toEqual([
			{ type: "thinking", content: "", signature: "SIG" },
			{ type: "thinking", content: "", redacted_data: "BLOB" },
		]);
	});
});

describe("mapChunks — tool calls", () => {
	it("emits start/args/end sequence for tool-input events", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "tool-input-start", id: "t1", toolName: "search" },
					{ type: "tool-input-delta", id: "t1", delta: '{"q":' },
					{ type: "tool-input-delta", id: "t1", delta: '"x"}' },
					{ type: "tool-input-end", id: "t1" },
					{ type: "finish", finishReason: "tool-calls", totalUsage: {} },
				),
			),
		);
		expect(out.slice(0, 4)).toEqual([
			{ type: "tool_use_start", id: "t1", name: "search" },
			{ type: "tool_use_args", id: "t1", partial_json: '{"q":' },
			{ type: "tool_use_args", id: "t1", partial_json: '"x"}' },
			{ type: "tool_use_end", id: "t1" },
		]);
	});
});

describe("mapChunks — finish / usage", () => {
	it("extracts cache-write tokens from finish-step providerMetadata (bedrock)", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "text-delta", id: "t1", text: "answer" },
					{
						type: "finish-step",
						providerMetadata: {
							bedrock: { usage: { cacheWriteInputTokens: 1024 } },
						},
					},
					{
						type: "finish",
						finishReason: "stop",
						totalUsage: {
							inputTokens: 500,
							outputTokens: 50,
							cachedInputTokens: 100,
						},
					},
				),
				{ usageProvider: "bedrock" },
			),
		);
		const done = out.find((c) => c.type === "done") as (StreamChunk & { type: "done" }) | undefined;
		expect(done?.usage).toEqual({
			input_tokens: 500,
			output_tokens: 50,
			cache_write_tokens: 1024,
			cache_read_tokens: 100,
			estimated: false,
		});
	});

	it("extracts cache-write tokens from anthropic providerMetadata", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "text-delta", id: "t1", text: "ok" },
					{
						type: "finish-step",
						providerMetadata: {
							anthropic: { cacheCreationInputTokens: 500 },
						},
					},
					{
						type: "finish",
						finishReason: "stop",
						totalUsage: { inputTokens: 10, outputTokens: 2 },
					},
				),
				{ usageProvider: "anthropic" },
			),
		);
		const done = out.find((c) => c.type === "done") as (StreamChunk & { type: "done" }) | undefined;
		expect(done?.usage.cache_write_tokens).toBe(500);
	});

	it("reports null cache tokens when provider metadata absent", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "text-delta", id: "t1", text: "ok" },
					{
						type: "finish",
						finishReason: "stop",
						totalUsage: { inputTokens: 10, outputTokens: 2 },
					},
				),
			),
		);
		const done = out.find((c) => c.type === "done") as (StreamChunk & { type: "done" }) | undefined;
		expect(done?.usage.cache_write_tokens).toBeNull();
		expect(done?.usage.cache_read_tokens).toBeNull();
		expect(done?.usage.estimated).toBe(false);
	});

	it("falls back to char-based estimation when zero-usage + output text", async () => {
		const messages: LLMMessage[] = [{ role: "user", content: "this is a prompt of some length" }];
		const out = await collect(
			mapChunks(
				events(
					{ type: "text-delta", id: "t1", text: "reply of some length" },
					{
						type: "finish",
						finishReason: "stop",
						totalUsage: { inputTokens: 0, outputTokens: 0 },
					},
				),
				{ estimateInputFromMessages: messages },
			),
		);
		const done = out.find((c) => c.type === "done") as (StreamChunk & { type: "done" }) | undefined;
		expect(done?.usage.estimated).toBe(true);
		expect(done?.usage.input_tokens).toBeGreaterThan(0);
		expect(done?.usage.output_tokens).toBeGreaterThan(0);
	});

	it("does not estimate when there was no output at all", async () => {
		// Truly silent response — no text, no thinking, no tool calls. Without
		// any signal that work happened, we don't phantom-bill input tokens.
		const out = await collect(
			mapChunks(
				events({
					type: "finish",
					finishReason: "stop",
					totalUsage: { inputTokens: 0, outputTokens: 0 },
				}),
				{ estimateInputFromMessages: [{ role: "user", content: "x" }] },
			),
		);
		const done = out.find((c) => c.type === "done") as (StreamChunk & { type: "done" }) | undefined;
		expect(done?.usage.estimated).toBe(false);
	});

	// bound_issue:turns-table:observability-gap — non-text responses (tool
	// calls, thinking-only) were being recorded as tokens_in=0/tokens_out=0
	// because the zero-usage fallback only fired when `outputText.length > 0`.
	// haiku cron turns (a single retrieve_task call, no text) and qwen3.6
	// threads that produced only thinking+tool_call output were the canaries.
	it("estimates usage when only a tool call was emitted (no text output)", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "tool-input-start", id: "t1", toolName: "retrieve_task" },
					{ type: "tool-input-delta", id: "t1", delta: "{}" },
					{ type: "tool-input-end", id: "t1" },
					{
						type: "finish",
						finishReason: "tool-calls",
						totalUsage: { inputTokens: 0, outputTokens: 0 },
					},
				),
				{ estimateInputFromMessages: [{ role: "user", content: "please retrieve the task" }] },
			),
		);
		const done = out.find((c) => c.type === "done") as (StreamChunk & { type: "done" }) | undefined;
		expect(done?.usage.estimated).toBe(true);
		expect(done?.usage.input_tokens).toBeGreaterThan(0);
		expect(done?.usage.output_tokens).toBeGreaterThan(0);
	});

	it("estimates usage when only thinking was emitted (no text output)", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "reasoning-delta", id: "r1", text: "let me think about this for a moment" },
					{
						type: "finish",
						finishReason: "stop",
						totalUsage: { inputTokens: 0, outputTokens: 0 },
					},
				),
				{ estimateInputFromMessages: [{ role: "user", content: "think carefully" }] },
			),
		);
		const done = out.find((c) => c.type === "done") as (StreamChunk & { type: "done" }) | undefined;
		expect(done?.usage.estimated).toBe(true);
		expect(done?.usage.input_tokens).toBeGreaterThan(0);
		expect(done?.usage.output_tokens).toBeGreaterThan(0);
	});

	it("throws an LLMError when the SDK emits a fullStream error event", async () => {
		// Background: AI SDK converts initial request failures (e.g. Bedrock
		// 403 AccessDeniedException on converse-stream) into
		// `{ type: "error", error }` chunks on `fullStream` — it does NOT
		// reject the iterator. Before this regression test, mapChunks
		// forwarded the chunk as a `{type:"error"}` StreamChunk, which
		// agent-loop silently dropped: the turn appeared to succeed with
		// empty output, no alert was emitted, and scheduled tasks quietly
		// hung forever. mapChunks now throws so the driver's try/catch
		// wraps it via mapError and the agent-loop alert path fires.
		const iter = mapChunks(
			events(
				{ type: "error", error: new Error("boom") },
				{ type: "finish", finishReason: "error", totalUsage: {} },
			),
		);
		await expect(collect(iter)).rejects.toThrow("boom");
	});

	it("throws an LLMError that carries the original provider message verbatim", async () => {
		const iter = mapChunks(
			events({
				type: "error",
				error: new Error(
					"You invoked an unsupported model or your request did not allow prompt caching.",
				),
			}),
		);
		await expect(collect(iter)).rejects.toThrow(/unsupported model/);
	});

	it("throws an LLMError even if the error is a plain object with no message", async () => {
		const iter = mapChunks(events({ type: "error", error: { statusCode: 403 } }));
		// Should still throw, not silently resolve
		let threw = false;
		try {
			await collect(iter);
		} catch (err) {
			threw = true;
			expect(err).toBeInstanceOf(LLMError);
		}
		expect(threw).toBe(true);
	});

	it("ignores events we don't model (start, text-start, reasoning-end, etc.)", async () => {
		const out = await collect(
			mapChunks(
				events(
					{ type: "start" },
					{ type: "start-step" },
					{ type: "text-start", id: "t1" },
					{ type: "text-delta", id: "t1", text: "hello" },
					{ type: "text-end", id: "t1" },
					{ type: "reasoning-start", id: "r1" },
					{ type: "reasoning-end", id: "r1" },
					{ type: "response-metadata" },
					{ type: "finish", finishReason: "stop", totalUsage: {} },
				),
			),
		);
		// Should only see: 1 text, 1 done.
		expect(out.filter((c) => c.type === "text")).toHaveLength(1);
		expect(out.filter((c) => c.type === "done")).toHaveLength(1);
	});
});

describe("mapError", () => {
	it("passes LLMError through unchanged", () => {
		const orig = new LLMError("original", "bedrock", 500);
		const out = mapError(orig, "bedrock");
		expect(out).toBe(orig);
	});

	it("extracts statusCode from APICallError-like shape", () => {
		const err = Object.assign(new Error("bad"), {
			statusCode: 429,
			responseHeaders: {},
		});
		const out = mapError(err, "openai");
		expect(out.provider).toBe("openai");
		expect(out.statusCode).toBe(429);
	});

	it("extracts statusCode from bedrock $metadata.httpStatusCode", () => {
		const err = Object.assign(new Error("throttled"), {
			$metadata: { httpStatusCode: 503 },
		});
		const out = mapError(err, "bedrock");
		expect(out.statusCode).toBe(503);
	});

	it("parses retry-after header as seconds", () => {
		const err = Object.assign(new Error("rate"), {
			statusCode: 429,
			responseHeaders: { "retry-after": "12" },
		});
		const out = mapError(err, "openai");
		expect(out.retryAfterMs).toBe(12_000);
	});

	it("parses Title-Case Retry-After header", () => {
		const err = Object.assign(new Error("rate"), {
			statusCode: 429,
			responseHeaders: { "Retry-After": "5" },
		});
		const out = mapError(err, "openai");
		expect(out.retryAfterMs).toBe(5_000);
	});

	it("handles non-Error values", () => {
		const out = mapError("string error", "bedrock");
		expect(out).toBeInstanceOf(LLMError);
		expect(out.provider).toBe("bedrock");
		expect(out.originalError).toBeInstanceOf(Error);
	});
});

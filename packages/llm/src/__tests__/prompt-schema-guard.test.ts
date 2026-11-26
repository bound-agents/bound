import { describe, expect, it } from "bun:test";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { toModelMessages } from "../bridge";
import type { LLMMessage } from "../types";

type Warn = { msg: string; ctx: unknown };
function recorder() {
	const warnings: Warn[] = [];
	return {
		warnings,
		logger: { warn: (msg: string, ctx?: unknown) => warnings.push({ msg, ctx }) },
	};
}

function mockModel() {
	return new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [{ type: "text", text: "ok" }],
			finishReason: { unified: "stop", raw: "stop" },
			usage: {
				inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
				outputTokens: { total: 1, text: 1, reasoning: 0 },
			},
		}),
	});
}

// A persisted history whose tool_result carries an item outside the bridge's
// vocabulary. normalizeBlocks + the defensive JSON branch handle unknown
// ContentBlocks, so the drifted item is injected one layer down: an ai@6
// `{type:"media"}` output item, exactly the #273 shape.
function legacyMediaHistory(): LLMMessage[] {
	return [
		{ role: "user", content: "go" },
		{
			role: "tool_call",
			content: [{ type: "tool_use", id: "c1", name: "screenshot", input: {} }],
		},
		{
			role: "tool_result",
			tool_use_id: "c1",
			content: [
				{ type: "text", text: "left" },
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
				{ type: "text", text: "right" },
			],
		},
		{ role: "user", content: "and?" },
	];
}

/**
 * Build the legacy-shaped prompt: run the bridge, then swap the file item for
 * the ai@6 `media` item the way pre-34d4d685 persisted content would surface,
 * and run the guard over the result.
 */
async function legacyPrompt(logger: { warn: (m: string, c?: unknown) => void }) {
	const { guardPromptSchema } = await import("../bridge/messages");
	const messages = toModelMessages(legacyMediaHistory(), { logger });
	const tool = messages.find((m) => m.role === "tool") as {
		content: Array<{ output: { value: unknown[] } }>;
	};
	tool.content[0].output.value[1] = { type: "media", data: "aGk=", mediaType: "image/png" };
	return guardPromptSchema(messages, logger);
}

describe("toModelMessages — prompt schema guard", () => {
	it("replaces a legacy {type:'media'} tool-result item; doGenerate is reached; one warning", async () => {
		const { warnings, logger } = recorder();
		const messages = await legacyPrompt(logger);

		const tool = messages.find((m) => m.role === "tool") as {
			content: Array<{ toolCallId: string; output: { type: string; value: unknown[] } }>;
		};
		expect(tool.content[0].toolCallId).toBe("c1");
		expect(tool.content[0].output.value).toEqual([
			{ type: "text", text: "left" },
			{
				type: "text",
				text: "[Unsupported media content omitted: it does not match the model prompt schema]",
			},
			{ type: "text", text: "right" },
		]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].ctx).toEqual({ messageIndex: 2, role: "tool", itemType: "media" });
		expect(JSON.stringify(warnings)).not.toContain("aGk=");

		const model = mockModel();
		const result = await generateText({ model, messages });
		expect(result.text).toBe("ok");
		expect(model.doGenerateCalls).toHaveLength(1);
	});

	it("same history twice gives byte-identical prompts, both accepted", async () => {
		const a = await legacyPrompt(recorder().logger);
		const b = await legacyPrompt(recorder().logger);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		const model = mockModel();
		await generateText({ model, messages: a });
		await generateText({ model, messages: b });
		expect(model.doGenerateCalls).toHaveLength(2);
		expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toBe(
			JSON.stringify(model.doGenerateCalls[1].prompt),
		);
	});

	it("a valid prompt comes back unchanged with no warnings", async () => {
		const { guardPromptSchema } = await import("../bridge/messages");
		const { warnings, logger } = recorder();
		const raw = toModelMessages(legacyMediaHistory(), { logger: { warn: () => {} } });
		const before = JSON.stringify(raw);
		const guarded = guardPromptSchema(raw, logger);
		expect(guarded).toBe(raw);
		expect(JSON.stringify(guarded)).toBe(before);
		expect(warnings).toHaveLength(0);
	});

	it("an unknown user content part becomes a placeholder; the request validates", async () => {
		const { guardPromptSchema } = await import("../bridge/messages");
		const { warnings, logger } = recorder();
		const messages = guardPromptSchema(
			[
				{
					role: "user",
					content: [{ type: "text", text: "keep" }, { type: "hologram", data: "x" } as never],
				},
			],
			logger,
		);
		expect(messages[0]).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "keep" },
				{
					type: "text",
					text: "[Unsupported hologram content omitted: it does not match the model prompt schema]",
				},
			],
		});
		expect(warnings).toHaveLength(1);
		const model = mockModel();
		await generateText({ model, messages });
		expect(model.doGenerateCalls).toHaveLength(1);
	});

	it("a malformed tool-result output keeps its call id so pairing survives", async () => {
		const { guardPromptSchema } = await import("../bridge/messages");
		const { warnings, logger } = recorder();
		const messages = guardPromptSchema(
			[
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [{ type: "tool-call", toolCallId: "c9", toolName: "t", input: {} }],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "c9",
							toolName: "t",
							output: { type: "blob" },
						} as never,
					],
				},
			],
			logger,
		);
		expect(messages[2]).toEqual({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "c9",
					toolName: "t",
					output: {
						type: "text",
						value: "[Unsupported blob content omitted: it does not match the model prompt schema]",
					},
				},
			],
		});
		expect(warnings).toHaveLength(1);
		const model = mockModel();
		await generateText({ model, messages });
		expect(model.doGenerateCalls).toHaveLength(1);
	});
});

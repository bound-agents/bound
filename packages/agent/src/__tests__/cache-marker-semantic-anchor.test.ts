import { describe, expect, it } from "bun:test";
import type { BackendCapabilities, LLMMessage } from "@bound/llm";
import { coldPathPlaceCacheMarker } from "../cache-marker";

const CAPS: BackendCapabilities = {
	streaming: true,
	tool_use: true,
	system_prompt: true,
	prompt_caching: true,
	vision: true,
	extended_thinking: false,
	max_context: 200000,
};

function charEstimate(message: LLMMessage): number {
	if (typeof message.content === "string") return message.content.length;
	return message.content.reduce(
		(sum, block) =>
			sum + (block.type === "text" ? block.text.length : JSON.stringify(block).length),
		0,
	);
}

function message(role: LLMMessage["role"], content: string): LLMMessage {
	return { role, content };
}

function markerPosition(messages: LLMMessage[]): number | null {
	let tokens = 0;
	for (const entry of messages) {
		if (entry.role === "cache") return tokens;
		if (entry.role !== "developer") tokens += charEstimate(entry);
	}
	return null;
}

function place(messages: LLMMessage[]) {
	return coldPathPlaceCacheMarker(
		messages,
		{ bucketTokens: 0, estimateTokens: charEstimate },
		CAPS,
	);
}

describe("semantic-anchor cache placement", () => {
	it("keeps a cache boundary stable through a large same-turn tool result", () => {
		const history = [message("user", "previous user"), message("assistant", "previous reply")];
		const before = [...history, message("user", "current user"), message("developer", "volatile")];
		const first = place(before);

		const after = [
			...history,
			message("user", "current user"),
			message("tool_call", "tool call"),
			message("tool_result", "x".repeat(30_000)),
			message("developer", "volatile"),
		];
		const second = place(after);

		expect(first).toMatchObject({ placed: true, index: 2, positionTokens: 27 });
		expect(second).toMatchObject({ placed: true, index: 2, positionTokens: 27 });
		expect(markerPosition(before)).toBe(first.positionTokens);
		expect(markerPosition(after)).toBe(second.positionTokens);
		expect(second.positionTokens).toBe(first.positionTokens);
	});

	it("advances only when a new user turn arrives", () => {
		const currentTurn = [
			message("user", "u1"),
			message("assistant", "a1"),
			message("user", "u2"),
			message("developer", "volatile"),
		];
		const currentPlacement = place(currentTurn);

		const nextTurn = [
			message("user", "u1"),
			message("assistant", "a1"),
			message("user", "u2"),
			message("assistant", "a2"),
			message("user", "u3"),
			message("developer", "volatile"),
		];
		const nextPlacement = place(nextTurn);

		expect(currentPlacement).toMatchObject({ placed: true, index: 2, positionTokens: 4 });
		expect(nextPlacement).toMatchObject({ placed: true, index: 4, positionTokens: 8 });
		expect(markerPosition(currentTurn)).toBe(currentPlacement.positionTokens);
		expect(markerPosition(nextTurn)).toBe(nextPlacement.positionTokens);
		expect(nextPlacement.positionTokens).toBeGreaterThan(currentPlacement.positionTokens ?? -1);
	});

	it("recovers a leading developer summary by anchoring after the first user", () => {
		const messages = [
			message("developer", "summary"),
			message("user", "first user"),
			message("tool_call", "call"),
			message("developer", "volatile"),
		];

		const placement = place(messages);
		expect(placement).toMatchObject({ placed: true, index: 2, positionTokens: 10 });
		expect(markerPosition(messages)).toBe(placement.positionTokens);
		expect(messages[placement.index]?.role).toBe("cache");
		expect(messages[placement.index - 1]?.role).toBe("user");
	});
});

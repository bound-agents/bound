/** Bridge-aware placement contracts and generated role-shape coverage. */
import { describe, expect, it } from "bun:test";
import type { BackendCapabilities, LLMMessage } from "@bound/llm";
import fc from "fast-check";
import { maybePlaceCacheMarker } from "../cache-marker";

const CAPS: BackendCapabilities = {
	streaming: true,
	tool_use: true,
	system_prompt: true,
	prompt_caching: true,
	vision: true,
	extended_thinking: false,
	max_context: 200000,
};

const nonDeveloperRoleArb = fc.constantFrom<LLMMessage["role"]>(
	"user",
	"assistant",
	"tool_call",
	"tool_result",
	"cache",
);
const markerKindArb = fc.constantFrom<"fixed" | "rolling">("fixed", "rolling");

function originals(roles: LLMMessage["role"][]): LLMMessage[] {
	return roles.map((role, index) => ({ role, content: `original-${index}` }));
}

function remainingAfterInsertedMarker(messages: LLMMessage[], index: number): LLMMessage[] {
	return [...messages.slice(0, index), ...messages.slice(index + 1)];
}

describe("maybePlaceCacheMarker — bridge-aware placement", () => {
	it("reports too-short when a trailing developer follows the only user", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "u1" },
			{ role: "developer", content: "vol_tail" },
		];
		const placement = maybePlaceCacheMarker(messages, "fixed", CAPS);
		expect(placement).toMatchObject({ placed: false, reason: "too-short" });
		expect(messages).toEqual([
			{ role: "user", content: "u1" },
			{ role: "developer", content: "vol_tail" },
		]);
	});

	it("places rolling markers with the same bridge-aware rule", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "u1" },
			{ role: "assistant", content: "a1" },
			{ role: "cache", content: "existing" },
			{ role: "user", content: "u2" },
			{ role: "developer", content: "fresh_vol_tail" },
		];
		const placement = maybePlaceCacheMarker(messages, "rolling", CAPS);
		expect(placement).toMatchObject({ placed: true, index: 3, variant: "rolling" });
		expect(messages[3]).toEqual({ role: "cache", content: "" });
		expect(messages[4]).toEqual({ role: "user", content: "u2" });
	});
});

describe("maybePlaceCacheMarker — bridge-aware properties", () => {
	it("inserts at the exact bridge-safe index and preserves identifiable originals", () => {
		const prefixArb = fc.array(nonDeveloperRoleArb, { minLength: 1, maxLength: 10 });
		const developerRunArb = fc.array(fc.constant("developer" as const), {
			minLength: 1,
			maxLength: 5,
		});

		fc.assert(
			fc.property(prefixArb, developerRunArb, markerKindArb, (prefix, developers, kind) => {
				const original = originals([...prefix, ...developers]);
				const messages = structuredClone(original);
				const placement = maybePlaceCacheMarker(messages, kind, CAPS);
				const runStart = prefix.length;
				const expectedIndex = prefix.at(-1) === "user" ? runStart - 1 : runStart;

				if (expectedIndex === 0) {
					return (
						placement.placed === false &&
						placement.reason === "too-short" &&
						JSON.stringify(messages) === JSON.stringify(original)
					);
				}
				if (!placement.placed) return false;
				return (
					placement.index === expectedIndex &&
					placement.variant === kind &&
					messages[placement.index].role === "cache" &&
					messages[placement.index].content === "" &&
					JSON.stringify(remainingAfterInsertedMarker(messages, placement.index)) ===
						JSON.stringify(original)
				);
			}),
			{ numRuns: 200 },
		);
	});

	it("is deterministic for every role prefix, developer run, and marker kind", () => {
		fc.assert(
			fc.property(
				fc.array(nonDeveloperRoleArb, { minLength: 1, maxLength: 10 }),
				fc.array(fc.constant("developer" as const), { minLength: 0, maxLength: 5 }),
				markerKindArb,
				(prefix, developers, kind) => {
					const roles = [...prefix, ...developers];
					const left = originals(roles);
					const right = originals(roles);
					const a = maybePlaceCacheMarker(left, kind, CAPS);
					const b = maybePlaceCacheMarker(right, kind, CAPS);
					return (
						JSON.stringify(a) === JSON.stringify(b) &&
						JSON.stringify(left) === JSON.stringify(right)
					);
				},
			),
			{ numRuns: 100 },
		);
	});
});

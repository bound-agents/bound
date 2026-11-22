import { describe, expect, it } from "bun:test";
import type { ChatParams, StreamChunk } from "../types";
import {
	creditTokenOf,
	resolveFallbackTargetFromParams,
	serverToolsRanInChunks,
} from "./credit-redemption-config";

/**
 * Tests for the shared driver glue that turns a turn's resolved fallback chain
 * (`ChatParams.fallback_models`, R-RT18) into the executor's `resolveTarget`
 * input, and detects whether billed server tools ran in a refused attempt. Each
 * credit-capable driver reuses these so the per-driver wiring is only the
 * provider-specific `runStep` body builder.
 */

const baseParams: ChatParams = { model: "primary", messages: [] };

describe("resolveFallbackTargetFromParams", () => {
	it("returns the first fallback target co-located on the executing endpoint", () => {
		const t = resolveFallbackTargetFromParams(
			{ ...baseParams, fallback_models: ["fallback-a", "fallback-b"] },
			"ep-A",
		);
		expect(t).toEqual({ targetModel: "fallback-a", targetEndpoint: "ep-A" });
	});

	it("returns null when no fallback models were resolved (empty or absent chain)", () => {
		expect(resolveFallbackTargetFromParams(baseParams, "ep-A")).toBeNull();
		expect(
			resolveFallbackTargetFromParams({ ...baseParams, fallback_models: [] }, "ep-A"),
		).toBeNull();
	});

	it("returns null when the policy is 'never' even if a list is present (defense in depth)", () => {
		expect(
			resolveFallbackTargetFromParams(
				{
					...baseParams,
					fallback_policy: { mode: "never" },
					fallback_models: ["fallback-a"],
				},
				"ep-A",
			),
		).toBeNull();
	});

	it("stamps the executing endpoint as the target endpoint (co-located by construction)", () => {
		// The loop host only ships a model in fallback_models when it resolved the
		// chain; the driver treats the next entry as served on its own endpoint and
		// lets planCreditRedemption's co-location check compare it to the credit's
		// minting endpoint.
		const t = resolveFallbackTargetFromParams(
			{ ...baseParams, fallback_models: ["fallback-a"] },
			"bedrock:site-A:us-east-1",
		);
		expect(t?.targetEndpoint).toBe("bedrock:site-A:us-east-1");
	});
});

describe("serverToolsRanInChunks", () => {
	it("is true when a tool_use_start chunk appeared in the refused attempt", () => {
		const chunks: StreamChunk[] = [
			{ type: "text", content: "let me search" },
			{ type: "tool_use_start", id: "t1", name: "web_search" },
			{ type: "tool_use_end", id: "t1" },
		];
		expect(serverToolsRanInChunks(chunks)).toBe(true);
	});

	it("is false for a text-only / thinking-only refused attempt (no tool ran)", () => {
		const chunks: StreamChunk[] = [
			{ type: "thinking", content: "..." },
			{ type: "text", content: "I can't help" },
		];
		expect(serverToolsRanInChunks(chunks)).toBe(false);
	});
});

describe("creditTokenOf", () => {
	function doneChunk(token?: string): StreamChunk {
		return {
			type: "done",
			usage: {
				input_tokens: 10,
				output_tokens: 0,
				cache_read_tokens: 0,
				cache_write_tokens: 0,
			},
			...(token !== undefined
				? {
						declined: {
							kind: "model-declined" as const,
							reason: "refusal" as const,
							message: "declined",
							credit: { token, endpoint: "ep-A" },
						},
					}
				: {}),
		};
	}

	it("returns the credit token from the refused attempt's done chunk", () => {
		const chunks: StreamChunk[] = [{ type: "text", content: "I can't help" }, doneChunk("tok-xyz")];
		expect(creditTokenOf(chunks)).toBe("tok-xyz");
	});

	it("reads the last done chunk when more than one is present", () => {
		const chunks: StreamChunk[] = [doneChunk("tok-old"), doneChunk("tok-new")];
		expect(creditTokenOf(chunks)).toBe("tok-new");
	});

	it("returns an empty string when the done chunk carries no credit", () => {
		expect(creditTokenOf([{ type: "text", content: "hi" }, doneChunk()])).toBe("");
	});

	it("returns an empty string when there is no done chunk at all", () => {
		expect(creditTokenOf([{ type: "text", content: "hi" }])).toBe("");
	});
});

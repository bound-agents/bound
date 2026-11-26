import { describe, expect, it } from "bun:test";
import {
	LLMRefusalError,
	classifyAnthropicRefusal,
	classifyCopilotFinishReason,
	classifyGeminiInteractions400,
} from "../model-declined";
import { LLMError } from "../types";

describe("classifyAnthropicRefusal", () => {
	it("maps stop_reason=refusal to a substitutable model-declined outcome", () => {
		const outcome = classifyAnthropicRefusal("refusal", {
			category: "cyber",
			explanation: "Request involves offensive security tooling.",
		});
		expect(outcome).not.toBeNull();
		expect(outcome?.kind).toBe("model-declined");
		expect(outcome?.vendor).toBe("anthropic");
		expect(outcome?.category).toBe("cyber");
		expect(outcome?.raw_reason).toBe("refusal");
		expect(outcome?.explanation).toBe("Request involves offensive security tooling.");
		expect(outcome?.substitutable).toBe(true);
	});

	it("marks reasoning_extraction as non-substitutable", () => {
		const outcome = classifyAnthropicRefusal("refusal", {
			category: "reasoning_extraction",
			explanation: "Prompt asks to reveal hidden reasoning.",
		});
		expect(outcome?.substitutable).toBe(false);
		expect(outcome?.category).toBe("reasoning_extraction");
	});

	it("carries the fallback credit token and prefill-claim flag when present", () => {
		const outcome = classifyAnthropicRefusal(
			"refusal",
			{
				category: "bio",
				fallback_credit_token: "tok-123",
				fallback_has_prefill_claim: true,
			},
			"bedrock-mantle:us-east-1",
		);
		expect(outcome?.credit?.token).toBe("tok-123");
		expect(outcome?.credit?.has_prefill_claim).toBe(true);
		expect(outcome?.credit?.endpoint).toBe("bedrock-mantle:us-east-1");
	});

	it("returns null for a non-refusal stop reason", () => {
		expect(classifyAnthropicRefusal("end_turn", undefined)).toBeNull();
		expect(classifyAnthropicRefusal("tool_use", undefined)).toBeNull();
		expect(classifyAnthropicRefusal(null, undefined)).toBeNull();
	});

	it("has no category when stop_details omits one", () => {
		const outcome = classifyAnthropicRefusal("refusal", undefined);
		expect(outcome?.category).toBeNull();
		expect(outcome?.substitutable).toBe(true);
	});
});

describe("classifyGeminiInteractions400", () => {
	it.each(["safety", "jailbreak", "prohibited_content", "blocklist"])(
		"maps Interactions API 400 code=%s to a refusal",
		(code) => {
			const outcome = classifyGeminiInteractions400(code);
			expect(outcome?.kind).toBe("model-declined");
			expect(outcome?.vendor).toBe("google");
			expect(outcome?.category).toBe(code);
			expect(outcome?.raw_reason).toBe(code);
			expect(outcome?.substitutable).toBe(true);
		},
	);

	it("returns null for a 400 code that is not a recognized safety block", () => {
		expect(classifyGeminiInteractions400("invalid_argument")).toBeNull();
		expect(classifyGeminiInteractions400("bad_request")).toBeNull();
		expect(classifyGeminiInteractions400(undefined)).toBeNull();
		expect(classifyGeminiInteractions400(null)).toBeNull();
	});
});

describe("classifyCopilotFinishReason", () => {
	it("maps the AI SDK collapsed content-filter finish with category null", () => {
		const outcome = classifyCopilotFinishReason("content-filter");
		expect(outcome?.kind).toBe("model-declined");
		expect(outcome?.vendor).toBe("other");
		expect(outcome?.category).toBeNull();
		expect(outcome?.raw_reason).toBe("content-filter");
		expect(outcome?.substitutable).toBe(true);
	});

	it("returns null for other finish reasons", () => {
		expect(classifyCopilotFinishReason("stop")).toBeNull();
		expect(classifyCopilotFinishReason("length")).toBeNull();
		expect(classifyCopilotFinishReason("tool-calls")).toBeNull();
		expect(classifyCopilotFinishReason(undefined)).toBeNull();
	});
});

describe("LLMRefusalError", () => {
	it("is an LLMError carrying a classified outcome and the mint status code", () => {
		const outcome = classifyGeminiInteractions400("safety");
		if (!outcome) throw new Error("expected an outcome");
		const err = new LLMRefusalError("Gemini safety block", "gemini", outcome, 400);
		expect(err).toBeInstanceOf(LLMError);
		expect(err).toBeInstanceOf(LLMRefusalError);
		expect(err.name).toBe("LLMRefusalError");
		expect(err.outcome).toBe(outcome);
		expect(err.statusCode).toBe(400);
		expect(err.provider).toBe("gemini");
	});

	it("defaults status code to undefined for a 200-shaped refusal", () => {
		const outcome = classifyAnthropicRefusal("refusal", { category: "cyber" });
		if (!outcome) throw new Error("expected an outcome");
		const err = new LLMRefusalError("Anthropic refusal", "anthropic", outcome);
		expect(err.statusCode).toBeUndefined();
	});
});

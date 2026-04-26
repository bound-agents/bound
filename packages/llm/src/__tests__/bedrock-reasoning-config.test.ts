/**
 * Regression tests for buildReasoningConfig.
 *
 * The Bedrock Converse API routes reasoning parameters differently per model
 * family. The @ai-sdk/amazon-bedrock SDK emits warnings when we send features
 * that the target model doesn't support:
 *
 *   AI SDK Warning (amazon-bedrock / moonshotai.kimi-k2.5):
 *     The feature "budgetTokens" is not supported.
 *     budgetTokens applies only to Anthropic models on Bedrock and will be
 *     ignored for this model.
 *
 * Support matrix (mirrors @ai-sdk/amazon-bedrock@4 detection logic):
 *   - `anthropic.*`        → budgetTokens, adaptive thinking, effort all OK
 *   - `openai.*`           → only maxReasoningEffort (maps to reasoning_effort)
 *   - every other provider → only maxReasoningEffort (raw reasoningConfig)
 *
 * These tests lock in model-family gating so a non-Anthropic model doesn't
 * receive budgetTokens or `type: "adaptive"` reasoning, eliminating the
 * warnings at the source.
 */

import { describe, expect, it } from "bun:test";
import { buildReasoningConfig } from "../bedrock-driver";

describe("buildReasoningConfig — Anthropic models", () => {
	it("keeps budgetTokens for enabled thinking on Anthropic", () => {
		const cfg = buildReasoningConfig(
			{
				messages: [],
				thinking: { type: "enabled", budget_tokens: 8192 },
			},
			"anthropic.claude-opus-4-7",
		);
		expect(cfg).toEqual({ type: "enabled", budgetTokens: 8192 });
	});

	it("keeps adaptive thinking on Anthropic", () => {
		const cfg = buildReasoningConfig(
			{
				messages: [],
				thinking: { type: "adaptive", display: "summarized" },
			},
			"anthropic.claude-opus-4-7",
		);
		expect(cfg).toEqual({ type: "adaptive", display: "summarized" });
	});

	it("combines adaptive + effort on Anthropic", () => {
		const cfg = buildReasoningConfig(
			{
				messages: [],
				thinking: { type: "adaptive" },
				effort: "xhigh",
			},
			"anthropic.claude-opus-4-7",
		);
		expect(cfg).toEqual({ type: "adaptive", maxReasoningEffort: "xhigh" });
	});

	it("matches Anthropic when modelId is a full inference-profile ARN", () => {
		const cfg = buildReasoningConfig(
			{
				messages: [],
				thinking: { type: "enabled", budget_tokens: 4096 },
			},
			"arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-opus-4-7",
		);
		expect(cfg).toEqual({ type: "enabled", budgetTokens: 4096 });
	});
});

describe("buildReasoningConfig — non-Anthropic models", () => {
	it("drops budgetTokens for Moonshot (keeps effort only)", () => {
		const cfg = buildReasoningConfig(
			{
				messages: [],
				thinking: { type: "enabled", budget_tokens: 8192 },
				effort: "high",
			},
			"moonshotai.kimi-k2.5",
		);
		expect(cfg).toEqual({ maxReasoningEffort: "high" });
	});

	it("drops adaptive thinking for Moonshot (keeps effort only)", () => {
		const cfg = buildReasoningConfig(
			{
				messages: [],
				thinking: { type: "adaptive", display: "summarized" },
				effort: "medium",
			},
			"moonshotai.kimi-k2.5",
		);
		expect(cfg).toEqual({ maxReasoningEffort: "medium" });
	});

	it("returns undefined for MiniMax when only budget_tokens is set (nothing to forward)", () => {
		const cfg = buildReasoningConfig(
			{
				messages: [],
				thinking: { type: "enabled", budget_tokens: 8192 },
			},
			"minimax.minimax-m2.5",
		);
		expect(cfg).toBeUndefined();
	});

	it("returns undefined for MiniMax when only adaptive is set (nothing to forward)", () => {
		const cfg = buildReasoningConfig(
			{
				messages: [],
				thinking: { type: "adaptive" },
			},
			"minimax.minimax-m2.5",
		);
		expect(cfg).toBeUndefined();
	});

	it("keeps effort for OpenAI (maxReasoningEffort → reasoning_effort on wire)", () => {
		const cfg = buildReasoningConfig(
			{
				messages: [],
				effort: "high",
			},
			"openai.gpt-oss-120b",
		);
		expect(cfg).toEqual({ maxReasoningEffort: "high" });
	});
});

describe("buildReasoningConfig — empty / irrelevant input", () => {
	it("returns undefined when no thinking and no effort regardless of model", () => {
		expect(buildReasoningConfig({ messages: [] }, "anthropic.claude-opus-4-7")).toBeUndefined();
		expect(buildReasoningConfig({ messages: [] }, "moonshotai.kimi-k2.5")).toBeUndefined();
	});
});

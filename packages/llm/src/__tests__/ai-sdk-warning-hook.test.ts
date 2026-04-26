/**
 * Regression tests for the AI SDK warning hook.
 *
 * The AI SDK (`ai`) emits warnings via a global callback — by default it writes
 * to `console.warn`, which bypasses bound's pino logger entirely. As a result
 * the 32MB `logs/bound.log` file contains zero "AI SDK Warning" entries even
 * when the console is flooded with them (e.g. non-Anthropic models receiving
 * Anthropic-specific reasoning fields before the 2026-04-25 fix).
 *
 * `installAiSdkWarningHook(logger)` replaces the global with a routing
 * function that feeds structured context to pino. These tests lock in the
 * output shape so a future refactor can't quietly revert to console.warn.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Logger } from "@bound/shared";
import { installAiSdkWarningHook, uninstallAiSdkWarningHook } from "../ai-sdk-warning-hook";

interface CapturedLog {
	level: "debug" | "info" | "warn" | "error";
	message: string;
	context?: Record<string, unknown>;
}

function createCapturingLogger(): { logger: Logger; captured: CapturedLog[] } {
	const captured: CapturedLog[] = [];
	const push =
		(level: CapturedLog["level"]) => (message: string, context?: Record<string, unknown>) => {
			captured.push({ level, message, context });
		};
	return {
		captured,
		logger: {
			debug: push("debug"),
			info: push("info"),
			warn: push("warn"),
			error: push("error"),
		},
	};
}

describe("installAiSdkWarningHook", () => {
	beforeEach(() => {
		// Start each test with a clean global, whatever was there before.
		uninstallAiSdkWarningHook();
	});

	afterEach(() => {
		uninstallAiSdkWarningHook();
	});

	it("routes 'unsupported' warnings through logger.warn with structured context", () => {
		const { logger, captured } = createCapturingLogger();
		installAiSdkWarningHook(logger);

		const hook = (globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS;
		expect(typeof hook).toBe("function");

		(hook as (opts: unknown) => void)({
			provider: "amazon-bedrock",
			model: "moonshotai.kimi-k2.5",
			warnings: [
				{
					type: "unsupported",
					feature: "budgetTokens",
					details: "budgetTokens applies only to Anthropic models on Bedrock.",
				},
			],
		});

		expect(captured).toHaveLength(1);
		expect(captured[0].level).toBe("warn");
		expect(captured[0].message).toContain("budgetTokens");
		expect(captured[0].context).toMatchObject({
			provider: "amazon-bedrock",
			model: "moonshotai.kimi-k2.5",
			type: "unsupported",
			feature: "budgetTokens",
		});
	});

	it("routes 'compatibility' warnings through logger.warn with the details field", () => {
		const { logger, captured } = createCapturingLogger();
		installAiSdkWarningHook(logger);

		const hook = (globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS as (
			opts: unknown,
		) => void;

		hook({
			provider: "amazon-bedrock",
			model: "anthropic.claude-sonnet-4-6",
			warnings: [
				{
					type: "compatibility",
					feature: "imageDetail",
					details: "Image detail is ignored in compatibility mode.",
				},
			],
		});

		expect(captured).toHaveLength(1);
		expect(captured[0].context).toMatchObject({
			type: "compatibility",
			feature: "imageDetail",
		});
	});

	it("routes 'other' warnings (which carry 'message' not 'feature') through logger.warn", () => {
		const { logger, captured } = createCapturingLogger();
		installAiSdkWarningHook(logger);

		const hook = (globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS as (
			opts: unknown,
		) => void;

		hook({
			provider: "amazon-bedrock",
			model: "anthropic.claude-opus-4-7",
			warnings: [{ type: "other", message: "Something odd happened" }],
		});

		expect(captured).toHaveLength(1);
		expect(captured[0].message).toContain("Something odd happened");
		expect(captured[0].context).toMatchObject({ type: "other" });
	});

	it("emits one logger entry per warning in a batch", () => {
		const { logger, captured } = createCapturingLogger();
		installAiSdkWarningHook(logger);

		const hook = (globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS as (
			opts: unknown,
		) => void;

		hook({
			provider: "amazon-bedrock",
			model: "moonshotai.kimi-k2.5",
			warnings: [
				{ type: "unsupported", feature: "budgetTokens" },
				{ type: "unsupported", feature: "adaptive thinking" },
			],
		});

		expect(captured).toHaveLength(2);
		expect(captured[0].context?.feature).toBe("budgetTokens");
		expect(captured[1].context?.feature).toBe("adaptive thinking");
	});

	it("handles an empty warnings array without throwing or emitting", () => {
		const { logger, captured } = createCapturingLogger();
		installAiSdkWarningHook(logger);

		const hook = (globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS as (
			opts: unknown,
		) => void;

		hook({ provider: "amazon-bedrock", model: "anthropic.claude-opus-4-7", warnings: [] });
		expect(captured).toHaveLength(0);
	});

	it("uninstallAiSdkWarningHook clears the global back to undefined", () => {
		const { logger } = createCapturingLogger();
		installAiSdkWarningHook(logger);
		expect((globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS).toBeDefined();
		uninstallAiSdkWarningHook();
		expect((globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS).toBeUndefined();
	});
});

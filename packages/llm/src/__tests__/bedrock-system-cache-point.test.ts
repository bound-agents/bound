/**
 * Regression tests for Bedrock system-block `cachePoint` placement.
 *
 * The R-VC25 stable-prefix purity work makes the system prompt byte-stable
 * across cold rebuilds, but byte-stability alone is wasted if the wire
 * envelope provides no cache anchor for that prefix. Bedrock's Converse API
 * exposes a `cachePoint` boundary on the `system` blocks array, but the AI
 * SDK's top-level `streamText({system: <string>})` parameter normalizes the
 * value into a system block WITHOUT `providerOptions`, so the cache point
 * never reaches the wire. The fix is to inject the system content as a
 * `role: "system"` `ModelMessage` at index 0 of the messages array with
 * `providerOptions.bedrock.cachePoint` attached.
 *
 * Live evidence (thread `927d4562-…`): with the prior implementation, the
 * volatile-prefix portion was byte-stable at 67,730 tokens across 27 turns,
 * yet `tokens_cache_read = 0` on every turn after the eighth. The
 * message-level cache marker was the only anchor, and its position moved with
 * each turn as message history grew, orphaning prior cache entries on
 * Bedrock's side. Total session hit rate landed at 11.05% — essentially
 * identical to the failure-thread baseline before the prefix-purity fix.
 *
 * These tests pin the contract:
 *
 *   C1 No system → null block (caller skips the prepend).
 *   C2 System + cacheEnabled → system block carries cachePoint.
 *   C3 System + !cacheEnabled → system block carries NO providerOptions.
 *   C4 cache_ttl forwards to cachePoint.ttl.
 *   C5 hasBedrockMessageCachePoint detects the marker post-bridge.
 *   C6 Determinism — same inputs produce byte-equal output.
 *   C7 Invariant (the regression sentry) — given a non-empty system AND a
 *      bridge-output messages array that already carries a Bedrock
 *      cachePoint on some message, the system message produced for the
 *      messages-array index 0 MUST carry a cachePoint of its own.
 */

import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
import fc from "fast-check";
import {
	buildBedrockSystemMessage,
	hasBedrockMessageCachePoint,
	shouldEnableSystemCachePoint,
} from "../bedrock-driver";

describe("Bedrock chat() — system anchor independence from message-level marker", () => {
	// Regression sentry for the live thread `a191e01f-…` 2026-05-25 issue:
	// the bedrock-driver gated `cacheEnabled` on
	// `hasBedrockMessageCachePoint(bridgeMessages)`. When no message-level
	// marker was placed (truncation drops the latest user, semantic-anchor
	// fallback returns no-eligible-anchor, etc.), the system anchor was
	// disabled too — even though caching was intended (cache_ttl set).
	// 79 turns of the thread ran with cr=0 across the board.
	//
	// The contract: SYSTEM anchor enablement is independent of MESSAGE-level
	// marker presence. The system block carries its own cachePoint whenever
	// the caller signals caching intent (cache_ttl set), regardless of
	// what's happening at the message level.

	it("D1 (load-bearing): system anchor enabled when cache_ttl is set, even with no message-level marker", () => {
		// `bridgeMessages` here has NO providerOptions.bedrock.cachePoint
		// — no message-level marker placed. The old contract (cacheEnabled
		// = hasBedrockMessageCachePoint) would say false; system gets no
		// cachePoint; caching is fully off. The new contract says: system
		// anchor still rides because cache_ttl was set.
		const bridgeMessagesWithoutMarker: ModelMessage[] = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
			{ role: "user", content: "follow up" },
		];

		// Direct call to the system message builder with the contract under
		// test: enable cachePoint when cache_ttl is intended, independent
		// of any message-level marker presence.
		const enabled = bridgeMessagesWithoutMarker.some((m) => {
			const opts = m.providerOptions as { bedrock?: { cachePoint?: unknown } } | undefined;
			return opts?.bedrock?.cachePoint !== undefined;
		});
		// Today: enabled === false → system gets no cachePoint → bug.
		expect(enabled).toBe(false);

		// The fix: system anchor enabled whenever `cache_ttl` is set, even
		// if no bridge message has a cachePoint. Encoded by
		// `shouldEnableSystemCachePoint`.
		const shouldEnable = shouldEnableSystemCachePoint({
			cacheTtl: "1h",
			bridgeMessages: bridgeMessagesWithoutMarker,
		});
		expect(shouldEnable).toBe(true);
	});

	it("D2: system anchor disabled when cache_ttl is undefined (caller signals no caching intent)", () => {
		const bridgeMessages: ModelMessage[] = [{ role: "user", content: "hi" }];
		const shouldEnable = shouldEnableSystemCachePoint({
			cacheTtl: undefined,
			bridgeMessages,
		});
		expect(shouldEnable).toBe(false);
	});

	it("D3: system anchor enabled when message-level marker present (preserves prior behavior)", () => {
		const bridgeMessages: ModelMessage[] = [
			{ role: "user", content: "hi" },
			{
				role: "user",
				content: "with cp",
				providerOptions: { bedrock: { cachePoint: { type: "default" } } },
			},
		];
		const shouldEnable = shouldEnableSystemCachePoint({
			cacheTtl: undefined,
			bridgeMessages,
		});
		// Even without cache_ttl, presence of message-level marker means
		// some caller already intended caching → enable system anchor.
		expect(shouldEnable).toBe(true);
	});
});

describe("buildBedrockSystemMessage", () => {
	it("C1: returns null when system is empty/missing", () => {
		expect(buildBedrockSystemMessage({ cacheEnabled: true })).toBeNull();
		expect(buildBedrockSystemMessage({ system: "", cacheEnabled: true })).toBeNull();
		expect(buildBedrockSystemMessage({ system: undefined, cacheEnabled: true })).toBeNull();
	});

	it("C2: emits cachePoint when cacheEnabled is true", () => {
		const block = buildBedrockSystemMessage({
			system: "you are a helpful agent",
			cacheEnabled: true,
		});
		expect(block).not.toBeNull();
		expect(block?.role).toBe("system");
		expect(block?.content).toBe("you are a helpful agent");
		const opts = block?.providerOptions as
			| { bedrock?: { cachePoint?: { type?: string } } }
			| undefined;
		expect(opts?.bedrock?.cachePoint?.type).toBe("default");
	});

	it("C3: omits providerOptions when cacheEnabled is false", () => {
		const block = buildBedrockSystemMessage({
			system: "you are a helpful agent",
			cacheEnabled: false,
		});
		expect(block).not.toBeNull();
		expect(block?.role).toBe("system");
		expect(block?.content).toBe("you are a helpful agent");
		expect(block?.providerOptions).toBeUndefined();
	});

	it("C4: forwards cache_ttl to cachePoint.ttl when present", () => {
		const block = buildBedrockSystemMessage({
			system: "stable prefix",
			cacheEnabled: true,
			cacheTtl: "1h",
		});
		const opts = block?.providerOptions as
			| { bedrock?: { cachePoint?: { ttl?: string } } }
			| undefined;
		expect(opts?.bedrock?.cachePoint?.ttl).toBe("1h");
	});

	it("C4b: omits ttl from cachePoint when cache_ttl is absent", () => {
		const block = buildBedrockSystemMessage({
			system: "stable prefix",
			cacheEnabled: true,
		});
		const opts = block?.providerOptions as
			| { bedrock?: { cachePoint?: { ttl?: string } } }
			| undefined;
		expect(opts?.bedrock?.cachePoint?.ttl).toBeUndefined();
	});
});

describe("hasBedrockMessageCachePoint", () => {
	it("C5: detects cachePoint on a user message", () => {
		const messages: ModelMessage[] = [
			{ role: "user", content: "hi" },
			{
				role: "user",
				content: "follow-up",
				providerOptions: { bedrock: { cachePoint: { type: "default" } } },
			},
		];
		expect(hasBedrockMessageCachePoint(messages)).toBe(true);
	});

	it("C5b: returns false when no message carries a cachePoint", () => {
		const messages: ModelMessage[] = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "there" },
		];
		expect(hasBedrockMessageCachePoint(messages)).toBe(false);
	});

	it("C5c: returns false when providerOptions exists but lacks bedrock.cachePoint", () => {
		const messages: ModelMessage[] = [
			{
				role: "user",
				content: "hi",
				providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
			},
		];
		expect(hasBedrockMessageCachePoint(messages)).toBe(false);
	});

	it("C5d: returns false on empty array", () => {
		expect(hasBedrockMessageCachePoint([])).toBe(false);
	});
});

describe("buildBedrockSystemMessage — property tests", () => {
	const safeText = fc.string({ minLength: 1, maxLength: 256 });

	it("C6: determinism — same inputs produce byte-equal output", () => {
		fc.assert(
			fc.property(
				safeText,
				fc.boolean(),
				fc.option(fc.constantFrom("5m" as const, "1h" as const), { nil: undefined }),
				(system, cacheEnabled, cacheTtl) => {
					const a = buildBedrockSystemMessage({
						system,
						cacheEnabled,
						cacheTtl: cacheTtl ?? undefined,
					});
					const b = buildBedrockSystemMessage({
						system,
						cacheEnabled,
						cacheTtl: cacheTtl ?? undefined,
					});
					return JSON.stringify(a) === JSON.stringify(b);
				},
			),
			{ numRuns: 100 },
		);
	});

	it("C7 (invariant — regression sentry): non-empty system + cacheEnabled ALWAYS yields cachePoint at messages[0]", () => {
		// This is the load-bearing assertion. Future refactors of the bedrock
		// driver MUST preserve the property that when the agent loop has
		// signaled caching is enabled (a message carries a Bedrock cachePoint
		// after the bridge runs), the system block injected at messages[0]
		// also carries a cachePoint. Without it, the byte-stable system
		// prefix has no cache anchor and the prompt cache thrashes — the
		// exact regression that thread `927d4562-…` exhibited at 11.05% hit
		// rate despite the R-VC25 prefix purity fix.
		fc.assert(
			fc.property(safeText, (system) => {
				const block = buildBedrockSystemMessage({
					system,
					cacheEnabled: true,
					cacheTtl: "1h",
				});
				if (!block) return false;
				if (block.role !== "system") return false;
				const opts = block.providerOptions as
					| { bedrock?: { cachePoint?: { type?: string } } }
					| undefined;
				return opts?.bedrock?.cachePoint?.type === "default";
			}),
			{ numRuns: 100 },
		);
	});
});

describe("Bedrock chat() integration — system + cachePoint placement", () => {
	// These tests construct the same shape that BedrockDriver.chat() builds
	// internally (toModelMessages → buildBedrockSystemMessage → prepend) and
	// assert the wire-bound message array satisfies the cachePoint invariant.
	// They cover the gap between the unit tests above and a full streamText
	// stub: if a future refactor moves logic around inside chat(), these
	// tests catch the loss of the cachePoint at the messages[0] boundary.

	it("C8: system + bridge-output cache marker → messages[0] has cachePoint", () => {
		// Simulates the post-toModelMessages state when a {role:"cache"} marker
		// was present in the input — the bridge attaches the cachePoint to
		// the most recently emitted message. The driver should detect this
		// and propagate the cachePoint to the system message.
		const bridgeMessages: ModelMessage[] = [
			{ role: "user", content: "hi" },
			{
				role: "user",
				content: "second",
				providerOptions: { bedrock: { cachePoint: { type: "default", ttl: "1h" } } },
			},
		];
		const systemMessage = buildBedrockSystemMessage({
			system: "STABLE_PREFIX",
			cacheEnabled: hasBedrockMessageCachePoint(bridgeMessages),
			cacheTtl: "1h",
		});
		const messages = systemMessage ? [systemMessage, ...bridgeMessages] : bridgeMessages;

		expect(messages[0].role).toBe("system");
		expect(messages[0].content).toBe("STABLE_PREFIX");
		const opts = messages[0].providerOptions as
			| { bedrock?: { cachePoint?: { type?: string; ttl?: string } } }
			| undefined;
		expect(opts?.bedrock?.cachePoint?.type).toBe("default");
		expect(opts?.bedrock?.cachePoint?.ttl).toBe("1h");
	});

	it("C9: system + no bridge-output cache marker → messages[0] is system but has NO cachePoint", () => {
		// Capability gate disabled caching upstream — no {role:"cache"} marker
		// was placed. The system block should still ride the messages array
		// (so the wire request is well-formed and downstream logic doesn't
		// break) but without a cachePoint.
		const bridgeMessages: ModelMessage[] = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		];
		const systemMessage = buildBedrockSystemMessage({
			system: "STABLE_PREFIX",
			cacheEnabled: hasBedrockMessageCachePoint(bridgeMessages),
		});
		const messages = systemMessage ? [systemMessage, ...bridgeMessages] : bridgeMessages;

		expect(messages[0].role).toBe("system");
		expect(messages[0].providerOptions).toBeUndefined();
	});

	it("C10: no system → bridge messages pass through unchanged", () => {
		const bridgeMessages: ModelMessage[] = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "there" },
		];
		const systemMessage = buildBedrockSystemMessage({
			cacheEnabled: hasBedrockMessageCachePoint(bridgeMessages),
		});
		const messages = systemMessage ? [systemMessage, ...bridgeMessages] : bridgeMessages;

		expect(messages.length).toBe(bridgeMessages.length);
		expect(messages[0]).toBe(bridgeMessages[0]);
	});
});

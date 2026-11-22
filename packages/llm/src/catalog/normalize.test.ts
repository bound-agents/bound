/**
 * Structural model-ID normalization (slice 6, R-MC8, 2026-11-21-model-catalog.md
 * §5.2 + §6.1). One shared rule set drives BOTH `models.dev` matching and
 * logical-model grouping: it derives a canonical key from provider naming
 * patterns (region prefixes, vendor prefixes, revision suffixes, version
 * separators) WITHOUT enumerating specific model names (R-MC1). These tests pin
 * the structural rules against synthetic / future model IDs so a brand-new model
 * that follows the patterns groups correctly with no code change.
 */

import { describe, expect, it } from "bun:test";
import { normalizeModelKey } from "./normalize";

describe("normalizeModelKey", () => {
	describe("region/routing prefixes", () => {
		it("strips us./eu./ap./global. inference-profile prefixes", () => {
			const base = normalizeModelKey("bedrock", "anthropic.claude-opus-4-20250101-v1:0").key;
			expect(normalizeModelKey("bedrock", "us.anthropic.claude-opus-4-20250101-v1:0").key).toBe(
				base,
			);
			expect(normalizeModelKey("bedrock", "eu.anthropic.claude-opus-4-20250101-v1:0").key).toBe(
				base,
			);
			expect(normalizeModelKey("bedrock", "ap.anthropic.claude-opus-4-20250101-v1:0").key).toBe(
				base,
			);
			expect(normalizeModelKey("bedrock", "global.anthropic.claude-opus-4-20250101-v1:0").key).toBe(
				base,
			);
		});

		it("does not strip a region-looking token that is part of the family name", () => {
			// "ap" only strips as a leading dotted routing segment, never mid-name.
			const k = normalizeModelKey("openai-compatible", "snap-coder-1").key;
			expect(k).toContain("snap-coder");
		});
	});

	describe("vendor prefixes", () => {
		it("strips anthropic./openai./google. dotted vendor prefixes", () => {
			expect(normalizeModelKey("bedrock", "anthropic.claude-sonnet-4-v1:0").key).toBe(
				normalizeModelKey("anthropic", "claude-sonnet-4").key,
			);
		});

		it("strips copilot- and bedrock- dashed vendor prefixes", () => {
			expect(normalizeModelKey("github-copilot", "copilot-gpt-6.2-sol").key).toBe(
				normalizeModelKey("openai-compatible", "gpt-6.2-sol").key,
			);
		});
	});

	describe("revision/snapshot suffixes", () => {
		it("strips -vN:0 and :0 Bedrock deployment revisions", () => {
			const base = normalizeModelKey("bedrock", "anthropic.claude-opus-4").key;
			expect(normalizeModelKey("bedrock", "anthropic.claude-opus-4-v1:0").key).toBe(base);
			expect(normalizeModelKey("bedrock", "anthropic.claude-opus-4-v2:0").key).toBe(base);
			expect(normalizeModelKey("bedrock", "anthropic.claude-opus-4:0").key).toBe(base);
		});

		it("strips an 8-digit dated snapshot suffix when a family key remains", () => {
			const base = normalizeModelKey("anthropic", "claude-opus-4").key;
			expect(normalizeModelKey("anthropic", "claude-opus-4-20250101").key).toBe(base);
			expect(normalizeModelKey("bedrock", "anthropic.claude-opus-4-20250101-v1:0").key).toBe(base);
		});

		it("keeps a bare dated token if stripping would empty the family", () => {
			// Defensive: never normalize an ID down to the empty string.
			expect(normalizeModelKey("openai-compatible", "20250101").key).toBe("20250101");
		});
	});

	describe("version separators", () => {
		it("canonicalizes dot and dash version separators to one form", () => {
			expect(normalizeModelKey("openai-compatible", "gpt-6.2-sol").key).toBe(
				normalizeModelKey("openai-compatible", "gpt-6-2-sol").key,
			);
		});
	});

	describe("future/synthetic model IDs (R-MC8 acceptance)", () => {
		it("groups a never-before-seen model that follows the region+vendor+revision pattern", () => {
			// An invented future Claude on Bedrock across two regions + a direct
			// Anthropic listing all collapse to the same canonical key with zero
			// model-specific code.
			const direct = normalizeModelKey("anthropic", "claude-zenith-9").key;
			const bedrockUs = normalizeModelKey(
				"bedrock",
				"us.anthropic.claude-zenith-9-20270714-v1:0",
			).key;
			const bedrockEu = normalizeModelKey(
				"bedrock",
				"eu.anthropic.claude-zenith-9-20270714-v3:0",
			).key;
			expect(bedrockUs).toBe(direct);
			expect(bedrockEu).toBe(direct);
		});

		it("groups an invented GPT across copilot and openai namespaces", () => {
			expect(normalizeModelKey("github-copilot", "copilot-gpt-9-nova").key).toBe(
				normalizeModelKey("openai-compatible", "gpt-9-nova").key,
			);
		});
	});

	describe("determinism and shape", () => {
		it("is idempotent — normalizing a canonical key yields itself", () => {
			const once = normalizeModelKey("bedrock", "us.anthropic.claude-opus-4-v1:0").key;
			const twice = normalizeModelKey("openai-compatible", once).key;
			expect(twice).toBe(once);
		});

		it("returns the recognized-namespace flag for known providers", () => {
			expect(normalizeModelKey("anthropic", "claude-opus-4").recognizedNamespace).toBe(true);
			expect(normalizeModelKey("bedrock", "anthropic.claude-opus-4").recognizedNamespace).toBe(
				true,
			);
			expect(normalizeModelKey("github-copilot", "copilot-gpt-6").recognizedNamespace).toBe(true);
			expect(normalizeModelKey("umans", "claude-opus-4").recognizedNamespace).toBe(true);
		});

		it("marks a bare openai-compatible tag with no vendor qualification as unrecognized", () => {
			// An arbitrary local/gateway tag is NOT a recognized hosted namespace:
			// grouping it automatically would risk a false pool (§6.2 condition 1).
			expect(normalizeModelKey("openai-compatible", "my-local-thing").recognizedNamespace).toBe(
				false,
			);
		});

		it("treats an openai-compatible tag with a known vendor family as recognized", () => {
			// A vendor-qualified family (gpt-*, claude-*, llama-*, …) under an
			// openai-compatible shim IS recognized for grouping purposes.
			expect(normalizeModelKey("openai-compatible", "gpt-6.2-sol").recognizedNamespace).toBe(true);
		});
	});
});

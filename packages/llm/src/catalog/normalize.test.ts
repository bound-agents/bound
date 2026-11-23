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

	describe("cross-provider family consistency (structural dotted vendor)", () => {
		// One model family must yield ONE canonical key regardless of which
		// provider advertises it and which region/vendor prefixes decorate the raw
		// id. Bedrock-style `<vendor>.<model>` prefixes (moonshotai., zai., xai.,
		// deepseek., minimax., amazon., openai., anthropic., …) are detected
		// STRUCTURALLY — a leading dotted segment with no digit that is not itself
		// a family root — never from an enumerated vendor list (R-MC1/R-MC8).
		const listed: Array<[provider: string, providerModelId: string, expected: string]> = [
			// Bedrock moonshotai / zai dotted vendors now strip to the bare family,
			// matching the same model on opencode-go / zai direct.
			["bedrock", "moonshotai.kimi-k2.5", "kimi-k2-5"],
			["bedrock", "us.moonshotai.kimi-k3.1", "kimi-k3-1"],
			["bedrock", "zai.glm-5", "glm-5"],
			["opencode-go", "kimi-k2.6", "kimi-k2-6"],
			["opencode-go", "kimi-k3", "kimi-k3"],
			["opencode-go", "kimi-k2.7-code", "kimi-k2-7-code"],
			["zai", "glm-5.2", "glm-5-2"],
			["zai", "glm-5.3-flash", "glm-5-3-flash"],
			// Bedrock hardcoded-list vendors (amazon., openai., anthropic.) keep working.
			["bedrock", "us.amazon.nova-pro-v1:0", "nova-pro"],
			["bedrock-mantle", "openai.gpt-5.4", "gpt-5-4"],
			["chatgpt-oauth", "gpt-5.6-sol", "gpt-5-6-sol"],
			["github-copilot", "gpt-6.2-sol", "gpt-6-2-sol"],
			["bedrock-mantle", "anthropic.claude-opus-5-5", "claude-opus-5-5"],
			["github-copilot", "claude-opus-5.5", "claude-opus-5-5"],
			["bedrock", "global.anthropic.claude-haiku-5-5", "claude-haiku-5-5"],
			["github-copilot", "grok-4.7", "grok-4-7"],
			["github-copilot", "gemini-4-neon", "gemini-4-neon"],
		];

		for (const [provider, providerModelId, expected] of listed) {
			it(`${provider} : ${providerModelId} -> ${expected}`, () => {
				expect(normalizeModelKey(provider, providerModelId).key).toBe(expected);
			});
		}

		it("groups the same model across providers to one key (moonshotai/zai families)", () => {
			// kimi-k3.1 on Bedrock (us.moonshotai.*) === kimi family direct.
			expect(normalizeModelKey("bedrock", "us.moonshotai.kimi-k3.1").key).toBe(
				normalizeModelKey("opencode-go", "kimi-k3.1").key,
			);
			// glm-5 on Bedrock (zai.glm-5) === glm-5 on zai direct.
			expect(normalizeModelKey("bedrock", "zai.glm-5").key).toBe(
				normalizeModelKey("zai", "glm-5").key,
			);
		});

		it("strips a Bedrock-style dotted vendor for any vendor head, not a fixed list", () => {
			// minimax. / xai. are NOT in the legacy DOTTED_VENDOR_PREFIXES list, yet the
			// structural rule strips them inside a Bedrock namespace, so the
			// vendor-prefixed Bedrock id collapses to the bare family key.
			expect(normalizeModelKey("amazon-bedrock", "minimax.minimax-m3").key).toBe("minimax-m3");
			expect(normalizeModelKey("amazon-bedrock", "xai.grok-4.7").key).toBe("grok-4-7");
			// The same model via a non-Bedrock namespace reaches the same key.
			expect(normalizeModelKey("bedrock", "xai.grok-4.7").key).toBe(
				normalizeModelKey("github-copilot", "grok-4.7").key,
			);
		});

		it("strips a digit-free dotted head even when it coincides with a family root", () => {
			// `deepseek.`, `qwen.`, `mistral.` are both Bedrock vendor segments and
			// model-family roots. The head carries no digit, so it is a vendor segment
			// and strips; the body that follows IS the model. Audited against the real
			// models.dev snapshot: the resulting bare keys (`v3`, `r1`, `qwen3-32b`,
			// `pixtral-large-2502`) never collide with a genuinely different model —
			// every provider advertising them means the same model (requirement 3).
			expect(normalizeModelKey("bedrock", "deepseek.v3-v1:0").key).toBe("v3");
			expect(normalizeModelKey("bedrock", "deepseek.r1-v1:0").key).toBe("r1");
			expect(normalizeModelKey("bedrock", "qwen.qwen3-32b-v1:0").key).toBe("qwen3-32b");
			expect(normalizeModelKey("bedrock", "mistral.pixtral-large-2502-v1:0").key).toBe(
				"pixtral-large-2502",
			);
		});

		it("only strips a dotted vendor inside a Bedrock-style namespace", () => {
			// A dotted segment that LOOKS like a vendor outside a Bedrock namespace is
			// left alone — the structural strip is namespace-scoped (§6.1). An
			// openai-compatible gateway tag `moonshotai.kimi-k3` keeps its head so it
			// never silently pools with a real Bedrock-hosted kimi.
			expect(normalizeModelKey("openai-compatible", "moonshotai.kimi-k3").key).toBe(
				"moonshotai.kimi-k3",
			);
		});
	});

	describe("false-strip guard: a family-version head is never a vendor", () => {
		// The structural dotted-vendor rule must NEVER strip a model head that is a
		// family-version token. These all keep their head even inside a Bedrock
		// namespace, because the head either contains a digit or is a family root.
		const keepHead: Array<[provider: string, providerModelId: string, expected: string]> = [
			["openai-compatible", "gpt-5.4", "gpt-5-4"],
			["zai", "glm-5.2", "glm-5-2"],
			["bedrock", "moonshotai.kimi-k2.5", "kimi-k2-5"], // vendor stripped, k2.5 version kept
			["opencode-go", "qwen3.7-max", "qwen3-7-max"],
			["bedrock", "gpt-5.4", "gpt-5-4"], // bare family head in a Bedrock ns: head kept
			["bedrock", "glm-5.2", "glm-5-2"],
		];
		for (const [provider, providerModelId, expected] of keepHead) {
			it(`keeps head: ${provider} : ${providerModelId} -> ${expected}`, () => {
				expect(normalizeModelKey(provider, providerModelId).key).toBe(expected);
			});
		}

		it("does not collide two genuinely different families", () => {
			// glm-5 and gpt-5 must never share a key; nova-pro and nova-lite stay distinct.
			expect(normalizeModelKey("zai", "glm-5").key).not.toBe(
				normalizeModelKey("openai", "gpt-5").key,
			);
			expect(normalizeModelKey("bedrock", "us.amazon.nova-pro-v1:0").key).not.toBe(
				normalizeModelKey("bedrock", "us.amazon.nova-lite-v1:0").key,
			);
		});
	});

	describe("provider-local pseudo-models (R-MC9, §6.1)", () => {
		it("scopes github-copilot `auto` to its provider namespace, never a bare key", () => {
			// `auto` is Copilot's per-session model router, not a model. A bare `auto`
			// key would pool with any other provider's `auto`. The key is
			// provider-scoped so it can never cross-provider-pool.
			const { key } = normalizeModelKey("github-copilot", "auto");
			expect(key).toBe("github-copilot:auto");
			expect(key).not.toBe("auto");
		});

		it("marks a provider-local pseudo-model as an unrecognized namespace", () => {
			// A pseudo-model must not auto-group: the confidence predicate (§6.2) sees
			// recognizedNamespace=false so it stays unassigned, never pooled.
			expect(normalizeModelKey("github-copilot", "auto").recognizedNamespace).toBe(false);
		});

		it("does not treat `auto` as a pseudo-model for a non-copilot provider", () => {
			// The pseudo-model scoping is specific to the providers that publish a
			// router pseudo-model; an arbitrary provider's literal `auto` is a normal
			// (unrecognized) tag, not special-cased.
			expect(normalizeModelKey("openai-compatible", "auto").key).toBe("auto");
		});
	});
});

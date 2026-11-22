/**
 * Logical-model grouping precedence + confidence predicate (slice 6, R-MC8/R-MC9,
 * 2026-11-21-model-catalog.md §6). Resolution order: synced `model_aliases` (incl.
 * explicit null) → local config `logical_model` → structural normalization, and
 * normalization only auto-groups when the confidence predicate holds (recognized
 * namespace AND normalized key matches models.dev or a confirmed cluster logical
 * model). Anything else is advertised `logical_model: null`.
 */

import { describe, expect, it } from "bun:test";
import { resolveLogicalModel } from "./resolve-grouping";

describe("resolveLogicalModel", () => {
	const baseArgs = {
		provider: "anthropic",
		providerModelId: "claude-opus-4",
		aliasOverride: undefined as string | null | undefined,
		configLogicalModel: undefined as string | undefined,
		modelsDevKeys: new Set<string>(),
		confirmedLogicalKeys: new Set<string>(),
	};

	describe("precedence (R-MC8)", () => {
		it("synced alias override wins over config and normalization", () => {
			const r = resolveLogicalModel({
				...baseArgs,
				aliasOverride: "opus",
				configLogicalModel: "config-opus",
			});
			expect(r.logicalModel).toBe("opus");
			expect(r.source).toBe("alias");
		});

		it("an explicit null alias keeps the backend ungrouped even when config/normalization would group", () => {
			const r = resolveLogicalModel({
				...baseArgs,
				aliasOverride: null,
				configLogicalModel: "config-opus",
				confirmedLogicalKeys: new Set(["claude-opus-4"]),
			});
			expect(r.logicalModel).toBeNull();
			expect(r.source).toBe("alias");
		});

		it("local config logical_model wins over normalization when no alias", () => {
			const r = resolveLogicalModel({
				...baseArgs,
				configLogicalModel: "my-opus",
			});
			expect(r.logicalModel).toBe("my-opus");
			expect(r.source).toBe("config");
		});
	});

	describe("confidence predicate (R-MC9 / §6.2)", () => {
		it("auto-groups when namespace is recognized AND key matches models.dev", () => {
			const r = resolveLogicalModel({
				...baseArgs,
				modelsDevKeys: new Set(["claude-opus-4"]),
			});
			expect(r.logicalModel).toBe("claude-opus-4");
			expect(r.source).toBe("normalization");
		});

		it("auto-groups when key matches an already-confirmed cluster logical model", () => {
			const r = resolveLogicalModel({
				...baseArgs,
				provider: "bedrock",
				providerModelId: "us.anthropic.claude-opus-4-v1:0",
				confirmedLogicalKeys: new Set(["claude-opus-4"]),
			});
			expect(r.logicalModel).toBe("claude-opus-4");
			expect(r.source).toBe("normalization");
		});

		it("stays unassigned when the namespace is recognized but the key matches nothing", () => {
			const r = resolveLogicalModel({
				...baseArgs,
				modelsDevKeys: new Set(["some-other-model"]),
			});
			expect(r.logicalModel).toBeNull();
			expect(r.source).toBe("unassigned");
		});

		it("stays unassigned for an unqualified local openai-compatible tag (R-MC9 / acceptance)", () => {
			// An arbitrary gateway/local tag is not a recognized namespace: never
			// auto-pool, even if the bare key happened to match something.
			const r = resolveLogicalModel({
				...baseArgs,
				provider: "openai-compatible",
				providerModelId: "my-local-thing",
				confirmedLogicalKeys: new Set(["my-local-thing"]),
			});
			expect(r.logicalModel).toBeNull();
			expect(r.source).toBe("unassigned");
		});

		it("auto-groups a vendor-qualified openai-compatible tag that matches a confirmed model", () => {
			const r = resolveLogicalModel({
				...baseArgs,
				provider: "openai-compatible",
				providerModelId: "gpt-6.2-sol",
				confirmedLogicalKeys: new Set(["gpt-6-2-sol"]),
			});
			expect(r.logicalModel).toBe("gpt-6-2-sol");
			expect(r.source).toBe("normalization");
		});
	});
});

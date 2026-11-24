import { describe, expect, it } from "bun:test";
import {
	HINT_NORMALIZE_PROVIDER,
	type NormalizeKeyFn,
	hintMatchesAnyLogicalModel,
	hintMatchesLogicalModel,
	isValidModelRoleName,
	normalizeHintKey,
	resolveModelRoleTarget,
} from "../model-hint-match";
import type { ClusterModelRoles } from "../types";

/**
 * A stand-in for `@bound/llm`'s `normalizeModelKey` that captures the two rules
 * this helper actually depends on: canonicalize version dots to dashes and
 * lowercase. `@bound/shared` cannot import the real normalizer (it lives in
 * `@bound/llm`), so the matcher is tested against an injected fake that
 * reproduces the observable contract — the real wiring is exercised in the
 * agent/core suites that pass the genuine `normalizeModelKey`.
 */
const fakeNormalize: NormalizeKeyFn = (_provider, id) => ({
	key: id.replace(/(\d)\.(\d)/g, "$1-$2").toLowerCase(),
});

describe("model-hint-match", () => {
	it("passes the provider-agnostic argument to the injected normalizer", () => {
		let seenProvider = "";
		const spy: NormalizeKeyFn = (provider, id) => {
			seenProvider = provider;
			return { key: id };
		};
		normalizeHintKey("gpt-5.6-sol", spy);
		expect(seenProvider).toBe(HINT_NORMALIZE_PROVIDER);
	});

	it("matches an old hand-written id to the key an expanded backend advertises", () => {
		// `gpt-5.6-sol` and the expanded backend's logical_model `gpt-5-6-sol`
		// normalize to the same key.
		expect(hintMatchesLogicalModel("gpt-5.6-sol", "gpt-5-6-sol", fakeNormalize)).toBe(true);
	});

	it("matches a dashed-version hint against its canonicalized logical model", () => {
		expect(hintMatchesLogicalModel("gpt-5.4", "gpt-5-4", fakeNormalize)).toBe(true);
		expect(hintMatchesLogicalModel("kimi-k2.5", "kimi-k2-5", fakeNormalize)).toBe(true);
	});

	it('matches a literal config pin (logical_model: "opus") by a bare hint', () => {
		expect(hintMatchesLogicalModel("opus", "opus", fakeNormalize)).toBe(true);
	});

	it("does not match across different logical models", () => {
		expect(hintMatchesLogicalModel("gpt-5.6-sol", "gpt-5-6-terra", fakeNormalize)).toBe(false);
		expect(hintMatchesLogicalModel("opus-4.8", "opus-5-5", fakeNormalize)).toBe(false);
	});

	describe("hintMatchesAnyLogicalModel", () => {
		const live = new Set(["gpt-5-6-sol", "gpt-5-6-terra", "opus-4-8", "opus"]);

		it("finds a hint live via a normalized logical-model key", () => {
			expect(hintMatchesAnyLogicalModel("gpt-5.6-sol", live, fakeNormalize)).toBe(true);
			expect(hintMatchesAnyLogicalModel("opus-4.8", live, fakeNormalize)).toBe(true);
		});

		it("finds a hint live via a literal logical-model name", () => {
			expect(hintMatchesAnyLogicalModel("opus", live, fakeNormalize)).toBe(true);
		});

		it("reports a hint matching no advertised logical model as dead", () => {
			expect(hintMatchesAnyLogicalModel("gpt-9.9-nova", live, fakeNormalize)).toBe(false);
			expect(hintMatchesAnyLogicalModel("kimi-k2.5", live, fakeNormalize)).toBe(false);
		});
	});
});

describe("isValidModelRoleName", () => {
	it("accepts non-empty names free of the @ pin syntax", () => {
		expect(isValidModelRoleName("default")).toBe(true);
		expect(isValidModelRoleName("opus")).toBe(true);
		expect(isValidModelRoleName("gpt-5.6-sol")).toBe(true);
		expect(isValidModelRoleName("reviewer-model")).toBe(true);
	});

	it("rejects an empty name or one carrying the @ RouteId separator", () => {
		expect(isValidModelRoleName("")).toBe(false);
		expect(isValidModelRoleName("opus@site:p:opus")).toBe(false);
	});
});

describe("resolveModelRoleTarget", () => {
	const roles: ClusterModelRoles = { default: "opus", opus: "claude-opus-4-8", empty: "" };

	it("returns the logical model a role/alias names", () => {
		expect(resolveModelRoleTarget(roles, "default")).toBe("opus");
		expect(resolveModelRoleTarget(roles, "opus")).toBe("claude-opus-4-8");
	});

	it("returns null for a hint that is not a role/alias", () => {
		expect(resolveModelRoleTarget(roles, "gpt-5.6-sol")).toBeNull();
	});

	it("treats an empty-string target as absent", () => {
		expect(resolveModelRoleTarget(roles, "empty")).toBeNull();
	});
});

import { describe, expect, it } from "bun:test";
import { resolveToolAnnotations } from "../retry-policy";
import type { ToolAnnotations } from "../types";
type RegistryEntry = {
	resolveAnnotations?: (args: Record<string, unknown>) => ToolAnnotations;
} & ToolAnnotations;

describe("resolveToolAnnotations", () => {
	it("returns empty annotations for an unregistered tool", () => {
		const registry = new Map<string, RegistryEntry>();
		expect(resolveToolAnnotations(registry, "ghost", {})).toEqual({});
	});

	it("delegates to resolveAnnotations when the tool defines one", () => {
		const registry = new Map<string, RegistryEntry>([
			[
				"query",
				{
					resolveAnnotations: (args) => ({
						readOnly: String(args.sql ?? "").startsWith("SELECT"),
					}),
				},
			],
		]);
		expect(resolveToolAnnotations(registry, "query", { sql: "SELECT 1" })).toEqual({
			readOnly: true,
		});
		expect(resolveToolAnnotations(registry, "query", { sql: "DELETE FROM x" })).toEqual({
			readOnly: false,
		});
	});

	it("falls back to the static idempotent/readOnly flags when no resolver is present", () => {
		const registry = new Map<string, RegistryEntry>([
			["read", { readOnly: true, idempotent: true }],
		]);
		expect(resolveToolAnnotations(registry, "read", {})).toEqual({
			readOnly: true,
			idempotent: true,
		});
	});

	it("omits flags that are undefined on the static entry", () => {
		const registry = new Map<string, RegistryEntry>([["partial", { readOnly: true }]]);
		const result = resolveToolAnnotations(registry, "partial", {});
		expect(result).toEqual({ readOnly: true });
		expect("idempotent" in result).toBe(false);
	});
});

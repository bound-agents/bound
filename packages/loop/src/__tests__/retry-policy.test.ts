import { describe, expect, it } from "bun:test";
import {
	type RelayWaitLikeResult,
	resolveToolAnnotations,
	shouldRetryRelayCall,
} from "../retry-policy";
import type { ToolAnnotations } from "../types";

function waitResult(overrides: Partial<RelayWaitLikeResult> = {}): RelayWaitLikeResult {
	return { content: "timeout", retriable: true, ...overrides };
}

describe("shouldRetryRelayCall", () => {
	it("does not retry once aborted", () => {
		expect(
			shouldRetryRelayCall({
				waitResult: waitResult(),
				attempt: 0,
				maxAttempts: 3,
				aborted: true,
				annotations: { readOnly: true },
			}),
		).toBe(false);
	});

	it("does not retry at or past the attempt ceiling", () => {
		expect(
			shouldRetryRelayCall({
				waitResult: waitResult(),
				attempt: 3,
				maxAttempts: 3,
				aborted: false,
				annotations: { readOnly: true },
			}),
		).toBe(false);
	});

	it("does not retry a non-retriable wait result", () => {
		expect(
			shouldRetryRelayCall({
				waitResult: waitResult({ retriable: false }),
				attempt: 0,
				maxAttempts: 3,
				aborted: false,
				annotations: { readOnly: true },
			}),
		).toBe(false);
	});

	it("retries when the call definitely did not execute, even without annotations", () => {
		expect(
			shouldRetryRelayCall({
				waitResult: waitResult({ definitely_not_executed: true }),
				attempt: 0,
				maxAttempts: 3,
				aborted: false,
			}),
		).toBe(true);
	});

	it("retries a read-only tool", () => {
		expect(
			shouldRetryRelayCall({
				waitResult: waitResult(),
				attempt: 1,
				maxAttempts: 3,
				aborted: false,
				annotations: { readOnly: true },
			}),
		).toBe(true);
	});

	it("retries an idempotent tool", () => {
		expect(
			shouldRetryRelayCall({
				waitResult: waitResult(),
				attempt: 1,
				maxAttempts: 3,
				aborted: false,
				annotations: { idempotent: true },
			}),
		).toBe(true);
	});

	it("does not retry a retriable-but-unsafe tool (not read-only, not idempotent, may have run)", () => {
		expect(
			shouldRetryRelayCall({
				waitResult: waitResult(),
				attempt: 1,
				maxAttempts: 3,
				aborted: false,
				annotations: {},
			}),
		).toBe(false);
	});
});

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

import { describe, expect, it } from "bun:test";
import type { StreamChunk } from "../types";
import {
	type CacheFieldDecision,
	CacheFieldRecoveryState,
	type CacheFieldRejection,
	classifyCacheFieldRejection,
	isDurationTtl,
	withCacheFieldRecovery,
} from "./cache-field-recovery";
/** Build an APICallError-shaped error with a JSON responseBody (what mapError sees). */
function apiError(
	body: unknown,
	statusCode = 400,
): Error & { statusCode: number; responseBody: string } {
	const e = new Error("Bad Request") as Error & { statusCode: number; responseBody: string };
	e.statusCode = statusCode;
	e.responseBody = typeof body === "string" ? body : JSON.stringify(body);
	return e;
}

describe("classifyCacheFieldRejection", () => {
	it("detects a Mantle Responses ttl rejection and extracts the supported value", () => {
		// Live shape: Mantle rejects ttl:"12h" and lists the only supported value.
		const err = apiError({
			error: {
				type: "invalid_request_error",
				code: "invalid_value",
				param: "prompt_cache_options.ttl",
				message: "Invalid value: '12h'. Supported values are: '30m'.",
			},
		});
		const result = classifyCacheFieldRejection(err);
		expect(result).not.toBeNull();
		expect(result?.field).toBe("prompt_cache_options.ttl");
		expect(result?.supportedValue).toBe("30m");
	});

	it("detects an unsupported-parameter rejection naming prompt_cache_options", () => {
		// Live shape: gpt-5.4 rejects the whole option as unsupported on the model.
		const err = apiError({
			error: {
				code: "invalid_parameter",
				param: "prompt_cache_options",
				message: "prompt_cache_options is not supported on this model",
			},
		});
		const result = classifyCacheFieldRejection(err);
		expect(result).not.toBeNull();
		expect(result?.field).toBe("prompt_cache_options");
		expect(result?.supportedValue).toBeUndefined();
	});

	it("detects a breakpoint rejection naming prompt_cache_breakpoint", () => {
		const err = apiError({
			error: {
				code: "invalid_value",
				param: "prompt_cache_breakpoint",
				message: "prompt_cache_breakpoint is not supported",
			},
		});
		const result = classifyCacheFieldRejection(err);
		expect(result?.field).toBe("prompt_cache_breakpoint");
	});

	it("detects a cache_control rejection", () => {
		const err = apiError({
			error: { code: "invalid_value", param: "cache_control", message: "cache_control invalid" },
		});
		expect(classifyCacheFieldRejection(err)?.field).toBe("cache_control");
	});

	it("extracts a supported value even when the param lives only in the message", () => {
		// Some providers omit `param` and only name the field in the message text.
		const err = apiError({
			error: {
				message:
					"Invalid value for 'prompt_cache_options.ttl'. Supported values are: 'implicit' and 'explicit'.",
			},
		});
		const result = classifyCacheFieldRejection(err);
		expect(result?.field).toBe("prompt_cache_options.ttl");
		// Two supported values listed — the first is extracted as the candidate.
		expect(result?.supportedValue).toBe("implicit");
	});

	it("returns null for a non-cache 400 (a real request-shape error)", () => {
		const err = apiError({
			error: { code: "invalid_value", param: "temperature", message: "temperature out of range" },
		});
		expect(classifyCacheFieldRejection(err)).toBeNull();
	});

	it("returns null for a non-400 error even if it mentions a cache field", () => {
		const err = apiError(
			{ error: { param: "prompt_cache_options.ttl", message: "server error" } },
			500,
		);
		expect(classifyCacheFieldRejection(err)).toBeNull();
	});

	it("returns null for an error with no response body", () => {
		expect(classifyCacheFieldRejection(new Error("boom"))).toBeNull();
	});

	it("walks a RetryError wrapper to the lastError (AI SDK shape)", () => {
		const inner = apiError({
			error: {
				param: "prompt_cache_options.ttl",
				message: "Invalid value: '12h'. Supported values are: '30m'.",
			},
		});
		const wrapper = new Error("retry exhausted") as Error & { lastError: unknown };
		wrapper.lastError = inner;
		expect(classifyCacheFieldRejection(wrapper)?.supportedValue).toBe("30m");
	});

	it("detects an SDK-local InvalidArgumentError on the cache ttl field (#293)", () => {
		// ai-sdk/openai validates prompt_cache_options.ttl LOCALLY against a typed
		// literal: a rejected value throws AI_InvalidArgumentError before any request
		// is sent, so there is NO 400 and NO responseBody, only the SDK's own message
		// (invalid openai provider options) wrapping a TypeValidationError that names
		// the path. A guard requiring statusCode===400 would miss it and the route dies.
		const inner = new Error(
			"Type validation failed: Value at path [promptCacheOptions, ttl]: invalid option for prompt_cache_options.ttl",
		);
		const err = new Error("invalid openai provider options") as Error & { cause: unknown };
		(err as { name: string }).name = "AI_InvalidArgumentError";
		err.cause = inner;
		const result = classifyCacheFieldRejection(err);
		expect(result?.field).toBe("prompt_cache_options.ttl");
	});

	it("ignores an SDK-local InvalidArgumentError that names a non-cache field", () => {
		// A local validation failure on, e.g., temperature must NOT be mistaken for a
		// cache-field rejection; recovery would wrongly swallow a real argument bug.
		const inner = new Error("Type validation failed: Value at path [temperature]: out of range");
		const err = new Error("invalid openai provider options") as Error & { cause: unknown };
		(err as { name: string }).name = "AI_InvalidArgumentError";
		err.cause = inner;
		expect(classifyCacheFieldRejection(err)).toBeNull();
	});
});

describe("isDurationTtl", () => {
	it("accepts bare minute/hour duration strings", () => {
		expect(isDurationTtl("5m")).toBe(true);
		expect(isDurationTtl("1h")).toBe(true);
		expect(isDurationTtl("30m")).toBe(true);
		expect(isDurationTtl("24h")).toBe(true);
	});

	it("rejects modes, empty, and malformed values", () => {
		expect(isDurationTtl("implicit")).toBe(false);
		expect(isDurationTtl("explicit")).toBe(false);
		expect(isDurationTtl("")).toBe(false);
		expect(isDurationTtl("5")).toBe(false);
		expect(isDurationTtl("5s")).toBe(false);
		expect(isDurationTtl("m")).toBe(false);
		expect(isDurationTtl("5m1h")).toBe(false);
	});
});

describe("CacheFieldRecoveryState", () => {
	const ROUTE = "site-a:bedrock-mantle:openai.gpt-6-luna";
	const rejection = (field: string, supportedValue?: string): CacheFieldRejection => ({
		field,
		supportedValue,
	});

	it("defaults to no decision for an unseen route/field", () => {
		const state = new CacheFieldRecoveryState();
		expect(state.decisionFor(ROUTE, "prompt_cache_options.ttl")).toBeUndefined();
	});

	it("remembers a provider-listed supported value when the error lists a valid one", () => {
		const state = new CacheFieldRecoveryState();
		// The field accepts "30m" (per the provider); record the supported value.
		const outcome = state.record(ROUTE, rejection("prompt_cache_options.ttl", "30m"), {
			validValues: ["30m"],
		});
		expect(outcome).toEqual({ kind: "use-value", value: "30m" });
		expect(state.decisionFor(ROUTE, "prompt_cache_options.ttl")).toEqual({
			kind: "use-value",
			value: "30m",
		});
	});

	it("drops the field when the error lists no value", () => {
		const state = new CacheFieldRecoveryState();
		const outcome = state.record(ROUTE, rejection("prompt_cache_options"), {});
		expect(outcome).toEqual({ kind: "drop" });
		expect(state.decisionFor(ROUTE, "prompt_cache_options")).toEqual({ kind: "drop" });
	});

	it("drops the field when the provider-listed value is not a valid value for that field", () => {
		const state = new CacheFieldRecoveryState();
		// Copilot's Responses lists "implicit"/"explicit" for a ttl field — not a
		// valid ttl duration, so we drop rather than send a nonsense value.
		const outcome = state.record(ROUTE, rejection("prompt_cache_options.ttl", "implicit"), {
			validValues: ["5m", "1h", "30m"],
		});
		expect(outcome).toEqual({ kind: "drop" });
	});

	it("scopes decisions per route — one route's drop does not affect another", () => {
		const state = new CacheFieldRecoveryState();
		state.record(ROUTE, rejection("prompt_cache_options"), {});
		const other = "site-b:bedrock-mantle:openai.gpt-6-luna";
		expect(state.decisionFor(other, "prompt_cache_options")).toBeUndefined();
	});

	it("scopes decisions per field — a ttl drop does not drop breakpoints", () => {
		const state = new CacheFieldRecoveryState();
		state.record(ROUTE, rejection("prompt_cache_options.ttl"), {});
		expect(state.decisionFor(ROUTE, "prompt_cache_breakpoint")).toBeUndefined();
	});
});

describe("withCacheFieldRecovery", () => {
	const ROUTE = "site-a:anthropic:claude";

	/** A stream factory that yields a fixed sequence, recording how it was called. */
	function makeSource(outcomes: Array<StreamChunk[] | Error>) {
		const calls: Array<{ decision: CacheFieldDecision | undefined }> = [];
		let attempt = 0;
		const run = (decision: CacheFieldDecision | undefined): AsyncIterable<StreamChunk> => {
			const i = attempt++;
			calls.push({ decision });
			const outcome = outcomes[i];
			return (async function* () {
				if (outcome instanceof Error) throw outcome;
				for (const chunk of outcome ?? []) yield chunk;
			})();
		};
		return { run, calls };
	}

	const okChunk: StreamChunk = { type: "text", text: "hi" } as unknown as StreamChunk;

	async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
		const out: StreamChunk[] = [];
		for await (const c of stream) out.push(c);
		return out;
	}

	it("passes a clean stream through untouched, with no recorded decision", async () => {
		const state = new CacheFieldRecoveryState();
		const { run, calls } = makeSource([[okChunk]]);
		const out = await drain(
			withCacheFieldRecovery({
				routeId: ROUTE,
				state,
				fields: ["prompt_cache_options.ttl"],
				validValuesFor: () => ["5m", "1h", "30m"],
				run,
			}),
		);
		expect(out).toEqual([okChunk]);
		expect(calls).toHaveLength(1);
		expect(calls[0].decision).toBeUndefined();
	});

	it("retries once on a cache-field rejection, dropping the field, and succeeds", async () => {
		const state = new CacheFieldRecoveryState();
		const rejection = apiError({
			error: { message: "Invalid cache_control", param: "cache_control" },
		});
		const { run, calls } = makeSource([rejection, [okChunk]]);
		const out = await drain(
			withCacheFieldRecovery({
				routeId: ROUTE,
				state,
				fields: ["cache_control"],
				validValuesFor: () => [],
				run,
			}),
		);
		expect(out).toEqual([okChunk]);
		expect(calls).toHaveLength(2);
		expect(calls[0].decision).toBeUndefined();
		expect(calls[1].decision).toEqual({ kind: "drop" });
		// The outcome is remembered for the next request on this route.
		expect(state.decisionFor(ROUTE, "cache_control")).toEqual({ kind: "drop" });
	});

	it("retries with the provider-listed supported value when valid", async () => {
		const state = new CacheFieldRecoveryState();
		const rejection = apiError({
			error: {
				message: "prompt_cache_options.ttl invalid. Supported values are: '30m'",
				param: "prompt_cache_options.ttl",
			},
		});
		const { run, calls } = makeSource([rejection, [okChunk]]);
		const out = await drain(
			withCacheFieldRecovery({
				routeId: ROUTE,
				state,
				fields: ["prompt_cache_options.ttl"],
				validValuesFor: () => ["5m", "1h", "30m"],
				run,
			}),
		);
		expect(out).toEqual([okChunk]);
		expect(calls[1].decision).toEqual({ kind: "use-value", value: "30m" });
	});

	it("applies a remembered decision to the FIRST attempt (no second rejection needed)", async () => {
		const state = new CacheFieldRecoveryState();
		state.record(ROUTE, { field: "cache_control" }, {});
		const { run, calls } = makeSource([[okChunk]]);
		await drain(
			withCacheFieldRecovery({
				routeId: ROUTE,
				state,
				fields: ["cache_control"],
				validValuesFor: () => [],
				run,
			}),
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].decision).toEqual({ kind: "drop" });
	});

	it("rethrows a non-cache error unchanged and does not retry", async () => {
		const state = new CacheFieldRecoveryState();
		const boom = new Error("rate limited");
		const { run, calls } = makeSource([boom]);
		await expect(
			drain(
				withCacheFieldRecovery({
					routeId: ROUTE,
					state,
					fields: ["cache_control"],
					validValuesFor: () => [],
					run,
				}),
			),
		).rejects.toThrow("rate limited");
		expect(calls).toHaveLength(1);
	});

	it("does not retry a second time when the retry also rejects the field", async () => {
		const state = new CacheFieldRecoveryState();
		const rejection = apiError({ error: { param: "cache_control" } });
		const { run, calls } = makeSource([rejection, rejection, [okChunk]]);
		await expect(
			drain(
				withCacheFieldRecovery({
					routeId: ROUTE,
					state,
					fields: ["cache_control"],
					validValuesFor: () => [],
					run,
				}),
			),
		).rejects.toBeDefined();
		// One original + one retry = two attempts; the retry's rejection propagates.
		expect(calls).toHaveLength(2);
	});

	it("ignores a rejection naming a field this driver does not send", async () => {
		const state = new CacheFieldRecoveryState();
		// A ttl rejection reaches a driver that only declares `cache_control`.
		const rejection = apiError({ error: { param: "prompt_cache_options.ttl" } });
		const { run, calls } = makeSource([rejection]);
		await expect(
			drain(
				withCacheFieldRecovery({
					routeId: ROUTE,
					state,
					fields: ["cache_control"],
					validValuesFor: () => [],
					run,
				}),
			),
		).rejects.toBeDefined();
		expect(calls).toHaveLength(1);
	});
});

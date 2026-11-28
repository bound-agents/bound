import { describe, expect, it } from "bun:test";
import type { DriverFallbackSupport } from "../fallback-policy";
import type { ModelDeclinedOutcome } from "../model-declined";
import type { StreamChunk } from "../types";
import { type CreditRedemptionDriverConfig, redeemFallbackCredit } from "./credit-redemption";

/**
 * Tests for the driver-level inline credit-redemption EXECUTOR (slice 5,
 * R-RT18, 2026-11-21-model-routing.md §7.3 step 2). The pure planner
 * (`planCreditRedemption`) decides eligibility and the ordered step-down; this
 * executor walks that plan against a driver-supplied `runStep` callback,
 * stopping on the first non-refusal attempt, surfacing an error when billed
 * server tools already ran, and returning control (yielding the refusal
 * through) when the credit is not redeemable on this endpoint.
 */

const BEDROCK: DriverFallbackSupport = {
	server_side_auto: false,
	publishes_allowed_targets: false,
	supports_fallback_credit: true,
};

/** A done chunk carrying a classified refusal with a credit token. */
function refusalChunk(opts: {
	credit?: { token: string; endpoint: string; has_prefill_claim?: boolean };
	category?: string | null;
}): StreamChunk {
	const declined: ModelDeclinedOutcome = {
		kind: "model-declined",
		vendor: "anthropic",
		category: opts.category ?? null,
		raw_reason: "refusal",
		substitutable: (opts.category ?? null) !== "reasoning_extraction",
		...(opts.credit ? { credit: opts.credit } : {}),
	};
	return {
		type: "done",
		usage: {
			input_tokens: 10,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
		},
		finish_reason: "content-filter",
		declined,
	};
}

/** A clean, served done chunk (no refusal). */
function okChunk(): StreamChunk {
	return {
		type: "done",
		usage: {
			input_tokens: 10,
			output_tokens: 20,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
		},
		finish_reason: "stop",
	};
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
	const out: StreamChunk[] = [];
	for await (const c of stream) out.push(c);
	return out;
}

function lastDone(chunks: StreamChunk[]): Extract<StreamChunk, { type: "done" }> {
	const done = [...chunks].reverse().find((c) => c.type === "done");
	if (!done || done.type !== "done") throw new Error("no done chunk");
	return done;
}

describe("redeemFallbackCredit (driver-level inline credited retry, §7.3 step 2)", () => {
	it("replays a co-located Bedrock refusal with identical beta flags and unstripped thinking, stops on success", async () => {
		const seen: Array<{ kind: string; includeToken: boolean; stripThinking: boolean }> = [];
		async function* primary(): AsyncIterable<StreamChunk> {
			yield { type: "text", content: "" };
			yield refusalChunk({ credit: { token: "tok-1", endpoint: "ep-A" } });
		}
		const config: CreditRedemptionDriverConfig = {
			driver: BEDROCK,
			executingEndpoint: "ep-A",
			resolveTarget: () => ({ targetModel: "claude-fallback", targetEndpoint: "ep-A" }),
			serverToolsRan: () => false,
			runStep: (step) => {
				seen.push({
					kind: step.kind,
					includeToken: step.includeToken,
					stripThinking: step.stripThinking,
				});
				// The first continuation step succeeds.
				return (async function* () {
					yield okChunk();
				})();
			},
		};

		const chunks = await collect(redeemFallbackCredit(primary(), config));
		// The served turn's done chunk is the ok one, not the refusal.
		expect(lastDone(chunks).finish_reason).toBe("stop");
		// First step is the continuation body, carries the token, and never strips thinking.
		expect(seen[0]).toEqual({
			kind: "continuation-body",
			includeToken: true,
			stripThinking: false,
		});
		// Succeeded on the first step; no further step-down.
		expect(seen).toHaveLength(1);
	});

	it("walks the step-down order continuation → unchanged+token → drop-token when each step still refuses", async () => {
		const kinds: string[] = [];
		async function* primary(): AsyncIterable<StreamChunk> {
			yield refusalChunk({
				credit: { token: "tok-1", endpoint: "ep-A", has_prefill_claim: true },
			});
		}
		const config: CreditRedemptionDriverConfig = {
			driver: BEDROCK,
			executingEndpoint: "ep-A",
			resolveTarget: () => ({ targetModel: "fallback", targetEndpoint: "ep-A" }),
			serverToolsRan: () => false,
			runStep: (step) => {
				kinds.push(step.kind);
				// Every step refuses, so the walk exhausts the step-down.
				return (async function* () {
					yield refusalChunk({ category: "cyber" });
				})();
			},
		};

		const chunks = await collect(redeemFallbackCredit(primary(), config));
		expect(kinds).toEqual(["continuation-body", "unchanged-plus-token", "drop-token"]);
		// Final chunk is still a refusal (every step declined).
		expect(lastDone(chunks).declined?.kind).toBe("model-declined");
	});

	it("surfaces an error instead of retrying uncredited when server tools already ran", async () => {
		async function* primary(): AsyncIterable<StreamChunk> {
			yield refusalChunk({ credit: { token: "tok-1", endpoint: "ep-A" } });
		}
		let ran = false;
		const config: CreditRedemptionDriverConfig = {
			driver: BEDROCK,
			executingEndpoint: "ep-A",
			resolveTarget: () => ({ targetModel: "fallback", targetEndpoint: "ep-A" }),
			serverToolsRan: () => true,
			runStep: () => {
				ran = true;
				return (async function* () {
					yield okChunk();
				})();
			},
		};

		await expect(collect(redeemFallbackCredit(primary(), config))).rejects.toThrow(/server tool/i);
		expect(ran).toBe(false);
	});

	it("forfeits the credit (yields the refusal through) when the target is not co-located", async () => {
		async function* primary(): AsyncIterable<StreamChunk> {
			yield refusalChunk({ credit: { token: "tok-1", endpoint: "ep-A" } });
		}
		let ran = false;
		const config: CreditRedemptionDriverConfig = {
			driver: BEDROCK,
			executingEndpoint: "ep-A",
			resolveTarget: () => ({ targetModel: "fallback", targetEndpoint: "ep-B" }),
			serverToolsRan: () => false,
			runStep: () => {
				ran = true;
				return (async function* () {
					yield okChunk();
				})();
			},
		};

		const chunks = await collect(redeemFallbackCredit(primary(), config));
		// No inline retry attempted; the original refusal flows through for the
		// loop-host router to handle.
		expect(ran).toBe(false);
		expect(lastDone(chunks).declined?.credit?.endpoint).toBe("ep-A");
	});

	it("passes the refusal through unchanged when there is no credit token", async () => {
		async function* primary(): AsyncIterable<StreamChunk> {
			yield refusalChunk({ category: "cyber" });
		}
		let resolved = false;
		const config: CreditRedemptionDriverConfig = {
			driver: BEDROCK,
			executingEndpoint: "ep-A",
			resolveTarget: () => {
				resolved = true;
				return null;
			},
			serverToolsRan: () => false,
			runStep: () => (async function* () {})(),
		};

		const chunks = await collect(redeemFallbackCredit(primary(), config));
		expect(lastDone(chunks).declined?.category).toBe("cyber");
		// No token → never even resolve a target.
		expect(resolved).toBe(false);
	});

	it("passes a clean (non-refusal) stream straight through with no plan consulted", async () => {
		async function* primary(): AsyncIterable<StreamChunk> {
			yield { type: "text", content: "hello" };
			yield okChunk();
		}
		let resolved = false;
		const config: CreditRedemptionDriverConfig = {
			driver: BEDROCK,
			executingEndpoint: "ep-A",
			resolveTarget: () => {
				resolved = true;
				return null;
			},
			serverToolsRan: () => false,
			runStep: () => (async function* () {})(),
		};

		const chunks = await collect(redeemFallbackCredit(primary(), config));
		expect(resolved).toBe(false);
		expect(lastDone(chunks).finish_reason).toBe("stop");
	});

	it("retries the same step with the same token on a transient redemption error", async () => {
		const kinds: string[] = [];
		let attempt = 0;
		async function* primary(): AsyncIterable<StreamChunk> {
			yield refusalChunk({
				credit: { token: "tok-1", endpoint: "ep-A", has_prefill_claim: true },
			});
		}
		const config: CreditRedemptionDriverConfig = {
			driver: BEDROCK,
			executingEndpoint: "ep-A",
			resolveTarget: () => ({ targetModel: "fallback", targetEndpoint: "ep-A" }),
			serverToolsRan: () => false,
			runStep: (step) => {
				kinds.push(step.kind);
				attempt++;
				// First continuation attempt throws a transient error; the SAME step
				// retries within the window and then succeeds.
				if (attempt === 1) {
					// biome-ignore lint/correctness/useYield: an async generator that throws before yielding is the transient-failure shape under test.
					return (async function* (): AsyncIterable<StreamChunk> {
						throw new Error("redemption temporarily unavailable");
					})();
				}
				return (async function* () {
					yield okChunk();
				})();
			},
		};

		const chunks = await collect(redeemFallbackCredit(primary(), config));
		expect(lastDone(chunks).finish_reason).toBe("stop");
		// Same continuation step ran twice (transient retry), never stepping down.
		expect(kinds).toEqual(["continuation-body", "continuation-body"]);
	});

	describe("served-attempt provenance", () => {
		function configFor(
			stepOutcome: (step: { kind: string; includeToken: boolean }) => StreamChunk,
		): CreditRedemptionDriverConfig {
			return {
				driver: BEDROCK,
				executingEndpoint: "ep-A",
				resolveTarget: () => ({ targetModel: "claude-fallback", targetEndpoint: "ep-A" }),
				serverToolsRan: () => false,
				runStep: (step) =>
					(async function* () {
						yield stepOutcome(step);
					})(),
			};
		}
		async function* creditedPrimary(): AsyncIterable<StreamChunk> {
			yield refusalChunk({
				credit: { token: "tok-1", endpoint: "ep-A", has_prefill_claim: true },
			});
		}

		it("stamps served_model and credit_redeemed: true on a credited served step", async () => {
			const chunks = await collect(
				redeemFallbackCredit(
					creditedPrimary(),
					configFor(() => okChunk()),
				),
			);
			const done = chunks.filter((c) => c.type === "done");
			expect(done).toHaveLength(2);
			// The refused primary attempt is untouched.
			expect(done[0]).not.toHaveProperty("served_model");
			expect(lastDone(chunks)).toMatchObject({
				finish_reason: "stop",
				served_model: "claude-fallback",
				credit_redeemed: true,
			});
		});

		it("stamps credit_redeemed: false on a drop-token step that serves uncredited", async () => {
			const chunks = await collect(
				redeemFallbackCredit(
					creditedPrimary(),
					configFor((step) =>
						step.kind === "drop-token" ? okChunk() : refusalChunk({ category: "cyber" }),
					),
				),
			);
			expect(lastDone(chunks)).toMatchObject({
				finish_reason: "stop",
				served_model: "claude-fallback",
				credit_redeemed: false,
			});
		});

		it("stamps credit_redeemed: false on the terminal refusal when the step-down exhausts", async () => {
			const chunks = await collect(
				redeemFallbackCredit(
					creditedPrimary(),
					configFor(() => refusalChunk({ category: "cyber" })),
				),
			);
			const done = lastDone(chunks);
			expect(done.declined?.kind).toBe("model-declined");
			expect(done).toMatchObject({ served_model: "claude-fallback", credit_redeemed: false });
		});
	});
});

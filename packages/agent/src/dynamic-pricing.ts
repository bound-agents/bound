import { setInterruptBudget } from "@bound/core";
import RELEASE_SYNC from "@jitl/quickjs-singlefile-cjs-release-sync";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";

export interface DynamicPriceInput {
	modelId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/**
	 * The 1h-TTL subset of `cacheWriteTokens` (the remainder is billed at the
	 * 5m rate). 0 when the split is unknown or absent — callers that ignore it
	 * compute exactly what they did before this field existed.
	 */
	cacheWrite1hTokens: number;
	pricesPerM: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		/** Per-M price for the 1h cache-write subset; falls back to `cacheWrite`. */
		cacheWrite1h: number;
	};
}

export interface PriceFunctionBackend {
	id: string;
	priceFunction?: string;
}

const MEMORY_LIMIT_BYTES = 8 * 1024 * 1024;
const STACK_LIMIT_BYTES = 256 * 1024;

let quickJS: QuickJSWASMModule | null = null;
let activeSources = new Map<string, string>();

const HARDENING_SOURCE = `
	delete globalThis.Date;
	Math.random = function () { throw new Error("randomness disabled"); };
	for (const name of ["Object","Array","Function","String","Number","Boolean","Math","JSON","RegExp","Error","TypeError","RangeError","Map","Set","Promise","Reflect","Proxy"]) {
		const value = globalThis[name];
		if (value && (typeof value === "object" || typeof value === "function")) {
			try { if (value.prototype) Object.freeze(value.prototype); } catch {}
			try { Object.freeze(value); } catch {}
		}
	}
`;

async function loadQuickJS(): Promise<QuickJSWASMModule> {
	quickJS ??= await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
	return quickJS;
}

/** A price(turn) callback may return a plain number (total USD) or an object
 * with the four component parts in USD (the total is their sum). */
interface DynamicPriceBreakdown {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface EvaluatedPrice {
	value: number;
	breakdown: DynamicPriceBreakdown | null;
}

function isFiniteNonNegative(n: unknown): n is number {
	return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function evaluate(
	module: QuickJSWASMModule,
	source: string,
	input: DynamicPriceInput,
): EvaluatedPrice {
	const runtime = module.newRuntime();
	runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
	runtime.setMaxStackSize(STACK_LIMIT_BYTES);
	setInterruptBudget(runtime);
	const vm = runtime.newContext();
	try {
		const result = vm.evalCode(
			`(() => {
				"use strict";
				${HARDENING_SOURCE}
				const price = (${source.replace(/^function\s+[^ (]+/, "function")});
				if (typeof price !== "function") throw new Error("price callback must evaluate to a function");
				return price(Object.freeze(${JSON.stringify(input)}));
			})()`,
			"price-function.js",
		);
		if (result.error) {
			const dumped = vm.dump(result.error) as unknown;
			result.error.dispose();
			throw new Error(
				dumped !== null && typeof dumped === "object" && "message" in dumped
					? String((dumped as { message: unknown }).message)
					: String(dumped),
			);
		}
		const value = vm.dump(result.value) as unknown;
		result.value.dispose();
		// Plain-number return: today's behavior, no component split.
		if (isFiniteNonNegative(value)) {
			return { value, breakdown: null };
		}
		// Object return: the four parts must each be finite non-negative; the
		// total is their sum. Any missing/invalid part is a hard error so a
		// malformed callback never silently under-reports cost.
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			const o = value as Record<string, unknown>;
			if (
				isFiniteNonNegative(o.input) &&
				isFiniteNonNegative(o.output) &&
				isFiniteNonNegative(o.cacheRead) &&
				isFiniteNonNegative(o.cacheWrite)
			) {
				const breakdown: DynamicPriceBreakdown = {
					input: o.input,
					output: o.output,
					cacheRead: o.cacheRead,
					cacheWrite: o.cacheWrite,
				};
				return {
					value: breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite,
					breakdown,
				};
			}
		}
		throw new Error(
			"price callback must return a finite non-negative number, or an object with finite non-negative input/output/cacheRead/cacheWrite",
		);
	} finally {
		vm.dispose();
		runtime.dispose();
	}
}

function sampleInput(modelId: string): DynamicPriceInput {
	return {
		modelId,
		inputTokens: 1,
		outputTokens: 1,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cacheWrite1hTokens: 0,
		pricesPerM: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
	};
}

/**
 * Compile/validate all configured functions before atomically publishing the
 * next registry. A syntax/sample failure leaves the previous registry intact.
 */
export async function compileDynamicPricing(backends: PriceFunctionBackend[]): Promise<void> {
	const module = await loadQuickJS();
	const next = new Map<string, string>();
	for (const backend of backends) {
		if (!backend.priceFunction) continue;
		evaluate(module, backend.priceFunction, sampleInput(backend.id));
		next.set(backend.id, backend.priceFunction);
	}
	activeSources = next;
}

/** Synchronous hot-path evaluation over the registry published at startup/reload. */
export type DynamicPriceResult =
	| { value: number; error: null; breakdown?: DynamicPriceBreakdown }
	| { value: null; error: string };

export function calculateDynamicPrice(
	modelId: string,
	input: DynamicPriceInput,
): DynamicPriceResult | null {
	const source = activeSources.get(modelId);
	if (!source || !quickJS) return null;
	try {
		const evaluated = evaluate(quickJS, source, input);
		return evaluated.breakdown
			? { value: evaluated.value, error: null, breakdown: evaluated.breakdown }
			: { value: evaluated.value, error: null };
	} catch (error) {
		return {
			value: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * True when a compiled price(turn) callback is active for this model. Used by
 * the cost-precedence helper to decide whether the operator has declared
 * explicit pricing (which wins over a provider-reported cost).
 */
export function hasDynamicPrice(modelId: string): boolean {
	return activeSources.has(modelId);
}

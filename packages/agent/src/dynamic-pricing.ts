import RELEASE_SYNC from "@jitl/quickjs-singlefile-cjs-release-sync";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";

export interface DynamicPriceInput {
	modelId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	pricesPerM: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

export interface PriceFunctionBackend {
	id: string;
	price_function?: string;
}

const MEMORY_LIMIT_BYTES = 8 * 1024 * 1024;
const STACK_LIMIT_BYTES = 256 * 1024;
const CPU_LIMIT_MS = 50;

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

function evaluate(module: QuickJSWASMModule, source: string, input: DynamicPriceInput): number {
	const runtime = module.newRuntime();
	runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
	runtime.setMaxStackSize(STACK_LIMIT_BYTES);
	const deadline = Date.now() + CPU_LIMIT_MS;
	runtime.setInterruptHandler(() => Date.now() > deadline);
	const vm = runtime.newContext();
	try {
		const result = vm.evalCode(
			`(() => {
				"use strict";
				${HARDENING_SOURCE}
				const price = (${source});
				if (typeof price !== "function") throw new Error("price_function must evaluate to a function");
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
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new Error("price_function must return a finite non-negative number");
		}
		return value;
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
		pricesPerM: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
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
		if (!backend.price_function) continue;
		evaluate(module, backend.price_function, sampleInput(backend.id));
		next.set(backend.id, backend.price_function);
	}
	activeSources = next;
}

/** Synchronous hot-path evaluation over the registry published at startup/reload. */
export function calculateDynamicPrice(modelId: string, input: DynamicPriceInput): number | null {
	const source = activeSources.get(modelId);
	if (!source || !quickJS) return null;
	try {
		return evaluate(quickJS, source, input);
	} catch {
		return null;
	}
}

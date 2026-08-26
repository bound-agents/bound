import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expandEnvVars, loadConfigWithPrecedence } from "@bound/core";
import { modelBackendsSchema } from "@bound/shared";
import type { ModelBackendsConfig } from "@bound/shared";
import RELEASE_SYNC from "@jitl/quickjs-singlefile-cjs-release-sync";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { compileDynamicPricing } from "./dynamic-pricing";

const MEMORY_LIMIT_BYTES = 8 * 1024 * 1024;
const STACK_LIMIT_BYTES = 256 * 1024;
// Interrupt deadline for one config evaluation. WALL-CLOCK, not CPU time:
// Date.now() advances while the process is descheduled, so on a contended
// ~2-core CI runner a healthy config eval doing microseconds of real work
// blows past a tight deadline and fails startup with "error: interrupted" —
// the cli startup-wiring test failed exactly this way on macOS lanes (runs
// 32892293787, 32894781301, 32911204557) while passing locally every time.
// Same fix as dynamic-pricing.ts (9935abdf): the limit exists to bound a
// runaway config script, not to assert a performance budget.
const CPU_LIMIT_MS = 1000;

let quickJS: Promise<QuickJSWASMModule> | undefined;

export type LoadedModelBackendsConfig = ModelBackendsConfig;

type EvaluatedPricing = Array<boolean>;

function getQuickJS(): Promise<QuickJSWASMModule> {
	quickJS ??= newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
	return quickJS;
}

function errorMessage(value: unknown): string {
	if (value !== null && typeof value === "object" && "message" in value) {
		return String(value.message);
	}
	return String(value);
}

async function loadDynamicPriceFunctions(source: string): Promise<Array<string | undefined>> {
	const runtime = (await getQuickJS()).newRuntime();
	runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
	runtime.setMaxStackSize(STACK_LIMIT_BYTES);
	const deadline = Date.now() + CPU_LIMIT_MS;
	runtime.setInterruptHandler(() => Date.now() > deadline);
	const vm = runtime.newContext();
	try {
		// Dynamic prices are evaluated afresh in the hardened pricing VM. Keep the
		// complete module body there so callbacks retain config-module helpers.
		const body = source.replace(/\bexport\s+default\s+/, "const config =");
		const result = vm.evalCode(
			`(() => {
				"use strict";
				${body}
				if (!config || typeof config !== "object" || !Array.isArray(config.backends)) {
					throw new Error("model_backends.js export must contain a backends array");
				}
				return config.backends.map((backend, index) => {
					if (!backend || typeof backend !== "object") return false;
					for (const [key, value] of Object.entries(backend)) {
						if (typeof value === "function" && key !== "price") {
							throw new Error("only backend.price may be a function");
						}
					}
					if (backend.price !== undefined && typeof backend.price !== "function") {
						throw new Error(\`backend[\${index}].price must be a function\`);
					}
					return backend.price !== undefined;
				});
			})()`,
			"model_backends.js",
		);
		if (result.error) {
			const error = vm.dump(result.error);
			result.error.dispose();
			throw new Error(errorMessage(error));
		}
		const hasPrice = vm.dump(result.value) as EvaluatedPricing;
		result.value.dispose();
		return hasPrice.map((present, index) =>
			present
				? `(() => { "use strict"; ${body}\nreturn config.backends[${index}].price; })()`
				: undefined,
		);
	} finally {
		vm.dispose();
		runtime.dispose();
	}
}

export async function loadModelBackendsConfig(
	configDir: string,
): Promise<LoadedModelBackendsConfig> {
	const jsPath = join(configDir, "model_backends.js");
	const result = await loadConfigWithPrecedence(configDir, "model_backends", modelBackendsSchema);
	if (!result.ok) {
		// Preserve source-level policy errors (functions other than backend.price)
		// which QuickJS serialization would otherwise erase before schema validation.
		if (existsSync(jsPath))
			await loadDynamicPriceFunctions(expandEnvVars(readFileSync(jsPath, "utf8")));
		throw new Error(`${result.error.filename}: ${result.error.message}`);
	}
	const priceFunctions = existsSync(jsPath)
		? await loadDynamicPriceFunctions(expandEnvVars(readFileSync(jsPath, "utf8")))
		: [];
	await compileDynamicPricing(
		result.value.backends.map((backend, index) => ({
			id: backend.id,
			priceFunction: priceFunctions[index],
		})),
	);
	return result.value;
}

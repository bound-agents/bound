import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expandEnvVars, loadConfigWithPrecedence, setInterruptBudget } from "@bound/core";
import { modelBackendsSchema } from "@bound/shared";
import type { ModelBackendsConfig } from "@bound/shared";
import RELEASE_SYNC from "@jitl/quickjs-singlefile-cjs-release-sync";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { compileDynamicPricing } from "./dynamic-pricing";

const MEMORY_LIMIT_BYTES = 8 * 1024 * 1024;
const STACK_LIMIT_BYTES = 256 * 1024;

let quickJS: Promise<QuickJSWASMModule> | undefined;

export type LoadedModelBackendsConfig = ModelBackendsConfig;

/** Per-backend result of the pricing-policy walk: whether the top-level
 * `price` is a function, and which `model_overrides` keys carry a `price`. */
type WalkedPricing = Array<{ hasPrice: boolean; overridePriceKeys: string[] }>;

/**
 * One compiled price-function source plus the coordinates needed to key it in
 * the pricing registry: `index` is the backend's position in `config.backends`,
 * and `overrideKey` is the `model_overrides` key (undefined for the top-level
 * per-backend `price`). The loader turns `(index, overrideKey)` into the
 * registry id — the backend id for a top-level price, the EXPANDED backend id
 * `${backend.id}-${overrideKey}` for a per-model override (the same id a
 * self-configuring namespace mints for its per-model backends, requirement 6).
 * A JSON config carries no functions, so this list is empty for `.json`.
 */
interface CompiledPriceFunction {
	index: number;
	overrideKey: string | undefined;
	source: string;
}

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

async function loadDynamicPriceFunctions(source: string): Promise<CompiledPriceFunction[]> {
	const runtime = (await getQuickJS()).newRuntime();
	runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
	runtime.setMaxStackSize(STACK_LIMIT_BYTES);
	setInterruptBudget(runtime);
	const vm = runtime.newContext();
	try {
		// Dynamic prices are evaluated afresh in the hardened pricing VM. Keep the
		// complete module body there so callbacks retain config-module helpers.
		const body = source.replace(/\bexport\s+default\s+/, "const config =");
		// Walk every backend, enforcing the function policy (only `price` and
		// `model_overrides[*].price` may be functions) and reporting, per backend,
		// whether the top-level `price` is present and which `model_overrides` keys
		// carry a `price`. The loader turns those flags into per-id source strings.
		const result = vm.evalCode(
			`(() => {
				"use strict";
				${body}
				if (!config || typeof config !== "object" || !Array.isArray(config.backends)) {
					throw new Error("model_backends.js export must contain a backends array");
				}
				return config.backends.map((backend, index) => {
					if (!backend || typeof backend !== "object") return { hasPrice: false, overridePriceKeys: [] };
					for (const [key, value] of Object.entries(backend)) {
						if (typeof value === "function" && key !== "price") {
							throw new Error("only backend.price or a model_overrides[*].price may be a function");
						}
					}
					if (backend.price !== undefined && typeof backend.price !== "function") {
						throw new Error(\`backend[\${index}].price must be a function\`);
					}
					const overridePriceKeys = [];
					const overrides = backend.model_overrides;
					if (overrides !== undefined) {
						if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
							throw new Error(\`backend[\${index}].model_overrides must be an object\`);
						}
						for (const [modelId, override] of Object.entries(overrides)) {
							if (!override || typeof override !== "object") continue;
							for (const [key, value] of Object.entries(override)) {
								if (typeof value === "function" && key !== "price") {
									throw new Error("only backend.price or a model_overrides[*].price may be a function");
								}
							}
							if (override.price !== undefined) {
								if (typeof override.price !== "function") {
									throw new Error(\`backend[\${index}].model_overrides[\${JSON.stringify(modelId)}].price must be a function\`);
								}
								overridePriceKeys.push(modelId);
							}
						}
					}
					return { hasPrice: backend.price !== undefined, overridePriceKeys };
				});
			})()`,
			"model_backends.js",
		);
		if (result.error) {
			const error = vm.dump(result.error);
			result.error.dispose();
			throw new Error(errorMessage(error));
		}
		const walked = vm.dump(result.value) as WalkedPricing;
		result.value.dispose();
		const compiled: CompiledPriceFunction[] = [];
		walked.forEach((entry, index) => {
			if (entry.hasPrice) {
				compiled.push({
					index,
					overrideKey: undefined,
					source: `(() => { "use strict"; ${body}\nreturn config.backends[${index}].price; })()`,
				});
			}
			for (const overrideKey of entry.overridePriceKeys) {
				compiled.push({
					index,
					overrideKey,
					source: `(() => { "use strict"; ${body}\nreturn config.backends[${index}].model_overrides[${JSON.stringify(overrideKey)}].price; })()`,
				});
			}
		});
		return compiled;
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
	// Key each compiled price source by the pricing-registry id it must resolve
	// under on the hot path: the backend id for a top-level per-backend `price`,
	// the expanded `${backend.id}-${overrideKey}` for a `model_overrides[*].price`
	// (the id a self-configuring namespace mints per model, requirement 6).
	await compileDynamicPricing(
		priceFunctions.map((fn) => {
			const backend = result.value.backends[fn.index];
			const id = fn.overrideKey === undefined ? backend?.id : `${backend?.id}-${fn.overrideKey}`;
			return { id: id ?? "", priceFunction: fn.source };
		}),
	);
	return result.value;
}

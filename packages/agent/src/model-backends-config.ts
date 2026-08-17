import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfigWithPrecedence } from "@bound/core";
import { modelBackendsSchema } from "@bound/shared";
import type { ModelBackendsConfig } from "@bound/shared";
import RELEASE_SYNC from "@jitl/quickjs-singlefile-cjs-release-sync";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { compileDynamicPricing } from "./dynamic-pricing";

const MEMORY_LIMIT_BYTES = 8 * 1024 * 1024;
const STACK_LIMIT_BYTES = 256 * 1024;
const CPU_LIMIT_MS = 50;

let quickJS: Promise<QuickJSWASMModule> | undefined;

export type LoadedModelBackendsConfig = ModelBackendsConfig;

type EvaluatedPricing = Array<string | undefined>;

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

async function loadDynamicPriceFunctions(source: string): Promise<EvaluatedPricing> {
	const runtime = (await getQuickJS()).newRuntime();
	runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
	runtime.setMaxStackSize(STACK_LIMIT_BYTES);
	const deadline = Date.now() + CPU_LIMIT_MS;
	runtime.setInterruptHandler(() => Date.now() > deadline);
	const vm = runtime.newContext();
	try {
		const body = source.replace(/^\s*export\s+default\s+/, "return (").replace(/;?\s*$/, ");");
		const result = vm.evalCode(
			`(() => {
				"use strict";
				const config = (() => { ${body} })();
				if (!config || typeof config !== "object" || !Array.isArray(config.backends)) {
					throw new Error("model_backends.js export must contain a backends array");
				}
				return config.backends.map((backend, index) => {
					if (!backend || typeof backend !== "object") return undefined;
					for (const [key, value] of Object.entries(backend)) {
						if (typeof value === "function" && key !== "price") {
							throw new Error("only backend.price may be a function");
						}
					}
					if (backend.price !== undefined && typeof backend.price !== "function") {
						throw new Error(\`backend[\${index}].price must be a function\`);
					}
					return backend.price === undefined ? undefined : "function " + backend.price.toString();
				});
			})()`,
			"model_backends.js",
		);
		if (result.error) {
			const error = vm.dump(result.error);
			result.error.dispose();
			throw new Error(errorMessage(error));
		}
		const value = vm.dump(result.value) as EvaluatedPricing;
		result.value.dispose();
		return value;
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
		if (existsSync(jsPath)) await loadDynamicPriceFunctions(readFileSync(jsPath, "utf8"));
		throw new Error(`${result.error.filename}: ${result.error.message}`);
	}
	const priceFunctions = existsSync(jsPath)
		? await loadDynamicPriceFunctions(readFileSync(jsPath, "utf8"))
		: [];
	await compileDynamicPricing(
		result.value.backends.map((backend, index) => ({
			id: backend.id,
			priceFunction: priceFunctions[index],
		})),
	);
	return result.value;
}

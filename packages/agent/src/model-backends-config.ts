import { readFileSync } from "node:fs";
import { join } from "node:path";
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

type EvaluatedConfig = {
	staticConfig: unknown;
	priceFunctions: Array<string | undefined>;
};

function expandEnvVars(value: string): string {
	return value.replace(/\$\{([^:}]+)(?::-([^}]*))?\}/g, (_match, varName, defaultValue) => {
		const environmentValue = process.env[varName];
		if (environmentValue !== undefined) return environmentValue;
		if (defaultValue !== undefined) return defaultValue;
		throw new Error(`Environment variable ${varName} is not defined and no default provided`);
	});
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

function evaluateConfig(module: QuickJSWASMModule, source: string): EvaluatedConfig {
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
				const config = (() => { ${source.replace(/^\s*export\s+default\s+/, "return (").replace(/;?\s*$/, ");")} })();
				if (!config || typeof config !== "object") throw new Error("model_backends.js must export an object");
				if (!Array.isArray(config.backends)) throw new Error("model_backends.js export must contain a backends array");
				const priceFunctions = config.backends.map((backend, index) => {
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
				for (const [key, value] of Object.entries(config)) {
					if (key !== "backends" && typeof value === "function") {
						throw new Error("only backend.price may be a function");
					}
				}
				const staticConfig = { ...config, backends: config.backends.map(({ price, ...backend }) => backend) };
				return { staticConfig, priceFunctions };
			})()`,
			"model_backends.js",
		);
		if (result.error) {
			const error = vm.dump(result.error);
			result.error.dispose();
			throw new Error(errorMessage(error));
		}
		const value = vm.dump(result.value) as EvaluatedConfig;
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
	const source = expandEnvVars(readFileSync(join(configDir, "model_backends.js"), "utf8"));
	const { staticConfig, priceFunctions } = evaluateConfig(await getQuickJS(), source);
	const parsed = modelBackendsSchema.parse(staticConfig) as LoadedModelBackendsConfig;
	await compileDynamicPricing(
		parsed.backends.map((backend, index) => ({
			id: backend.id,
			priceFunction: priceFunctions[index],
		})),
	);
	return parsed;
}

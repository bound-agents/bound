import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AllowlistConfig, ModelBackendsConfig } from "@bound/shared";
import {
	type RelayConfig,
	type Result,
	type SyncConfig,
	err,
	keyringSchema,
	mcpSchema,
	memoryConfigSchema,
	networkSchema,
	ok,
	platformsSchema,
	relaySchema,
	syncSchema,
} from "@bound/shared";
import RELEASE_SYNC from "@jitl/quickjs-singlefile-cjs-release-sync";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { setInterruptBudget } from "./quickjs-interrupt-budget";

const JS_CONFIG_MEMORY_LIMIT_BYTES = 8 * 1024 * 1024;
const JS_CONFIG_STACK_LIMIT_BYTES = 256 * 1024;
let quickJS: Promise<QuickJSWASMModule> | undefined;

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

async function evaluateJavaScriptConfig(source: string, filename: string): Promise<unknown> {
	const runtime = (await getQuickJS()).newRuntime();
	runtime.setMemoryLimit(JS_CONFIG_MEMORY_LIMIT_BYTES);
	runtime.setMaxStackSize(JS_CONFIG_STACK_LIMIT_BYTES);
	setInterruptBudget(runtime);
	const vm = runtime.newContext();
	try {
		const body = source.replace(/\bexport\s+default\s+/, "return (").replace(/;?\s*$/, ");");
		const result = vm.evalCode(
			`(() => { "use strict"; const config = (() => { ${body} })(); if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("${filename} must export an object"); return config; })()`,
			filename,
		);
		if (result.error) {
			const error = vm.dump(result.error);
			result.error.dispose();
			throw new Error(errorMessage(error));
		}
		const value = vm.dump(result.value);
		result.value.dispose();
		return value;
	} finally {
		vm.dispose();
		runtime.dispose();
	}
}

export interface ConfigError {
	filename: string;
	message: string;
	fieldErrors: Record<string, string[]>;
	/** Set when neither the `.js` nor the `.json` file exists. */
	notFound?: boolean;
}

// Duck-typed so core does not import zod directly
interface ZodSchema<T> {
	safeParse(data: unknown): ZodSafeParseResult<T>;
}

interface ZodSafeParseResult<T> {
	success: boolean;
	data?: T;
	error?: {
		message: string;
		flatten(): {
			fieldErrors?: Record<string, (string | undefined)[] | undefined>;
		};
	};
}

export type RequiredConfig = {
	allowlist: AllowlistConfig;
	modelBackends: ModelBackendsConfig;
};

export type OptionalConfigs = Record<string, Result<Record<string, unknown>, ConfigError>>;

export function resolveRelayConfig(syncConfig: SyncConfig | undefined): RelayConfig {
	if (!syncConfig?.relay) {
		return relaySchema.parse({});
	}
	return syncConfig.relay;
}

export function expandEnvVars(value: string): string {
	return value.replace(/\$\{([^:}]+)(?::-([^}]*))?\}/g, (_match, varName, defaultVal) => {
		const envValue = process.env[varName];
		if (envValue !== undefined) {
			return envValue;
		}
		if (defaultVal !== undefined) {
			return defaultVal;
		}
		throw new Error(`Environment variable ${varName} is not defined and no default provided`);
	});
}

function expandEnvVarsInObject(obj: unknown): unknown {
	if (typeof obj === "string") {
		return expandEnvVars(obj);
	}
	if (Array.isArray(obj)) {
		return obj.map(expandEnvVarsInObject);
	}
	if (obj !== null && typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = expandEnvVarsInObject(value);
		}
		return result;
	}
	return obj;
}

function validateConfig<T>(
	filename: string,
	schema: ZodSchema<T>,
	config: unknown,
): Result<T, ConfigError> {
	const result = schema.safeParse(config);
	if (result.success && result.data !== undefined) return ok(result.data);

	const fieldErrors: Record<string, string[]> = {};
	if (result.error) {
		for (const [field, errors] of Object.entries(result.error.flatten().fieldErrors ?? {})) {
			fieldErrors[field] = (errors as string[]) || [];
		}
		return err({
			filename,
			message: `Validation failed: ${result.error.message}`,
			fieldErrors,
		});
	}
	return err({ filename, message: "Validation failed: unknown error", fieldErrors });
}

export async function loadConfigWithPrecedence<T>(
	configDir: string,
	basename: string,
	schema: ZodSchema<T>,
): Promise<Result<T, ConfigError>> {
	const jsFilename = `${basename}.js`;
	const jsonFilename = `${basename}.json`;
	if (!existsSync(join(configDir, jsFilename))) {
		return loadConfigFile(configDir, jsonFilename, schema);
	}

	try {
		// Env references are expanded in the evaluated string values only. Expanding the
		// raw source would treat JavaScript template literals (`id-${x}`) as env refs.
		const source = readFileSync(join(configDir, jsFilename), "utf-8");
		const evaluated = await evaluateJavaScriptConfig(source, jsFilename);
		return validateConfig(jsFilename, schema, expandEnvVarsInObject(evaluated));
	} catch (error) {
		return err({
			filename: jsFilename,
			message:
				error instanceof Error ? error.message : "Unknown error loading JavaScript config file",
			fieldErrors: {},
		});
	}
}

export function loadConfigFile<T>(
	configDir: string,
	filename: string,
	schema: ZodSchema<T>,
): Result<T, ConfigError> {
	const path = join(configDir, filename);
	if (!existsSync(path)) {
		return err({
			filename,
			message: `File not found: ${path}`,
			fieldErrors: {},
			notFound: true,
		});
	}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return validateConfig(filename, schema, expandEnvVarsInObject(parsed));
	} catch (error) {
		return err({
			filename,
			message:
				error instanceof SyntaxError
					? `Invalid JSON: ${error.message}`
					: error instanceof Error
						? error.message
						: "Unknown error loading config file",
			fieldErrors: {},
		});
	}
}

export async function loadModelBackendsConfig<T>(
	configDir: string,
	schema: ZodSchema<T>,
): Promise<Result<T, ConfigError>> {
	return loadConfigWithPrecedence(configDir, "model_backends", schema);
}

export async function loadRequiredConfigs(
	configDir: string,
	allowlistSchema: ZodSchema<AllowlistConfig>,
	modelBackendsSchema: ZodSchema<ModelBackendsConfig>,
	modelBackends?: ModelBackendsConfig,
): Promise<Result<RequiredConfig, ConfigError[]>> {
	const errors: ConfigError[] = [];
	const allowlistResult = await loadConfigWithPrecedence(configDir, "allowlist", allowlistSchema);
	if (!allowlistResult.ok) {
		errors.push(allowlistResult.error);
	}

	const modelBackendsResult = modelBackends
		? ok(modelBackends)
		: await loadModelBackendsConfig(configDir, modelBackendsSchema);
	if (!modelBackendsResult.ok) {
		errors.push(modelBackendsResult.error);
	}

	if (!allowlistResult.ok || !modelBackendsResult.ok) {
		return err(errors);
	}

	return ok({
		allowlist: allowlistResult.value,
		modelBackends: modelBackendsResult.value,
	});
}

export async function loadOptionalConfigs(configDir: string): Promise<OptionalConfigs> {
	const configs: OptionalConfigs = {};
	// config-keys.test.ts scans this list for `key: "..."` literals.
	const optionalConfigs: Array<{ key: string; schema: ZodSchema<unknown> }> = [
		{ key: "network", schema: networkSchema as ZodSchema<unknown> },
		{ key: "platforms", schema: platformsSchema as ZodSchema<unknown> },
		{ key: "sync", schema: syncSchema as ZodSchema<unknown> },
		{ key: "keyring", schema: keyringSchema as ZodSchema<unknown> },
		{ key: "mcp", schema: mcpSchema as ZodSchema<unknown> },
		{ key: "memory", schema: memoryConfigSchema as ZodSchema<unknown> },
	];

	for (const { key, schema } of optionalConfigs) {
		const result = await loadConfigWithPrecedence(configDir, key, schema);
		// A missing optional file is fine; a present-but-invalid one is reported.
		if (result.ok || !result.error.notFound) {
			configs[key] = result as Result<Record<string, unknown>, ConfigError>;
		}
	}

	return configs;
}

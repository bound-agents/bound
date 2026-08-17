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

const JS_CONFIG_MEMORY_LIMIT_BYTES = 8 * 1024 * 1024;
const JS_CONFIG_STACK_LIMIT_BYTES = 256 * 1024;
const JS_CONFIG_CPU_LIMIT_MS = 50;
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
	const deadline = Date.now() + JS_CONFIG_CPU_LIMIT_MS;
	runtime.setInterruptHandler(() => Date.now() > deadline);
	const vm = runtime.newContext();
	try {
		const body = source.replace(/^\s*export\s+default\s+/, "return (").replace(/;?\s*$/, ");");
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
}

// Duck-typed ZodSchema interface to avoid importing zod directly
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
		const source = expandEnvVars(readFileSync(join(configDir, jsFilename), "utf-8"));
		const evaluated = await evaluateJavaScriptConfig(source, jsFilename);
		const expanded = expandEnvVarsInObject(evaluated);
		const result = schema.safeParse(expanded);
		if (result.success && result.data !== undefined) return ok(result.data);
		const fieldErrors: Record<string, string[]> = {};
		if (result.error) {
			for (const [field, errors] of Object.entries(result.error.flatten().fieldErrors ?? {})) {
				fieldErrors[field] = (errors as string[]) || [];
			}
			return err({
				filename: jsFilename,
				message: `Validation failed: ${result.error.message}`,
				fieldErrors,
			});
		}
		return err({ filename: jsFilename, message: "Validation failed: unknown error", fieldErrors });
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
	try {
		const path = `${configDir}/${filename}`;
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content);

		// Expand environment variables
		const expanded = expandEnvVarsInObject(parsed);

		// Validate with Zod
		const result = schema.safeParse(expanded);

		if (!result.success && result.error) {
			const fieldErrors: Record<string, string[]> = {};

			// Extract field errors from Zod error format
			const flatten = result.error.flatten();
			if (flatten.fieldErrors) {
				for (const [field, errors] of Object.entries(flatten.fieldErrors)) {
					fieldErrors[field] = (errors as string[]) || [];
				}
			}

			return err({
				filename,
				message: `Validation failed: ${result.error.message}`,
				fieldErrors,
			});
		}

		if (result.success && result.data !== undefined) {
			return ok(result.data);
		}

		return err({
			filename,
			message: "Validation failed: unknown error",
			fieldErrors: {},
		});
	} catch (error) {
		if (error instanceof SyntaxError) {
			return err({
				filename,
				message: `Invalid JSON: ${error.message}`,
				fieldErrors: {},
			});
		}

		if (
			error instanceof Error &&
			error.message.includes("ENOENT") &&
			error.message.includes("no such file")
		) {
			return err({
				filename,
				message: `File not found: ${configDir}/${filename}`,
				fieldErrors: {},
			});
		}

		if (error instanceof Error) {
			return err({
				filename,
				message: error.message,
				fieldErrors: {},
			});
		}

		return err({
			filename,
			message: "Unknown error loading config file",
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

	if (errors.length > 0) {
		return err(errors);
	}

	if (!allowlistResult.ok || !modelBackendsResult.ok) {
		// This should never happen at this point due to the check above
		return err(errors);
	}

	return ok({
		allowlist: allowlistResult.value,
		modelBackends: modelBackendsResult.value,
	});
}

export async function loadOptionalConfigs(configDir: string): Promise<OptionalConfigs> {
	const configs: OptionalConfigs = {};

	// Define optional config files and their schemas
	const optionalConfigs: Array<{
		filename: string;
		schema: ZodSchema<unknown>;
		key: string;
	}> = [
		{ filename: "network.json", schema: networkSchema as ZodSchema<unknown>, key: "network" },
		{ filename: "platforms.json", schema: platformsSchema as ZodSchema<unknown>, key: "platforms" },
		{ filename: "sync.json", schema: syncSchema as ZodSchema<unknown>, key: "sync" },
		{ filename: "keyring.json", schema: keyringSchema as ZodSchema<unknown>, key: "keyring" },
		{ filename: "mcp.json", schema: mcpSchema as ZodSchema<unknown>, key: "mcp" },
		{ filename: "memory.json", schema: memoryConfigSchema as ZodSchema<unknown>, key: "memory" },
	];

	for (const { filename, schema, key } of optionalConfigs) {
		const result = await loadConfigWithPrecedence(
			configDir,
			filename.replace(/\.json$/, ""),
			schema,
		);
		if (result.ok || !result.error?.message.includes("File not found")) {
			// Include both successful loads and actual validation errors
			// Exclude only "file not found" errors (missing optional files are OK)
			configs[key] = result as Result<Record<string, unknown>, ConfigError>;
		}
	}

	return configs;
}

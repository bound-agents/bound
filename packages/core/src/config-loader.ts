import { readFileSync } from "node:fs";
import type { AllowlistConfig, ModelBackendsConfig } from "@bound/shared";
import {
	type Result,
	cronSchedulesSchema,
	discordSchema,
	err,
	keyringSchema,
	mcpSchema,
	networkSchema,
	ok,
	overlaySchema,
	syncSchema,
} from "@bound/shared";
import type { z } from "zod";

export interface ConfigError {
	filename: string;
	message: string;
	fieldErrors: Record<string, string[]>;
}

export type RequiredConfig = {
	allowlist: AllowlistConfig;
	modelBackends: ModelBackendsConfig;
};

export type OptionalConfigs = Record<string, Result<Record<string, unknown>, ConfigError>>;

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

export function loadConfigFile<T>(
	configDir: string,
	filename: string,
	schema: z.ZodSchema<T>,
): Result<T, ConfigError> {
	try {
		const path = `${configDir}/${filename}`;
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content);

		// Expand environment variables
		const expanded = expandEnvVarsInObject(parsed);

		// Validate with Zod
		const result = schema.safeParse(expanded);

		if (!result.success) {
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

		return ok(result.data);
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

export function loadRequiredConfigs(
	configDir: string,
	allowlistSchema: z.ZodSchema<AllowlistConfig>,
	modelBackendsSchema: z.ZodSchema<ModelBackendsConfig>,
): Result<RequiredConfig, ConfigError[]> {
	const errors: ConfigError[] = [];

	const allowlistResult = loadConfigFile(configDir, "allowlist.json", allowlistSchema);
	if (!allowlistResult.ok) {
		errors.push(allowlistResult.error);
	}

	const modelBackendsResult = loadConfigFile(configDir, "model_backends.json", modelBackendsSchema);
	if (!modelBackendsResult.ok) {
		errors.push(modelBackendsResult.error);
	}

	if (errors.length > 0) {
		return err(errors);
	}

	return ok({
		allowlist: allowlistResult.value,
		modelBackends: modelBackendsResult.value,
	});
}

export function loadOptionalConfigs(configDir: string): OptionalConfigs {
	const configs: OptionalConfigs = {};

	// Define optional config files and their schemas
	const optionalConfigs: Array<{
		filename: string;
		schema: z.ZodSchema<unknown>;
		key: string;
	}> = [
		{ filename: "network.json", schema: networkSchema, key: "network" },
		{ filename: "discord.json", schema: discordSchema, key: "discord" },
		{ filename: "sync.json", schema: syncSchema, key: "sync" },
		{ filename: "keyring.json", schema: keyringSchema, key: "keyring" },
		{ filename: "mcp.json", schema: mcpSchema, key: "mcp" },
		{ filename: "overlay.json", schema: overlaySchema, key: "overlay" },
		{ filename: "cron_schedules.json", schema: cronSchedulesSchema, key: "cronSchedules" },
	];

	for (const { filename, schema, key } of optionalConfigs) {
		const result = loadConfigFile(configDir, filename, schema);
		if (result.ok || !result.error.message.includes("File not found")) {
			// Include both successful loads and actual validation errors
			// Exclude only "file not found" errors (missing optional files are OK)
			configs[key] = result;
		}
	}

	return configs;
}

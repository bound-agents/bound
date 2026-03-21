import { readFileSync } from "fs";
import type { z } from "zod";
import type {
	AllowlistConfig,
	ModelBackendsConfig,
	allowlistSchema,
	modelBackendsSchema,
} from "@bound/shared";
import { Result, ok, err } from "@bound/shared";

export interface ConfigError {
	filename: string;
	message: string;
	fieldErrors: Record<string, string[]>;
}

export type RequiredConfig = {
	allowlist: AllowlistConfig;
	modelBackends: ModelBackendsConfig;
};

export type OptionalConfigs = Record<
	string,
	Result<Record<string, unknown>, ConfigError>
>;

export function expandEnvVars(value: string): string {
	return value.replace(/\$\{([^:}]+)(?::-([^}]*))?\}/g, (match, varName, defaultVal) => {
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
	schema: z.ZodSchema<T>
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
	modelBackendsSchema: z.ZodSchema<ModelBackendsConfig>
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
		allowlist: allowlistResult.ok ? allowlistResult.value : ({} as AllowlistConfig),
		modelBackends: modelBackendsResult.ok ? modelBackendsResult.value : ({} as ModelBackendsConfig),
	});
}

export function loadOptionalConfigs(configDir: string): OptionalConfigs {
	const configs: OptionalConfigs = {};

	// For now, this is a placeholder for future optional config loading
	// The actual implementation will load network.json, discord.json, etc.

	return configs;
}

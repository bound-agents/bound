import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	allowlistSchema,
	keyringSchema,
	mcpSchema,
	memoryConfigSchema,
	modelBackendsSchema,
	networkSchema,
	platformsSchema,
	syncSchema,
} from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import {
	expandEnvVars,
	loadConfigFile,
	loadConfigWithPrecedence,
	loadOptionalConfigs,
	loadRequiredConfigs,
} from "../config-loader";

describe("Config Loader", async () => {
	let configDir: string;

	beforeEach(() => {
		configDir = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}`);
		mkdirSync(configDir, { recursive: true });
	});

	afterEach(async () => {
		try {
			await cleanupTmpDir(configDir);
		} catch {
			// ignore
		}
	});

	describe("expandEnvVars", async () => {
		it("replaces environment variables", async () => {
			process.env.TEST_VAR = "test-value";
			const result = expandEnvVars("prefix-${TEST_VAR}-suffix");
			expect(result).toBe("prefix-test-value-suffix");
		});

		it("uses default values when env var not set", async () => {
			// `process.env.X = undefined` coerces to the literal string "undefined" (process.env
			// stringifies all values), which satisfies the `envValue !== undefined` check in
			// expandEnvVars and skips the default branch. `delete` is the only correct way to
			// make the env var actually absent; biome's auto-fix for noDelete would silently
			// reintroduce the bug.
			// biome-ignore lint/performance/noDelete: see note above
			delete process.env.MISSING_VAR;
			const result = expandEnvVars("prefix-${MISSING_VAR:-default}-suffix");
			expect(result).toBe("prefix-default-suffix");
		});

		it("throws when env var missing and no default", async () => {
			// biome-ignore lint/performance/noDelete: clearing process.env requires delete; see previous test
			delete process.env.MISSING_VAR;
			expect(() => expandEnvVars("${MISSING_VAR}")).toThrow();
		});

		it("handles multiple variables", async () => {
			process.env.VAR1 = "value1";
			process.env.VAR2 = "value2";
			const result = expandEnvVars("${VAR1}-${VAR2}");
			expect(result).toBe("value1-value2");
		});
	});

	describe("loadConfigFile", async () => {
		it("loads and validates valid JSON", async () => {
			const validAllowlist = {
				default_web_user: "alice",
				users: {
					alice: {
						display_name: "Alice",
						platforms: { discord: "123456" },
					},
				},
			};

			writeFileSync(join(configDir, "allowlist.json"), JSON.stringify(validAllowlist));

			const result = loadConfigFile(configDir, "allowlist.json", allowlistSchema);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.default_web_user).toBe("alice");
			}
		});

		it("returns error for invalid JSON", async () => {
			writeFileSync(join(configDir, "allowlist.json"), "{ invalid json");

			const result = loadConfigFile(configDir, "allowlist.json", allowlistSchema);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.filename).toBe("allowlist.json");
				expect(result.error.message).toContain("Invalid JSON");
			}
		});

		it("returns error for missing file", async () => {
			const result = loadConfigFile(configDir, "nonexistent.json", allowlistSchema);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.message).toContain("File not found");
			}
		});

		it("validates against schema and returns field errors", async () => {
			const invalidAllowlist = {
				default_web_user: "alice",
				users: {}, // Invalid: must have at least one user
			};

			writeFileSync(join(configDir, "allowlist.json"), JSON.stringify(invalidAllowlist));

			const result = loadConfigFile(configDir, "allowlist.json", allowlistSchema);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.filename).toBe("allowlist.json");
				expect(Object.keys(result.error.fieldErrors).length).toBeGreaterThan(0);
			}
		});

		it("expands environment variables before validation", async () => {
			process.env.DEFAULT_USER = "alice";
			const configContent = {
				default_web_user: "${DEFAULT_USER}",
				users: {
					alice: { display_name: "Alice" },
				},
			};

			writeFileSync(join(configDir, "allowlist.json"), JSON.stringify(configContent));

			const result = loadConfigFile(configDir, "allowlist.json", allowlistSchema);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.default_web_user).toBe("alice");
			}
		});

		it("validates model_backends schema", async () => {
			const validBackends = {
				backends: [
					{
						id: "ollama-local",
						provider: "openai-compatible",
						model: "llama3",
						context_window: 4096,
						tier: 1,
						base_url: "http://localhost:11434",
					},
				],
				default: "ollama-local",
			};

			writeFileSync(join(configDir, "model_backends.json"), JSON.stringify(validBackends));

			const result = loadConfigFile(configDir, "model_backends.json", modelBackendsSchema);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.backends).toHaveLength(1);
				expect(result.value.default).toBe("ollama-local");
			}
		});

		it("validates cross-field constraints in schema", async () => {
			const invalidBackends = {
				backends: [
					{
						id: "ollama-local",
						provider: "openai-compatible",
						model: "llama3",
						context_window: 4096,
						tier: 1,
						// Missing base_url for ollama provider
					},
				],
				default: "ollama-local",
			};

			writeFileSync(join(configDir, "model_backends.json"), JSON.stringify(invalidBackends));

			const result = loadConfigFile(configDir, "model_backends.json", modelBackendsSchema);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				// Cross-field validation errors appear in the message
				expect(result.error.message).toContain("Validation failed");
			}
		});
	});

	describe("loadRequiredConfigs", async () => {
		it("loads both required configs successfully", async () => {
			const allowlist = {
				default_web_user: "alice",
				users: {
					alice: { display_name: "Alice" },
				},
			};

			const backends = {
				backends: [
					{
						id: "ollama-local",
						provider: "openai-compatible",
						model: "llama3",
						context_window: 4096,
						tier: 1,
						base_url: "http://localhost:11434",
					},
				],
				default: "ollama-local",
			};

			writeFileSync(join(configDir, "allowlist.json"), JSON.stringify(allowlist));
			writeFileSync(join(configDir, "model_backends.json"), JSON.stringify(backends));

			const result = await loadRequiredConfigs(configDir, allowlistSchema, modelBackendsSchema);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.allowlist.default_web_user).toBe("alice");
				expect(result.value.modelBackends.default).toBe("ollama-local");
			}
		});

		it("returns all errors at once", async () => {
			const invalidAllowlist = {
				default_web_user: "alice",
				users: {}, // Invalid
			};

			const invalidBackends = {
				backends: [], // Invalid: must have at least one
				default: "none",
			};

			writeFileSync(join(configDir, "allowlist.json"), JSON.stringify(invalidAllowlist));
			writeFileSync(join(configDir, "model_backends.json"), JSON.stringify(invalidBackends));

			const result = await loadRequiredConfigs(configDir, allowlistSchema, modelBackendsSchema);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toHaveLength(2);
				expect(result.error[0].filename).toBe("allowlist.json");
				expect(result.error[1].filename).toBe("model_backends.json");
			}
		});

		it("fails if allowlist.json is missing", async () => {
			const backends = {
				backends: [
					{
						id: "ollama-local",
						provider: "openai-compatible",
						model: "llama3",
						context_window: 4096,
						tier: 1,
						base_url: "http://localhost:11434",
					},
				],
				default: "ollama-local",
			};

			writeFileSync(join(configDir, "model_backends.json"), JSON.stringify(backends));

			const result = await loadRequiredConfigs(configDir, allowlistSchema, modelBackendsSchema);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error[0].filename).toBe("allowlist.json");
				expect(result.error[0].message).toContain("File not found");
			}
		});

		it("fails if model_backends.json is missing", async () => {
			const allowlist = {
				default_web_user: "alice",
				users: {
					alice: { display_name: "Alice" },
				},
			};

			writeFileSync(join(configDir, "allowlist.json"), JSON.stringify(allowlist));

			const result = await loadRequiredConfigs(configDir, allowlistSchema, modelBackendsSchema);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error[0].filename).toBe("model_backends.json");
				expect(result.error[0].message).toContain("File not found");
			}
		});

		it("validates cross-field constraint: default_web_user references existing user", async () => {
			const invalidAllowlist = {
				default_web_user: "nonexistent",
				users: {
					alice: { display_name: "Alice" },
				},
			};

			const backends = {
				backends: [
					{
						id: "ollama-local",
						provider: "openai-compatible",
						model: "llama3",
						context_window: 4096,
						tier: 1,
						base_url: "http://localhost:11434",
					},
				],
				default: "ollama-local",
			};

			writeFileSync(join(configDir, "allowlist.json"), JSON.stringify(invalidAllowlist));
			writeFileSync(join(configDir, "model_backends.json"), JSON.stringify(backends));

			const result = await loadRequiredConfigs(configDir, allowlistSchema, modelBackendsSchema);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error[0].filename).toBe("allowlist.json");
			}
		});

		it("validates cross-field constraint: default backend exists", async () => {
			const allowlist = {
				default_web_user: "alice",
				users: {
					alice: { display_name: "Alice" },
				},
			};

			const invalidBackends = {
				backends: [
					{
						id: "ollama-local",
						provider: "openai-compatible",
						model: "llama3",
						context_window: 4096,
						tier: 1,
						base_url: "http://localhost:11434",
					},
				],
				default: "nonexistent",
			};

			writeFileSync(join(configDir, "allowlist.json"), JSON.stringify(allowlist));
			writeFileSync(join(configDir, "model_backends.json"), JSON.stringify(invalidBackends));

			const result = await loadRequiredConfigs(configDir, allowlistSchema, modelBackendsSchema);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error[0].filename).toBe("model_backends.json");
			}
		});
	});
	describe("JavaScript config alternatives", async () => {
		const optionalCases = [
			[
				"network",
				networkSchema,
				{ allowedUrlPrefixes: ["https://example.com"], allowedMethods: ["GET"] },
			],
			["platforms", platformsSchema, { connectors: [] }],
			["sync", syncSchema, { hub: "https://hub.example.com" }],
			["keyring", keyringSchema, { hosts: {} }],
			["mcp", mcpSchema, { servers: [] }],
			["memory", memoryConfigSchema, { pinned_count_cap: 12 }],
		] as const;

		it("prefers allowlist.js over allowlist.json and expands environment variables", async () => {
			writeFileSync(
				join(configDir, "allowlist.json"),
				JSON.stringify({
					default_web_user: "json",
					users: { json: { display_name: "JSON" } },
				}),
			);
			process.env.BOUND_JS_USER = "javascript";
			writeFileSync(
				join(configDir, "allowlist.js"),
				`export default {
				default_web_user: "\${BOUND_JS_USER}",
				users: { javascript: { display_name: "JavaScript" } },
			};`,
			);

			const result = await loadConfigWithPrecedence(configDir, "allowlist", allowlistSchema);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.value.default_web_user).toBe("javascript");
		});

		for (const [name, schema, value] of optionalCases) {
			it(`prefers ${name}.js over ${name}.json`, async () => {
				writeFileSync(join(configDir, `${name}.json`), JSON.stringify({ ...value, ignored: true }));
				writeFileSync(join(configDir, `${name}.js`), `export default ${JSON.stringify(value)};`);

				const result = await loadConfigWithPrecedence(configDir, name, schema);
				expect(result.ok).toBe(true);
			});
		}

		it("uses JavaScript alternatives for every operator config, including model backends", async () => {
			const modelBackends = {
				backends: [
					{
						id: "js",
						provider: "openai-compatible",
						model: "x",
						context_window: 8192,
						tier: 1,
						base_url: "http://localhost:11434/v1",
					},
				],
				default: "js",
			};
			writeFileSync(
				join(configDir, "model_backends.json"),
				JSON.stringify({ ...modelBackends, default: "json" }),
			);
			writeFileSync(
				join(configDir, "model_backends.js"),
				`export default ${JSON.stringify(modelBackends)};`,
			);

			writeFileSync(
				join(configDir, "allowlist.json"),
				JSON.stringify({
					default_web_user: "json",
					users: { json: { display_name: "JSON" } },
				}),
			);
			writeFileSync(
				join(configDir, "allowlist.js"),
				`export default { default_web_user: "js", users: { js: { display_name: "JavaScript" } } };`,
			);
			const loaded = await loadRequiredConfigs(configDir, allowlistSchema, modelBackendsSchema);
			expect(loaded.ok).toBe(true);
			if (loaded.ok) {
				expect(loaded.value.allowlist.default_web_user).toBe("js");
				expect(loaded.value.modelBackends.default).toBe("js");
			}
		});

		it("falls back to JSON when an optional JavaScript config is absent", async () => {
			writeFileSync(
				join(configDir, "sync.json"),
				JSON.stringify({ hub: "https://json.example.com" }),
			);
			const result = await loadConfigWithPrecedence(configDir, "sync", syncSchema);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.value.hub).toBe("https://json.example.com");
		});

		it("reports JavaScript syntax and schema errors against the selected JavaScript file", async () => {
			writeFileSync(
				join(configDir, "sync.json"),
				JSON.stringify({ hub: "https://json.example.com" }),
			);
			writeFileSync(join(configDir, "sync.js"), "export default { hub: ;");
			const syntax = await loadConfigWithPrecedence(configDir, "sync", syncSchema);
			expect(syntax.ok).toBe(false);
			if (!syntax.ok) expect(syntax.error.filename).toBe("sync.js");

			writeFileSync(join(configDir, "sync.js"), "export default { unknown: true };");
			const invalid = await loadConfigWithPrecedence(configDir, "sync", syncSchema);
			expect(invalid.ok).toBe(false);
			if (!invalid.ok) expect(invalid.error.filename).toBe("sync.js");
		});

		it("loads every optional JavaScript alternative through the aggregate loader", async () => {
			for (const [name, _schema, value] of optionalCases) {
				writeFileSync(join(configDir, `${name}.js`), `export default ${JSON.stringify(value)};`);
			}
			const configs = await loadOptionalConfigs(configDir);
			expect(Object.keys(configs).sort()).toEqual(optionalCases.map(([name]) => name).sort());
			for (const result of Object.values(configs)) expect(result.ok).toBe(true);
		});
	});
});

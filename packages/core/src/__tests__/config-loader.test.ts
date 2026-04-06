import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowlistSchema, modelBackendsSchema } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { expandEnvVars, loadConfigFile, loadRequiredConfigs } from "../config-loader";

describe("Config Loader", () => {
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

	describe("expandEnvVars", () => {
		it("replaces environment variables", () => {
			process.env.TEST_VAR = "test-value";
			const result = expandEnvVars("prefix-${TEST_VAR}-suffix");
			expect(result).toBe("prefix-test-value-suffix");
		});

		it("uses default values when env var not set", () => {
			process.env.MISSING_VAR = undefined;
			const result = expandEnvVars("prefix-${MISSING_VAR:-default}-suffix");
			expect(result).toBe("prefix-default-suffix");
		});

		it("throws when env var missing and no default", () => {
			process.env.MISSING_VAR = undefined;
			expect(() => expandEnvVars("${MISSING_VAR}")).toThrow();
		});

		it("handles multiple variables", () => {
			process.env.VAR1 = "value1";
			process.env.VAR2 = "value2";
			const result = expandEnvVars("${VAR1}-${VAR2}");
			expect(result).toBe("value1-value2");
		});
	});

	describe("loadConfigFile", () => {
		it("loads and validates valid JSON", () => {
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

		it("returns error for invalid JSON", () => {
			writeFileSync(join(configDir, "allowlist.json"), "{ invalid json");

			const result = loadConfigFile(configDir, "allowlist.json", allowlistSchema);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.filename).toBe("allowlist.json");
				expect(result.error.message).toContain("Invalid JSON");
			}
		});

		it("returns error for missing file", () => {
			const result = loadConfigFile(configDir, "nonexistent.json", allowlistSchema);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.message).toContain("File not found");
			}
		});

		it("validates against schema and returns field errors", () => {
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

		it("expands environment variables before validation", () => {
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

		it("validates model_backends schema", () => {
			const validBackends = {
				backends: [
					{
						id: "ollama-local",
						provider: "ollama",
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

		it("validates cross-field constraints in schema", () => {
			const invalidBackends = {
				backends: [
					{
						id: "ollama-local",
						provider: "ollama",
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

	describe("loadRequiredConfigs", () => {
		it("loads both required configs successfully", () => {
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
						provider: "ollama",
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

			const result = loadRequiredConfigs(configDir, allowlistSchema, modelBackendsSchema);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.allowlist.default_web_user).toBe("alice");
				expect(result.value.modelBackends.default).toBe("ollama-local");
			}
		});

		it("returns all errors at once", () => {
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

			const result = loadRequiredConfigs(configDir, allowlistSchema, modelBackendsSchema);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toHaveLength(2);
				expect(result.error[0].filename).toBe("allowlist.json");
				expect(result.error[1].filename).toBe("model_backends.json");
			}
		});

		it("fails if allowlist.json is missing", () => {
			const backends = {
				backends: [
					{
						id: "ollama-local",
						provider: "ollama",
						model: "llama3",
						context_window: 4096,
						tier: 1,
						base_url: "http://localhost:11434",
					},
				],
				default: "ollama-local",
			};

			writeFileSync(join(configDir, "model_backends.json"), JSON.stringify(backends));

			const result = loadRequiredConfigs(configDir, allowlistSchema, modelBackendsSchema);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error[0].filename).toBe("allowlist.json");
				expect(result.error[0].message).toContain("File not found");
			}
		});

		it("fails if model_backends.json is missing", () => {
			const allowlist = {
				default_web_user: "alice",
				users: {
					alice: { display_name: "Alice" },
				},
			};

			writeFileSync(join(configDir, "allowlist.json"), JSON.stringify(allowlist));

			const result = loadRequiredConfigs(configDir, allowlistSchema, modelBackendsSchema);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error[0].filename).toBe("model_backends.json");
				expect(result.error[0].message).toContain("File not found");
			}
		});

		it("validates cross-field constraint: default_web_user references existing user", () => {
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
						provider: "ollama",
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

			const result = loadRequiredConfigs(configDir, allowlistSchema, modelBackendsSchema);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error[0].filename).toBe("allowlist.json");
			}
		});

		it("validates cross-field constraint: default backend exists", () => {
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
						provider: "ollama",
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

			const result = loadRequiredConfigs(configDir, allowlistSchema, modelBackendsSchema);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error[0].filename).toBe("model_backends.json");
			}
		});
	});
});

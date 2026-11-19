import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { runInit } from "../commands/init.js";

describe("bound init", () => {
	let tempDir: string;
	// runInit() prints a multi-line banner to stdout by design (human UX).
	// Capture it so test runs don't leak ~12 lines per case into the
	// verification output — the suite only asserts filesystem state.
	let logSpy: ReturnType<typeof spyOn<Console, "log">>;

	beforeEach(() => {
		// Use the OS temp dir so test directories don't litter the repo root.
		tempDir = mkdtempSync(join(tmpdir(), "bound-test-"));
		logSpy = spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(async () => {
		logSpy.mockRestore();
		await cleanupTmpDir(tempDir);
	});

	it("creates allowlist.json and model_backends.js with an export default config for the --ollama preset", async () => {
		await runInit({
			ollama: true,
			configDir: tempDir,
		});

		const allowlistPath = join(tempDir, "allowlist.json");
		const modelBackendsPath = join(tempDir, "model_backends.js");

		// Verify files exist
		expect(readFileSync(allowlistPath, "utf-8")).toBeTruthy();
		expect(readFileSync(modelBackendsPath, "utf-8")).toBeTruthy();

		// Verify content
		const allowlist = JSON.parse(readFileSync(allowlistPath, "utf-8"));
		const modelBackendsSource = readFileSync(modelBackendsPath, "utf-8");
		const modelBackends = JSON.parse(
			modelBackendsSource.replace(/^export default /, "").replace(/;\n?$/, ""),
		);
		expect(modelBackendsSource).toStartWith("export default ");
		expect(existsSync(join(tempDir, "model_backends.json"))).toBe(false);

		// Check allowlist structure
		expect(allowlist).toHaveProperty("default_web_user");
		expect(allowlist).toHaveProperty("users");
		expect(Object.keys(allowlist.users).length).toBeGreaterThan(0);

		// Check model_backends structure
		expect(modelBackends).toHaveProperty("backends");
		expect(modelBackends).toHaveProperty("default");
		expect(modelBackends.backends.length).toBe(1);
		expect(modelBackends.backends[0].provider).toBe("openai-compatible");
		expect(modelBackends.backends[0].base_url).toBe("http://localhost:11434/v1");
		expect(modelBackends.backends[0].api_key).toBe("ollama");
	});

	it("does not overwrite existing config without --force flag", async () => {
		// First init
		await runInit({
			ollama: true,
			configDir: tempDir,
		});

		const allowlistPath = join(tempDir, "allowlist.json");
		const originalContent = readFileSync(allowlistPath, "utf-8");

		// Second init should not overwrite
		await runInit({
			ollama: true,
			configDir: tempDir,
		});

		const finalContent = readFileSync(allowlistPath, "utf-8");
		expect(finalContent).toBe(originalContent);
	});

	it("overwrites existing config with --force flag", async () => {
		// First init
		await runInit({
			ollama: true,
			name: "user1",
			configDir: tempDir,
		});

		// Second init with force should overwrite
		await runInit({
			ollama: true,
			name: "user2",
			force: true,
			configDir: tempDir,
		});

		const allowlistPath = join(tempDir, "allowlist.json");
		const allowlist = JSON.parse(readFileSync(allowlistPath, "utf-8"));

		// The operator name should be updated
		expect(allowlist.default_web_user).toBe("user2");
	});

	it("creates optional config files with --with-sync", async () => {
		await runInit({
			ollama: true,
			withSync: true,
			configDir: tempDir,
		});

		const syncPath = join(tempDir, "sync.json");
		const syncContent = readFileSync(syncPath, "utf-8");
		const sync = JSON.parse(syncContent);

		expect(sync).toHaveProperty("hub");
	});

	it("creates mcp.json template with --with-mcp", async () => {
		await runInit({
			ollama: true,
			withMcp: true,
			configDir: tempDir,
		});

		const mcpPath = join(tempDir, "mcp.json");
		const mcpContent = readFileSync(mcpPath, "utf-8");
		const mcp = JSON.parse(mcpContent);

		expect(mcp).toHaveProperty("servers");
		expect(Array.isArray(mcp.servers)).toBe(true);
	});

	it("uses custom name with --name flag", async () => {
		await runInit({
			ollama: true,
			name: "custom-operator",
			configDir: tempDir,
		});

		const allowlistPath = join(tempDir, "allowlist.json");
		const allowlist = JSON.parse(readFileSync(allowlistPath, "utf-8"));

		expect(allowlist.default_web_user).toBe("custom-operator");
		expect(allowlist.users).toHaveProperty("custom-operator");
	});

	it("creates OpenCode Go preset with --opencode-go", async () => {
		process.env.OPENCODE_API_KEY = "test-key";

		await runInit({
			opencodeGo: true,
			configDir: tempDir,
		});

		const modelBackendsPath = join(tempDir, "model_backends.js");
		const modelBackends = JSON.parse(
			readFileSync(modelBackendsPath, "utf-8")
				.replace(/^export default /, "")
				.replace(/;\n?$/, ""),
		);

		expect(modelBackends.backends[0].provider).toBe("opencode-go");
		expect(modelBackends.backends[0].model).toBe("glm-5.1");
		expect(modelBackends.backends[0].base_url).toBe("https://opencode.ai/zen/go/v1");
		expect(modelBackends.backends[0].api_key).toBe("test-key");
	});

	it("creates Anthropic direct preset with --anthropic", async () => {
		process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

		await runInit({
			anthropic: true,
			configDir: tempDir,
		});

		const modelBackendsPath = join(tempDir, "model_backends.js");
		const modelBackends = JSON.parse(
			readFileSync(modelBackendsPath, "utf-8")
				.replace(/^export default /, "")
				.replace(/;\n?$/, ""),
		);

		expect(modelBackends.backends[0].provider).toBe("anthropic");
		expect(modelBackends.backends[0].model).toBe("claude-sonnet-4-5");
		expect(modelBackends.backends[0].api_key).toBe("test-anthropic-key");
		// Direct Anthropic uses the SDK default endpoint — no base_url is written.
		expect(modelBackends.backends[0].base_url).toBeUndefined();
		expect(modelBackends.default).toBe("anthropic");
		process.env.ANTHROPIC_API_KEY = undefined;
	});

	it("creates a config-light umans preset with --umans (AC.15)", async () => {
		process.env.UMANS_API_KEY = "sk-umans-test";

		await runInit({
			umans: true,
			configDir: tempDir,
		});

		const modelBackendsPath = join(tempDir, "model_backends.js");
		const modelBackends = JSON.parse(
			readFileSync(modelBackendsPath, "utf-8")
				.replace(/^export default /, "")
				.replace(/;\n?$/, ""),
		);

		const b = modelBackends.backends[0];
		expect(b.provider).toBe("umans");
		expect(b.id).toBe("umans");
		expect(b.api_key).toBe("sk-umans-test");
		expect(modelBackends.default).toBe("umans");
		// Config-light: NO model/tier/context_window/base_url/pricing.
		expect(b.model).toBeUndefined();
		expect(b.tier).toBeUndefined();
		expect(b.context_window).toBeUndefined();
		expect(b.base_url).toBeUndefined();
		expect(b.price_per_m_input).toBeUndefined();
		process.env.UMANS_API_KEY = undefined;
	});

	it("creates the Bedrock preset with --bedrock (region set, no base_url/api_key)", async () => {
		await runInit({ bedrock: true, region: "eu-west-1", configDir: tempDir });
		const src = readFileSync(join(tempDir, "model_backends.js"), "utf-8");
		const mb = JSON.parse(src.replace(/^export default /, "").replace(/;\n?$/, ""));
		const b = mb.backends[0];
		expect(b.provider).toBe("bedrock");
		expect(b.region).toBe("eu-west-1");
		expect(b.model).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0");
		// Bedrock auths via SigV4 — no api_key, and base_url is suppressed for bedrock.
		expect(b.api_key).toBeUndefined();
		expect(b.base_url).toBeUndefined();
		expect(mb.default).toBe("bedrock");
	});

	it("defaults the Bedrock region to us-east-1 when --region is omitted", async () => {
		await runInit({ bedrock: true, configDir: tempDir });
		const src = readFileSync(join(tempDir, "model_backends.js"), "utf-8");
		const mb = JSON.parse(src.replace(/^export default /, "").replace(/;\n?$/, ""));
		expect(mb.backends[0].region).toBe("us-east-1");
	});

	it("creates the Cerebras preset with --cerebras", async () => {
		process.env.CEREBRAS_API_KEY = "cb-key";
		try {
			await runInit({ cerebras: true, configDir: tempDir });
			const src = readFileSync(join(tempDir, "model_backends.js"), "utf-8");
			const mb = JSON.parse(src.replace(/^export default /, "").replace(/;\n?$/, ""));
			const b = mb.backends[0];
			expect(b.provider).toBe("cerebras");
			expect(b.base_url).toBe("https://api.cerebras.ai/v1");
			expect(b.api_key).toBe("cb-key");
		} finally {
			process.env.CEREBRAS_API_KEY = undefined;
		}
	});

	it("creates the z.AI preset with --zai", async () => {
		process.env.ZAI_API_KEY = "zai-key";
		try {
			await runInit({ zai: true, configDir: tempDir });
			const src = readFileSync(join(tempDir, "model_backends.js"), "utf-8");
			const mb = JSON.parse(src.replace(/^export default /, "").replace(/;\n?$/, ""));
			const b = mb.backends[0];
			expect(b.provider).toBe("zai");
			expect(b.base_url).toBe("https://api.z.ai/api/coding/paas/v4");
			expect(b.api_key).toBe("zai-key");
		} finally {
			process.env.ZAI_API_KEY = undefined;
		}
	});

	it("warns (but still writes config) when a preset's API key env var is absent", async () => {
		// An empty string is falsy under init's `if (!apiKey)` gate, so it drives the
		// same "not found" warning as an absent var without the noDelete lint hit.
		const prior = process.env.CEREBRAS_API_KEY;
		process.env.CEREBRAS_API_KEY = "";
		const warnLines: string[] = [];
		logSpy.mockImplementation((msg?: unknown) => {
			warnLines.push(String(msg ?? ""));
		});
		try {
			await runInit({ cerebras: true, configDir: tempDir });
		} finally {
			if (prior === undefined) {
				process.env.CEREBRAS_API_KEY = "";
			} else {
				process.env.CEREBRAS_API_KEY = prior;
			}
		}
		expect(warnLines.join("\n")).toContain("CEREBRAS_API_KEY not found");
		// Config is still written despite the missing key.
		expect(existsSync(join(tempDir, "model_backends.js"))).toBe(true);
	});

	it("creates a hub-only config with --hub (empty backends, hub banner)", async () => {
		const banner: string[] = [];
		logSpy.mockImplementation((msg?: unknown) => {
			banner.push(String(msg ?? ""));
		});
		await runInit({ hub: true, configDir: tempDir });
		const src = readFileSync(join(tempDir, "model_backends.js"), "utf-8");
		const mb = JSON.parse(src.replace(/^export default /, "").replace(/;\n?$/, ""));
		expect(mb.backends).toEqual([]);
		expect(mb.default).toBe("");
		expect(banner.join("\n")).toContain("Hub initialized successfully!");
	});
});

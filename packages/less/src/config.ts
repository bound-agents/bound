import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import RELEASE_SYNC from "@jitl/quickjs-singlefile-cjs-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { z } from "zod";

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

async function evaluateJavaScriptConfig(
	source: string,
	filename: string,
): Promise<Record<string, unknown>> {
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
		const value = vm.dump(result.value) as Record<string, unknown>;
		result.value.dispose();
		return value;
	} finally {
		vm.dispose();
		runtime.dispose();
	}
}

const sandboxConfigSchema = z
	.object({
		enabled: z.boolean().default(true),
		writablePaths: z.array(z.string()).default([]),
		network: z.enum(["open", "blocked"]).default("open"),
		onUnavailable: z.enum(["passthrough", "error"]).default("error"),
	})
	.strict();

const configSchema = z
	.object({
		url: z.string().default("http://localhost:3001"),
		model: z.string().nullable().default(null),
		contextFiles: z
			.array(z.string())
			.default(["README.md", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md"]),
		shell: z.string().optional(),
		sandbox: z.union([z.boolean(), sandboxConfigSchema]).default(true),
	})
	.passthrough();

const mcpServerStdioSchema = z.object({
	transport: z.literal("stdio"),
	name: z.string(),
	command: z.string(),
	args: z.array(z.string()).default([]),
	env: z.record(z.string(), z.string()).optional(),
	enabled: z.boolean().default(true),
	allowTools: z.array(z.string()).optional(),
	confirm: z.array(z.string()).optional(),
});

const mcpServerHttpSchema = z.object({
	transport: z.literal("http"),
	name: z.string(),
	url: z.string(),
	headers: z.record(z.string(), z.string()).optional(),
	enabled: z.boolean().default(true),
	allowTools: z.array(z.string()).optional(),
	confirm: z.array(z.string()).optional(),
});

const mcpServerSchema = z.discriminatedUnion("transport", [
	mcpServerStdioSchema,
	mcpServerHttpSchema,
]);
const mcpConfigSchema = z.object({ servers: z.array(mcpServerSchema) }).passthrough();

export type Config = z.infer<typeof configSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;

type Loaded<T> = T & { _raw: Record<string, unknown> };

function loadJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

async function loadLayeredRaw(
	configDir: string,
	basename: string,
): Promise<Record<string, unknown>> {
	const jsonPath = join(configDir, `${basename}.json`);
	const jsPath = join(configDir, `${basename}.js`);
	const json = existsSync(jsonPath) ? loadJson(jsonPath) : {};
	if (!existsSync(jsPath)) return json;
	// JavaScript supplies a read-only base; JSON remains the writable override layer.
	return {
		...(await evaluateJavaScriptConfig(readFileSync(jsPath, "utf-8"), `${basename}.js`)),
		...json,
	};
}

function validate<T>(raw: Record<string, unknown>, schema: z.ZodType<T>, filename: string): T {
	const result = schema.safeParse(raw);
	if (!result.success) throw new Error(`Failed to parse ${filename}: ${result.error.message}`);
	return result.data;
}

export async function loadConfig(configDir: string): Promise<Loaded<Config>> {
	try {
		const raw = await loadLayeredRaw(configDir, "config");
		if (Object.keys(raw).length === 0) {
			return {
				url: "http://localhost:3001",
				model: null,
				contextFiles: ["README.md", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md"],
				sandbox: true,
				_raw: {},
			};
		}
		return { ...validate(raw, configSchema, "config.js/config.json"), _raw: raw };
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return {
				url: "http://localhost:3001",
				model: null,
				contextFiles: ["README.md", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md"],
				sandbox: true,
				_raw: {},
			};
		}
		throw error;
	}
}

export function saveConfig(configDir: string, config: Config): void {
	mkdirSync(configDir, { recursive: true });
	const configPath = join(configDir, "config.json");
	const existing = existsSync(configPath) ? loadJson(configPath) : {};
	writeFileSync(
		configPath,
		JSON.stringify({ ...existing, url: config.url, model: config.model }, null, "\t"),
	);
}

function assertUniqueServers(servers: McpServerConfig[]): void {
	const nameCount = new Map<string, number>();
	for (const server of servers) nameCount.set(server.name, (nameCount.get(server.name) ?? 0) + 1);
	for (const [name, count] of nameCount) {
		if (count > 1)
			throw new Error(
				`Duplicate MCP server name: '${name}' appears ${count} times in mcp.js/mcp.json`,
			);
	}
}

export async function loadMcpConfig(configDir: string): Promise<Loaded<McpConfig>> {
	try {
		const raw = await loadLayeredRaw(configDir, "mcp");
		if (Object.keys(raw).length === 0) return { servers: [], _raw: {} };
		const config = validate(raw, mcpConfigSchema, "mcp.js/mcp.json");
		assertUniqueServers(config.servers as McpServerConfig[]);
		return { ...config, _raw: raw };
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { servers: [], _raw: {} };
		throw error;
	}
}

export function saveMcpConfig(configDir: string, config: McpConfig): void {
	mkdirSync(configDir, { recursive: true });
	const mcpPath = join(configDir, "mcp.json");
	const existing = existsSync(mcpPath) ? loadJson(mcpPath) : {};
	writeFileSync(mcpPath, JSON.stringify({ ...existing, servers: config.servers }, null, "\t"));
}

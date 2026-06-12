import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// Zod schemas for configuration files

// Object form of the `sandbox` field — finer-grained control over the
// mxc-backed filesystem sandbox for the boundless bash-family tool.
const sandboxConfigSchema = z
	.object({
		// Master switch. `false` here is equivalent to `sandbox: false`.
		enabled: z.boolean().default(true),
		// Extra absolute paths granted WRITE access beyond the working directory
		// and the system temp dir (which are always writable when enabled).
		writablePaths: z.array(z.string()).default([]),
		// Outbound network from sandboxed commands. "open" (default) leaves it
		// reachable; "blocked" denies all network access.
		network: z.enum(["open", "blocked"]).default("open"),
		// Behavior when mxc can't sandbox on this platform: "passthrough"
		// (default) runs the command unsandboxed with a warning; "error" fails
		// the command rather than running it without containment.
		onUnavailable: z.enum(["passthrough", "error"]).default("passthrough"),
	})
	.strict();

const configSchema = z
	.object({
		url: z.string().default("http://localhost:3001"),
		model: z.string().nullable().default(null),
		// Which context files to auto-inject into the system prompt (relative to cwd).
		// Defaults to the standard set: README.md, CONTRIBUTING.md, AGENTS.md, CLAUDE.md.
		// Pass [] to disable injection entirely.
		contextFiles: z
			.array(z.string())
			.default(["README.md", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md"]),
		// Override the shell used by the boundless bash-family tool. Accepts a bare
		// executable name (resolved on PATH) or an absolute path. When unset, the
		// shell is auto-detected: POSIX `sh` on non-Windows, PowerShell (else
		// cmd.exe) on Windows. An invalid override is a fatal error at attach.
		shell: z.string().optional(),
		// Filesystem sandboxing for the boundless bash-family tool, backed by
		// @microsoft/mxc-sdk. Defaults ON (opt-out). When enabled, shell commands
		// run inside a containment (seatbelt on macOS, bubblewrap on Linux) that
		// keeps the whole filesystem READABLE but confines WRITES to the working
		// directory + tmpdir (plus any `writablePaths`). The goal is to guard the
		// filesystem OUTSIDE the working directory — the repo itself stays
		// read-write. `true` = defaults, `false` = disabled, object = finer control.
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

const mcpConfigSchema = z
	.object({
		servers: z.array(mcpServerSchema),
	})
	.passthrough();

// Type exports
export type Config = z.infer<typeof configSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;

// Configuration loading and saving

export function loadConfig(configDir: string): Config & { _raw: Record<string, unknown> } {
	const configPath = join(configDir, "config.json");
	try {
		const content = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(content) as Record<string, unknown>;
		const result = configSchema.safeParse(parsed);
		if (!result.success) {
			throw new Error(`Failed to parse config.json: ${result.error.message}`);
		}
		return {
			...result.data,
			_raw: parsed,
		};
	} catch (error) {
		// File doesn't exist or parse error - return defaults
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return {
				url: "http://localhost:3001",
				model: null,
				contextFiles: ["README.md", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md"],
				sandbox: true,
				_raw: {},
			};
		}
		// Re-throw parse errors
		throw error;
	}
}

export function saveConfig(configDir: string, config: Config): void {
	mkdirSync(configDir, { recursive: true });
	const configPath = join(configDir, "config.json");
	const rawConfig = loadConfig(configDir);
	const merged = {
		...(rawConfig._raw as Record<string, unknown>),
		url: config.url,
		model: config.model,
	};
	writeFileSync(configPath, JSON.stringify(merged, null, "\t"));
}

export function loadMcpConfig(configDir: string): McpConfig & { _raw: Record<string, unknown> } {
	const mcpPath = join(configDir, "mcp.json");
	try {
		const content = readFileSync(mcpPath, "utf-8");
		const parsed = JSON.parse(content) as Record<string, unknown>;
		const result = mcpConfigSchema.safeParse(parsed);
		if (!result.success) {
			throw new Error(`Failed to parse mcp.json: ${result.error.message}`);
		}

		// Validate server name uniqueness
		const servers = result.data.servers as McpServerConfig[];
		const nameCount = new Map<string, number>();
		for (const server of servers) {
			const count = (nameCount.get(server.name) ?? 0) + 1;
			nameCount.set(server.name, count);
		}

		for (const [name, count] of nameCount) {
			if (count > 1) {
				throw new Error(`Duplicate MCP server name: '${name}' appears ${count} times in mcp.json`);
			}
		}

		return {
			...result.data,
			_raw: parsed,
		};
	} catch (error) {
		// File doesn't exist - return empty config
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return {
				servers: [],
				_raw: {},
			};
		}
		// Re-throw errors (including validation errors)
		throw error;
	}
}

export function saveMcpConfig(configDir: string, config: McpConfig): void {
	mkdirSync(configDir, { recursive: true });
	const mcpPath = join(configDir, "mcp.json");
	const rawConfig = loadMcpConfig(configDir);
	const merged = {
		...(rawConfig._raw as Record<string, unknown>),
		servers: config.servers,
	};
	writeFileSync(mcpPath, JSON.stringify(merged, null, "\t"));
}

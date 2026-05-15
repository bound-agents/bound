import { describe, expect, it } from "bun:test";
import type { RegisteredTool } from "@bound/agent";
import type { PlatformRegisteredTool } from "@bound/platforms";
import type { Logger } from "@bound/shared";
import { createToolRegistry } from "../commands/start/agent-factory";

const noopLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

function platformTool(
	name: string,
	extras: Partial<PlatformRegisteredTool>,
): PlatformRegisteredTool {
	return {
		kind: "platform",
		toolDefinition: {
			type: "function",
			function: { name, description: name, parameters: {} },
		},
		execute: async () => "",
		...extras,
	};
}

describe("createToolRegistry — platform tool annotation propagation", () => {
	it("copies static idempotent and readOnly fields onto the registered tool", () => {
		const platformTools: PlatformRegisteredTool[] = [
			platformTool("readonly_tool", { idempotent: true, readOnly: true }),
		];
		const registry: Map<string, RegisteredTool> = createToolRegistry(
			undefined,
			undefined,
			[],
			noopLogger,
			platformTools,
		);
		const entry = registry.get("readonly_tool");
		expect(entry).toBeDefined();
		expect(entry?.idempotent).toBe(true);
		expect(entry?.readOnly).toBe(true);
	});

	it("falls back to MCP-spec annotations.idempotentHint/readOnlyHint when explicit fields are absent", () => {
		const platformTools: PlatformRegisteredTool[] = [
			platformTool("github_search", {
				annotations: { idempotentHint: true, readOnlyHint: true },
			}),
		];
		const registry = createToolRegistry(undefined, undefined, [], noopLogger, platformTools);
		const entry = registry.get("github_search");
		expect(entry?.idempotent).toBe(true);
		expect(entry?.readOnly).toBe(true);
	});

	it("explicit static fields take precedence over MCP-spec hints", () => {
		const platformTools: PlatformRegisteredTool[] = [
			platformTool("override_case", {
				idempotent: false,
				readOnly: false,
				annotations: { idempotentHint: true, readOnlyHint: true },
			}),
		];
		const registry = createToolRegistry(undefined, undefined, [], noopLogger, platformTools);
		const entry = registry.get("override_case");
		expect(entry?.idempotent).toBe(false);
		expect(entry?.readOnly).toBe(false);
	});

	it("propagates resolveAnnotations from PlatformRegisteredTool", () => {
		const resolver = (args: Record<string, unknown>) => {
			if (args.action === "list") return { idempotent: true, readOnly: true };
			return { idempotent: false, readOnly: false };
		};
		const platformTools: PlatformRegisteredTool[] = [
			platformTool("connector", { resolveAnnotations: resolver }),
		];
		const registry = createToolRegistry(undefined, undefined, [], noopLogger, platformTools);
		const entry = registry.get("connector");
		expect(entry?.resolveAnnotations).toBe(resolver);
		// Verify it actually works through the registered entry
		expect(entry?.resolveAnnotations?.({ action: "list" })).toEqual({
			idempotent: true,
			readOnly: true,
		});
		expect(entry?.resolveAnnotations?.({ action: "attach" })).toEqual({
			idempotent: false,
			readOnly: false,
		});
	});

	it("leaves annotations undefined when the platform tool has none", () => {
		const platformTools: PlatformRegisteredTool[] = [platformTool("plain", {})];
		const registry = createToolRegistry(undefined, undefined, [], noopLogger, platformTools);
		const entry = registry.get("plain");
		expect(entry?.idempotent).toBeUndefined();
		expect(entry?.readOnly).toBeUndefined();
		expect(entry?.resolveAnnotations).toBeUndefined();
	});
});

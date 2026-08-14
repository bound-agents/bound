import { describe, expect, it } from "bun:test";
import type { PlatformMcpRegistry, PlatformRegisteredTool } from "@bound/platforms";
import { resolvePlatformToolsForThread } from "../platform-tools";

function tool(name: string): PlatformRegisteredTool {
	return {
		kind: "platform",
		toolDefinition: {
			type: "function",
			function: {
				name,
				description: name,
				parameters: { type: "object", properties: {} },
			},
		},
		execute: async () => "ok",
		idempotent: true,
		readOnly: true,
	};
}

describe("resolvePlatformToolsForThread", () => {
	it("adds the connector tool to event-task scoped tools", () => {
		const discordSend = tool("discord_send_message");
		const connector = tool("connector");
		const registry = {
			getToolsForThread: () => new Map([["discord_send_message", discordSend]]),
			getReadOnlyPlatformTools: () => new Map(),
		} as unknown as PlatformMcpRegistry;

		expect(resolvePlatformToolsForThread(registry, "thread-1", connector)).toEqual([
			discordSend,
			connector,
		]);
	});

	it("does not duplicate a connector already present in scoped tools", () => {
		const connector = tool("connector");
		const registry = {
			getToolsForThread: () => new Map([["connector", connector]]),
			getReadOnlyPlatformTools: () => new Map(),
		} as unknown as PlatformMcpRegistry;

		expect(resolvePlatformToolsForThread(registry, "thread-1", connector)).toEqual([connector]);
	});

	it("returns read-only platform tools plus connector for ordinary threads", () => {
		const readOnly = tool("discord_get_channel");
		const connector = tool("connector");
		const registry = {
			getToolsForThread: () => new Map(),
			getReadOnlyPlatformTools: () => new Map([["discord_get_channel", readOnly]]),
		} as unknown as PlatformMcpRegistry;

		expect(resolvePlatformToolsForThread(registry, "thread-1", connector)).toEqual([
			readOnly,
			connector,
		]);
	});
});

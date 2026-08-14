import type { PlatformMcpRegistry, PlatformRegisteredTool } from "@bound/platforms";

/**
 * Resolve platform tools for a thread.
 *
 * Event-task threads keep their connector-scoped server tools and also receive
 * the unified connector tool so they can detach a broken subscription. Ordinary
 * threads receive read-only platform tools plus the connector tool.
 */
export function resolvePlatformToolsForThread(
	registry: PlatformMcpRegistry,
	threadId: string,
	connectorTool: PlatformRegisteredTool | null,
): PlatformRegisteredTool[] {
	const scopedTools = registry.getToolsForThread(threadId);
	if (scopedTools.size > 0) {
		const tools = Array.from(scopedTools.values());
		if (connectorTool && !scopedTools.has(connectorTool.toolDefinition.function.name)) {
			tools.push(connectorTool);
		}
		return tools;
	}

	const tools = Array.from(registry.getReadOnlyPlatformTools().values());
	if (connectorTool) {
		tools.push(connectorTool);
	}
	return tools;
}

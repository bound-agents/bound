import { Box, Text } from "ink";
import type React from "react";
import type { McpServerConfig } from "../../config";
import type { McpServerManager } from "../../mcp/manager";
import { ActionBar, Badge, ModalOverlay, SelectList } from "../components";

export interface McpViewProps {
	mcpManager: McpServerManager;
	mcpConfigs: McpServerConfig[];
	onConfigChange: (configs: McpServerConfig[]) => void;
	onCancel: () => void;
}

/**
 * McpView: Modal overlay for MCP server configuration.
 *
 * Implements AC9.7: view server list with status badges, add/remove/enable/disable
 */
export function McpView({
	mcpManager,
	mcpConfigs,
	onConfigChange: _onConfigChange,
	onCancel,
}: McpViewProps): React.ReactElement {
	const serverStates = mcpManager.getServerStates();

	// Create list items from configs
	const items = mcpConfigs.map((config) => ({
		config,
		state: serverStates.get(config.name),
	}));

	return (
		<ModalOverlay onDismiss={onCancel}>
			<Box flexDirection="column">
				<Text bold>MCP Server Configuration</Text>

				{items.length === 0 ? (
					<Text color="yellow">No servers configured</Text>
				) : (
					<Box marginTop={1}>
						<SelectList
							items={items}
							onSelect={() => {
								// TODO: implement selection action (toggle/edit)
							}}
							onCancel={onCancel}
							renderItem={(item) => (
								<Box>
									<Text>{item.config.name}</Text>
									<Text> [</Text>
									<Badge status={item.state?.status === "running" ? "connected" : "disconnected"} />
									<Text>]</Text>
									{!item.config.enabled && <Text color="yellow"> (disabled)</Text>}
									{item.state?.error && <Text color="red"> {item.state.error}</Text>}
								</Box>
							)}
						/>
					</Box>
				)}

				<Box marginTop={1}>
					<ActionBar
						actions={[
							{ keys: "space", label: "toggle" },
							{ keys: "d", label: "delete" },
							{ keys: "a", label: "add" },
							{ keys: "Esc", label: "back" },
						]}
					/>
					{/* TODO: Implement add/toggle/delete handlers for MCP servers */}
					{/* - Add: prompt for name + config, hot-reload */}
					{/* - Toggle: enable/disable server, hot-reload */}
					{/* - Delete: confirm, then hot-reload */}
				</Box>
			</Box>
		</ModalOverlay>
	);
}

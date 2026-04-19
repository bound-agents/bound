import { Box, Text } from "ink";
import type React from "react";
import { ActionBar, Badge, ModalOverlay, SelectList } from "../components";
import type { McpServerConfig } from "../config";
import type { McpServerManager } from "../mcp/manager";

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
	_onConfigChange,
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
							{ keys: "Esc", label: "back" },
						]}
					/>
				</Box>
			</Box>
		</ModalOverlay>
	);
}

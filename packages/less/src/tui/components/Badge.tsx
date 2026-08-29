import { Text } from "ink";
import type React from "react";
import { tokens } from "../theme";

export type BadgeStatus =
	| "running"
	| "failed"
	| "disabled"
	| "connected"
	| "connecting"
	| "disconnected";

const STATUS_COLORS: Record<BadgeStatus, string> = {
	running: tokens.statusRunning,
	failed: tokens.statusFailed,
	disabled: tokens.statusDisabled,
	connected: tokens.statusConnected,
	connecting: tokens.statusConnecting,
	disconnected: tokens.statusDisconnected,
};

export interface BadgeProps {
	status: BadgeStatus;
}

export function Badge({ status }: BadgeProps): React.ReactElement {
	const color = STATUS_COLORS[status];

	return <Text color={color}>●</Text>;
}

import { Text } from "ink";
import type React from "react";

export type BadgeStatus = "running" | "failed" | "disabled" | "connected" | "disconnected";

const STATUS_COLORS: Record<BadgeStatus, string> = {
	running: "green",
	failed: "red",
	disabled: "gray",
	connected: "green",
	disconnected: "yellow",
};

export interface BadgeProps {
	status: BadgeStatus;
}

export function Badge({ status }: BadgeProps): React.ReactElement {
	const color = STATUS_COLORS[status];

	return <Text color={color}>{status}</Text>;
}

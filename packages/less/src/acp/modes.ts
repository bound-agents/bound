/**
 * Session modes for the ACP agent, surfaced through `configOptions` (the same
 * mechanism as the model selector) rather than the native `session/set_mode`
 * path. A mode sets the per-session *permission posture* for tool calls.
 *
 * The set is intentionally small and maps onto the existing permission
 * machinery in {@link AcpSession} (`permissionMemory` / `resolvePermission`):
 *
 * - `default`            — ask before every tool call (current behavior, byte
 *                          identical when nothing selects another mode).
 * - `acceptEdits`        — auto-approve everything except shell execution; still
 *                          prompt before running commands.
 * - `bypassPermissions`  — auto-approve every tool call without prompting.
 *
 * There is no server-side mode catalog the way there is for models
 * (`client.listModels()`), so the list is defined here and the "just like
 * models" parallel is the config-option *mechanism*, not a data source.
 */

import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { toolNameToKind } from "./mapping";

/** The `configId` under which the mode selector rides in `configOptions`. */
export const MODE_CONFIG_ID = "mode";

export type SessionModeId = "default" | "acceptEdits" | "bypassPermissions";

export const DEFAULT_MODE_ID: SessionModeId = "default";

interface ModeDefinition {
	id: SessionModeId;
	name: string;
	description: string;
}

/** The selectable session modes, in display order. */
export const SESSION_MODES: readonly ModeDefinition[] = [
	{
		id: "default",
		name: "Ask every time",
		description: "Prompt for permission before each tool call.",
	},
	{
		id: "acceptEdits",
		name: "Accept edits",
		description: "Auto-approve file reads and edits; still prompt before running commands.",
	},
	{
		id: "bypassPermissions",
		name: "Bypass permissions",
		description: "Auto-approve every tool call without prompting.",
	},
] as const;

/** Type guard: is `value` one of the known mode ids? */
export function isSessionModeId(value: unknown): value is SessionModeId {
	return typeof value === "string" && SESSION_MODES.some((mode) => mode.id === value);
}

/** Builds the `mode` config option (a select) for the current mode. */
export function modeConfigOption(currentModeId: SessionModeId): SessionConfigOption {
	return {
		id: MODE_CONFIG_ID,
		name: "Mode",
		description: "Permission posture for tool calls in this session.",
		category: "mode",
		type: "select",
		currentValue: currentModeId,
		options: SESSION_MODES.map((mode) => ({
			value: mode.id,
			name: mode.name,
			description: mode.description,
		})),
	};
}

/**
 * Resolves the permission decision a mode dictates for a tool call, or `null`
 * when the mode defers to the normal ask flow (remembered decision →
 * `session/request_permission`).
 */
export function modePermissionDecision(
	mode: SessionModeId,
	kind: ReturnType<typeof toolNameToKind>,
): "allow" | null {
	switch (mode) {
		case "bypassPermissions":
			return "allow";
		case "acceptEdits":
			// Auto-approve everything but shell execution; commands still prompt.
			return kind === "execute" ? null : "allow";
		default:
			return null;
	}
}

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { writeOutbox } from "@bound/core";
import type { EventBroadcastPayload } from "@bound/shared";
import type { RegisteredTool, ToolContext } from "../types";

export function createEmitTool(ctx: ToolContext): RegisteredTool {
	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "emit",
				description: "Emit a custom event on the event bus",
				parameters: {
					type: "object",
					properties: {
						event: {
							type: "string",
							description: "Event name to emit",
						},
						payload: {
							type: "string",
							description: "Event payload as JSON string (default '{}')",
						},
					},
					required: ["event"],
				},
			},
		},
		execute: async (input: Record<string, unknown>) => {
			try {
				const event = input.event as string | undefined;

				if (!event) {
					return "Error: event is required";
				}

				const payloadStr = (input.payload as string | undefined) ?? "{}";

				let payload: Record<string, unknown>;
				try {
					payload = JSON.parse(payloadStr);
				} catch {
					return "Error: Invalid JSON payload";
				}

				// Emit event via EventBus locally
				// @ts-expect-error - custom events require runtime type casting for dynamic event types
				ctx.eventBus.emit(event, payload);

				// Cross-host broadcast: write event_broadcast relay if hub is configured
				const hubRow = ctx.db
					.query<{ value: string }, []>(
						"SELECT value FROM cluster_config WHERE key = 'cluster_hub' LIMIT 1",
					)
					.get();

				if (hubRow?.value) {
					// Hub is configured — broadcast to all spokes via relay
					const eventDepth = (payload.__relay_event_depth as number | undefined) ?? 0;
					const hostName = hostname() || "localhost";
					writeOutbox(ctx.db, {
						id: randomUUID(),
						source_site_id: ctx.siteId,
						target_site_id: "*",
						kind: "event_broadcast",
						ref_id: null,
						idempotency_key: `event_broadcast:${event}:${randomUUID()}`,
						stream_id: null,
						payload: JSON.stringify({
							event_name: event,
							event_payload: payload,
							source_host: hostName,
							event_depth: eventDepth + 1,
						} satisfies EventBroadcastPayload),
						created_at: new Date().toISOString(),
						expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
					});
				}

				return `Event emitted: ${event}`;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
	};
}

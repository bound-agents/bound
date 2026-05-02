import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { writeOutbox } from "@bound/core";
import type { EventBroadcastPayload } from "@bound/shared";
import { z } from "zod";
import type { RegisteredTool, ToolContext } from "../types";
import { parseToolInput, zodToToolParams } from "./tool-schema";

const emitSchema = z.object({
	event: z.string().describe("Event name to emit"),
	payload: z.string().optional().describe("Event payload as JSON string (default '{}')"),
});

export function createEmitTool(ctx: ToolContext): RegisteredTool {
	const jsonSchema = zodToToolParams(emitSchema);

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "emit",
				description: "Emit a custom event on the event bus",
				parameters: jsonSchema,
			},
		},
		execute: async (raw: Record<string, unknown>) => {
			const parsed = parseToolInput(emitSchema, raw, "emit");
			if (!parsed.ok) return parsed.error;
			const input = parsed.value;

			try {
				const payloadStr = input.payload ?? "{}";

				let payload: Record<string, unknown>;
				try {
					payload = JSON.parse(payloadStr);
				} catch {
					return "Error: Invalid JSON payload";
				}

				// @ts-expect-error - custom events require runtime type casting for dynamic event types
				ctx.eventBus.emit(input.event, payload);

				const hubRow = ctx.db
					.query<{ value: string }, []>(
						"SELECT value FROM cluster_config WHERE key = 'cluster_hub' LIMIT 1",
					)
					.get();

				if (hubRow?.value) {
					const eventDepth = (payload.__relay_event_depth as number | undefined) ?? 0;
					const hostName = hostname() || "localhost";
					writeOutbox(ctx.db, {
						id: randomUUID(),
						source_site_id: ctx.siteId,
						target_site_id: "*",
						kind: "event_broadcast",
						ref_id: null,
						idempotency_key: `event_broadcast:${input.event}:${randomUUID()}`,
						stream_id: null,
						payload: JSON.stringify({
							event_name: input.event,
							event_payload: payload,
							source_host: hostName,
							event_depth: eventDepth + 1,
						} satisfies EventBroadcastPayload),
						created_at: new Date().toISOString(),
						expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
					});
				}

				return `Event emitted: ${input.event}`;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
	};
}

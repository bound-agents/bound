import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { writeOutbox } from "@bound/core";
import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import type { EventBroadcastPayload } from "@bound/shared";
import { commandError, commandSuccess, handleCommandError } from "./helpers";

export const emit: CommandDefinition = {
	name: "emit",
	args: [
		{ name: "event", required: true, description: "Event name" },
		{ name: "payload", required: false, description: "Event payload as JSON" },
	],
	handler: async (args: Record<string, string>, ctx: CommandContext) => {
		try {
			const event = args.event;
			const payloadStr = args.payload ? args.payload : "{}";

			let payload: Record<string, unknown>;
			try {
				payload = JSON.parse(payloadStr);
			} catch {
				return commandError("Invalid JSON payload");
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

			return commandSuccess(`Event emitted: ${event}\n`);
		} catch (error) {
			return handleCommandError(error);
		}
	},
};

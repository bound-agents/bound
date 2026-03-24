import type { CommandContext, CommandDefinition } from "@bound/sandbox";
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

			// Emit event via EventBus
			// @ts-expect-error - custom events require runtime type casting for dynamic event types
			ctx.eventBus.emit(event, payload);

			return commandSuccess(`Event emitted: ${event}\n`);
		} catch (error) {
			return handleCommandError(error);
		}
	},
};

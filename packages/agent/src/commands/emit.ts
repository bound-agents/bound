import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";

export const emit: CommandDefinition = {
	name: "emit",
	args: [
		{ name: "event", required: true, description: "Event name" },
		{ name: "payload", required: false, description: "Event payload as JSON" },
	],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			const event = args.event;
			const payloadStr = args.payload ? args.payload : "{}";

			let payload: Record<string, unknown>;
			try {
				payload = JSON.parse(payloadStr);
			} catch {
				return {
					stdout: "",
					stderr: "Error: Invalid JSON payload\n",
					exitCode: 1,
				};
			}

			// Emit event via EventBus
			// @ts-expect-error - custom events require runtime type casting for dynamic event types
			ctx.eventBus.emit(event, payload);

			return {
				stdout: `Event emitted: ${event}\n`,
				stderr: "",
				exitCode: 0,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				stdout: "",
				stderr: `Error: ${message}\n`,
				exitCode: 1,
			};
		}
	},
};

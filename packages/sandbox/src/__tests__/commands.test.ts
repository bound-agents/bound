import { describe, expect, test } from "bun:test";
import { createDatabase } from "@bound/core";
import type { Logger, TypedEventEmitter } from "@bound/shared";
import type { CommandDefinition } from "../commands";
import { createDefineCommands } from "../commands";

// Mock logger and event bus for testing
const mockLogger: Logger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
};

const mockEventBus: TypedEventEmitter = {
	on: () => {},
	emit: () => {},
	off: () => {},
};

describe("Command Framework", () => {
	test("handler executes and returns correct output", async () => {
		const definitions: CommandDefinition[] = [
			{
				name: "greet",
				args: [{ name: "name", required: true }],
				handler: async (args) => {
					return {
						stdout: `Hello, ${args.name}!\n`,
						stderr: "",
						exitCode: 0,
					};
				},
			},
		];

		const context = {
			db: createDatabase(":memory:"),
			siteId: "test-site",
			eventBus: mockEventBus,
			logger: mockLogger,
		};

		const commands = createDefineCommands(definitions, context);
		expect(commands.length).toBe(1);
		expect(commands[0]).toBeDefined();

		// Actually invoke the handler through the command
		const result = await commands[0].handler(["Alice"]);
		expect(result.stdout).toBe("Hello, Alice!\n");
		expect(result.exitCode).toBe(0);
	});

	test("command handler receives parsed arguments from argv", async () => {
		let receivedContext: unknown;

		const definitions: CommandDefinition[] = [
			{
				name: "test-cmd",
				args: [
					{ name: "arg1", required: true },
					{ name: "arg2", required: false },
				],
				handler: async (_args, ctx) => {
					receivedContext = ctx;
					return { stdout: "", stderr: "", exitCode: 0 };
				},
			},
		];

		const context = {
			db: createDatabase(":memory:"),
			siteId: "test-site",
			eventBus: mockEventBus,
			logger: mockLogger,
		};

		const commands = createDefineCommands(definitions, context);
		await commands[0].handler(["value1", "value2"]);

		expect(receivedContext).toEqual(context);
	});

	test("missing required argument returns error", async () => {
		const definitions: CommandDefinition[] = [
			{
				name: "needs-args",
				args: [{ name: "required-arg", required: true }],
				handler: async () => {
					return { stdout: "ok", stderr: "", exitCode: 0 };
				},
			},
		];

		const context = {
			db: createDatabase(":memory:"),
			siteId: "test-site",
			eventBus: mockEventBus,
			logger: mockLogger,
		};

		const commands = createDefineCommands(definitions, context);
		const result = await commands[0].handler([]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Missing required argument");
	});

	test("handler exception returns error result", async () => {
		const definitions: CommandDefinition[] = [
			{
				name: "failing",
				args: [],
				handler: async () => {
					throw new Error("Test error");
				},
			},
		];

		const context = {
			db: createDatabase(":memory:"),
			siteId: "test-site",
			eventBus: mockEventBus,
			logger: mockLogger,
		};

		const commands = createDefineCommands(definitions, context);
		const result = await commands[0].handler([]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Test error");
	});
});

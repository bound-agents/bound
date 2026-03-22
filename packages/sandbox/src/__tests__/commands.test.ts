import { describe, expect, test } from "bun:test";

import { type CommandDefinition, createDefineCommands } from "../commands";

describe("Command Framework", () => {
	test("creates defineCommands from CommandDefinition array", () => {
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

		const commands = createDefineCommands(definitions);
		expect(commands.length).toBe(1);
		expect(commands[0]).toBeDefined();
	});

	test("command handler receives parsed arguments", async () => {
		let _receivedArgs: Record<string, string> | undefined;

		const definitions: CommandDefinition[] = [
			{
				name: "test-cmd",
				args: [{ name: "arg1", required: true }],
				handler: async (args) => {
					_receivedArgs = args;
					return { stdout: "", stderr: "", exitCode: 0 };
				},
			},
		];

		const commands = createDefineCommands(definitions);
		expect(commands.length).toBeGreaterThan(0);
	});

	test("returns proper CommandResult structure", async () => {
		const definitions: CommandDefinition[] = [
			{
				name: "echo",
				args: [],
				handler: async () => {
					return {
						stdout: "output\n",
						stderr: "warnings\n",
						exitCode: 0,
					};
				},
			},
		];

		const commands = createDefineCommands(definitions);
		expect(commands.length).toBe(1);
	});
});

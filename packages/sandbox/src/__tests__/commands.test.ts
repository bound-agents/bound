import { describe, expect, test } from "bun:test";
import { createDatabase } from "@bound/core";
import type { Logger, TypedEventEmitter } from "@bound/shared";
import type { CommandDefinition } from "../commands";
import { createDefineCommands, loopContextStorage } from "../commands";

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

	// Bug #2: SQL queries with single quotes must reach the handler intact.
	// just-bash tokenizes the command string before our handler sees argv, so
	// a naive "commandName value with 'quotes'" splits on the single quotes.
	// Fix: executeToolCall uses --_json '<escaped-json>' encoding; createDefineCommands
	// decodes it so the handler receives the full query string.
	test("--_json encoded args survive single quotes in SQL queries", async () => {
		const sql = "SELECT * FROM users WHERE name = 'Alice' AND age > 30";
		let capturedQuery: string | undefined;

		const definitions: CommandDefinition[] = [
			{
				name: "query",
				args: [{ name: "query", required: true }],
				handler: async (args) => {
					capturedQuery = args.query;
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
		// Simulate what executeToolCall builds after the fix:
		// --_json '{"query":"...\\u0027Alice\\u0027..."}' → just-bash strips single quotes,
		// leaving the JSON string; handler decodes \u0027 back to '
		const jsonArg = JSON.stringify({ query: sql }).replace(/'/g, "\\u0027");
		const result = await commands[0].handler(["--_json", jsonArg]);

		expect(result.exitCode).toBe(0);
		expect(capturedQuery).toBe(sql);
	});

	// Bug: SQL queries passed as positional args were broken when the SQL contained
	// "=". The hasFlags heuristic treated `a.includes("=")` as a signal to enter
	// key=value parsing mode. A SQL string like "SELECT … WHERE x=1" is one argv
	// token that contains "=" — so hasFlags fired, the SQL got parsed as an
	// assignment (args["SELECT … WHERE x"] = "1"), and args.query ended up
	// undefined, causing sql.trim() to throw in the query handler.
	test("positional arg with = in value is not parsed as key=value", async () => {
		const sql = "SELECT * FROM semantic_memory WHERE deleted=0";
		let capturedQuery: string | undefined;

		const definitions: CommandDefinition[] = [
			{
				name: "query",
				args: [{ name: "query", required: true }],
				handler: async (args) => {
					capturedQuery = args.query;
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
		// Single-token SQL arg containing "=" — should reach args.query intact
		const result = await commands[0].handler([sql]);

		expect(result.exitCode).toBe(0);
		expect(capturedQuery).toBe(sql);
	});

	// Bug: when a command has both leading positional args and trailing --flags
	// (e.g. `emit event_name --payload json`), the hasFlags branch was triggered
	// (because --payload starts with "--") and all positional args were silently
	// dropped. args.event came back undefined, producing "Event emitted: undefined".
	test("leading positional arg followed by --flag is parsed correctly", async () => {
		let capturedEvent: string | undefined;
		let capturedPayload: string | undefined;

		const definitions: CommandDefinition[] = [
			{
				name: "emit",
				args: [
					{ name: "event", required: true },
					{ name: "payload", required: false },
				],
				handler: async (args) => {
					capturedEvent = args.event;
					capturedPayload = args.payload;
					return { stdout: `Event emitted: ${args.event}\n`, stderr: "", exitCode: 0 };
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
		// Simulates: emit test_event --payload '{"x":1}'
		const result = await commands[0].handler(["test_event", "--payload", '{"x":1}']);

		expect(result.exitCode).toBe(0);
		expect(capturedEvent).toBe("test_event");
		expect(capturedPayload).toBe('{"x":1}');
		expect(result.stdout).toBe("Event emitted: test_event\n");
	});

	test("memorize key value --source works (positional + flag)", async () => {
		let capturedKey: string | undefined;
		let capturedValue: string | undefined;
		let capturedSource: string | undefined;

		const definitions: CommandDefinition[] = [
			{
				name: "memorize",
				args: [
					{ name: "key", required: true },
					{ name: "value", required: true },
					{ name: "source", required: false },
				],
				handler: async (args) => {
					capturedKey = args.key;
					capturedValue = args.value;
					capturedSource = args.source;
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
		const result = await commands[0].handler(["my_key", "my_value", "--source", "agent"]);

		expect(result.exitCode).toBe(0);
		expect(capturedKey).toBe("my_key");
		expect(capturedValue).toBe("my_value");
		expect(capturedSource).toBe("agent");
	});

	test("key=value style args still work", async () => {
		let capturedKey: string | undefined;
		let capturedVal: string | undefined;

		const definitions: CommandDefinition[] = [
			{
				name: "set",
				args: [
					{ name: "key", required: true },
					{ name: "val", required: true },
				],
				handler: async (args) => {
					capturedKey = args.key;
					capturedVal = args.val;
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
		// key=value style: "key=foo" has no space before "="
		const result = await commands[0].handler(["key=foo", "val=bar"]);

		expect(result.exitCode).toBe(0);
		expect(capturedKey).toBe("foo");
		expect(capturedVal).toBe("bar");
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

// ctx.threadId and ctx.taskId must return the per-loop values injected via
// AsyncLocalStorage so that commands like `purge --last` and `schedule` can
// use the current thread/task ID without requiring it as an explicit argument.
describe("loopContextStorage — per-loop thread/task injection", () => {
	test("ctx.threadId returns undefined outside a loopContextStorage.run call", async () => {
		let capturedThreadId: string | undefined = "SENTINEL";

		const definitions: CommandDefinition[] = [
			{
				name: "probe",
				args: [],
				handler: async (_args, ctx) => {
					capturedThreadId = ctx.threadId;
					return { stdout: "", stderr: "", exitCode: 0 };
				},
			},
		];

		const context = {
			db: createDatabase(":memory:"),
			siteId: "test-site",
			eventBus: { on: () => {}, emit: () => {}, off: () => {} } as unknown as TypedEventEmitter,
			logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as Logger,
		};

		const commands = createDefineCommands(definitions, context);
		await commands[0].handler([]);

		// Outside loopContextStorage.run, threadId must be undefined
		expect(capturedThreadId).toBeUndefined();
	});

	test("ctx.threadId returns the threadId set by loopContextStorage.run", async () => {
		let capturedThreadId: string | undefined;

		const definitions: CommandDefinition[] = [
			{
				name: "probe",
				args: [],
				handler: async (_args, ctx) => {
					capturedThreadId = ctx.threadId;
					return { stdout: "", stderr: "", exitCode: 0 };
				},
			},
		];

		const context = {
			db: createDatabase(":memory:"),
			siteId: "test-site",
			eventBus: { on: () => {}, emit: () => {}, off: () => {} } as unknown as TypedEventEmitter,
			logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as Logger,
		};

		const commands = createDefineCommands(definitions, context);

		// Simulate what loopSandbox.exec does: wrap the call in loopContextStorage.run
		await loopContextStorage.run(
			{ threadId: "expected-thread-id", taskId: "expected-task-id" },
			() => commands[0].handler([]),
		);

		expect(capturedThreadId).toBe("expected-thread-id");
	});

	test("ctx.taskId returns the taskId set by loopContextStorage.run", async () => {
		let capturedTaskId: string | undefined;

		const definitions: CommandDefinition[] = [
			{
				name: "probe",
				args: [],
				handler: async (_args, ctx) => {
					capturedTaskId = ctx.taskId;
					return { stdout: "", stderr: "", exitCode: 0 };
				},
			},
		];

		const context = {
			db: createDatabase(":memory:"),
			siteId: "test-site",
			eventBus: { on: () => {}, emit: () => {}, off: () => {} } as unknown as TypedEventEmitter,
			logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as Logger,
		};

		const commands = createDefineCommands(definitions, context);

		await loopContextStorage.run({ threadId: "t1", taskId: "task-42" }, () =>
			commands[0].handler([]),
		);

		expect(capturedTaskId).toBe("task-42");
	});

	test("concurrent runs see their own threadId without interference", async () => {
		const results: string[] = [];

		const definitions: CommandDefinition[] = [
			{
				name: "slow-probe",
				args: [],
				handler: async (_args, ctx) => {
					// Yield to let the other concurrent run potentially interfere
					await new Promise<void>((r) => setTimeout(r, 5));
					results.push(ctx.threadId ?? "undefined");
					return { stdout: "", stderr: "", exitCode: 0 };
				},
			},
		];

		const context = {
			db: createDatabase(":memory:"),
			siteId: "test-site",
			eventBus: { on: () => {}, emit: () => {}, off: () => {} } as unknown as TypedEventEmitter,
			logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as Logger,
		};

		const commands = createDefineCommands(definitions, context);

		// Two concurrent runs with different threadIds — each must see its own
		await Promise.all([
			loopContextStorage.run({ threadId: "thread-A" }, () => commands[0].handler([])),
			loopContextStorage.run({ threadId: "thread-B" }, () => commands[0].handler([])),
		]);

		expect(results).toHaveLength(2);
		expect(results).toContain("thread-A");
		expect(results).toContain("thread-B");
		// Neither should have seen the other's threadId
		expect(results.filter((r) => r === "thread-A")).toHaveLength(1);
		expect(results.filter((r) => r === "thread-B")).toHaveLength(1);
	});
});

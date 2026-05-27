import { describe, expect, it } from "bun:test";
import {
	inferenceRequestPayloadSchema,
	streamChunkPayloadSchema,
	wsStreamChunkSchema,
} from "../relay-schemas";

describe("inferenceRequestPayloadSchema thinking field", () => {
	it("accepts payload with thinking config", () => {
		const payload = {
			model: "opus",
			messages: [{ role: "user", content: "hello" }],
			thinking: { type: "enabled", budget_tokens: 10000 },
		};
		const result = inferenceRequestPayloadSchema.safeParse(payload);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
		}
	});

	it("accepts payload without thinking config", () => {
		const payload = {
			model: "opus",
			messages: [{ role: "user", content: "hello" }],
		};
		const result = inferenceRequestPayloadSchema.safeParse(payload);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.thinking).toBeUndefined();
		}
	});

	it("rejects thinking with invalid type", () => {
		const payload = {
			model: "opus",
			messages: [{ role: "user", content: "hello" }],
			thinking: { type: "disabled", budget_tokens: 10000 },
		};
		const result = inferenceRequestPayloadSchema.safeParse(payload);
		expect(result.success).toBe(false);
	});

	it("rejects thinking with negative budget_tokens", () => {
		const payload = {
			model: "opus",
			messages: [{ role: "user", content: "hello" }],
			thinking: { type: "enabled", budget_tokens: -100 },
		};
		const result = inferenceRequestPayloadSchema.safeParse(payload);
		expect(result.success).toBe(false);
	});
});

describe("streamChunkPayloadSchema thinking field", () => {
	it("accepts payload with thinking content", () => {
		const payload = {
			thinking: "Let me analyze this...",
		};
		const result = streamChunkPayloadSchema.safeParse(payload);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.thinking).toBe("Let me analyze this...");
		}
	});

	it("accepts payload without thinking content", () => {
		const payload = {
			content: "Hello world",
		};
		const result = streamChunkPayloadSchema.safeParse(payload);
		expect(result.success).toBe(true);
	});
});

describe("inferenceRequestPayloadSchema native tool definitions", () => {
	it("native-tools.AC6.1: native tool ToolDefinitions round-trip through relay payload", () => {
		// Construct a ToolDefinition for a native tool (e.g., schedule)
		const nativeToolDefinition = {
			type: "function",
			function: {
				name: "schedule",
				description: "Schedule a task or event",
				parameters: {
					type: "object",
					properties: {
						action: {
							type: "string",
							enum: ["define", "run", "cancel", "list"],
							description: "The scheduling action to perform",
						},
						task_id: {
							type: "string",
							description: "The task ID",
						},
						cron_expr: {
							type: "string",
							description: "Cron expression for recurring tasks",
						},
					},
					required: ["action"],
					additionalProperties: false,
				},
			},
		};

		// Serialize through the relay payload schema
		const payload = {
			model: "claude-3-5-sonnet-20241022",
			messages: [
				{
					role: "user",
					content: "Hello, schedule something",
				},
			],
			tools: [nativeToolDefinition],
		};

		const result = inferenceRequestPayloadSchema.safeParse(payload);

		// Must parse successfully
		expect(result.success).toBe(true);

		// Verify the tools array is preserved in the parsed output
		if (result.success) {
			expect(result.data.tools).toBeDefined();
			expect(Array.isArray(result.data.tools)).toBe(true);
			expect(result.data.tools?.length).toBe(1);

			// Verify the tool definition structure is preserved
			const parsedTool = result.data.tools?.[0] as Record<string, unknown>;
			expect(parsedTool.type).toBe("function");
			expect((parsedTool.function as Record<string, unknown>).name).toBe("schedule");
			expect((parsedTool.function as Record<string, unknown>).description).toBe(
				"Schedule a task or event",
			);

			// Verify nested parameters schema is preserved
			const params = (parsedTool.function as Record<string, unknown>).parameters as Record<
				string,
				unknown
			>;
			expect(params.type).toBe("object");
			expect((params.properties as Record<string, unknown>).action).toBeDefined();
			expect(
				((params.properties as Record<string, unknown>).action as Record<string, unknown>).enum,
			).toContain("define");
		}
	});

	it("multiple native tools serialize through relay payload without loss", () => {
		// Multiple native tool definitions
		const tools = [
			{
				type: "function",
				function: {
					name: "query",
					description: "Query the database",
					parameters: {
						type: "object",
						properties: {
							sql: { type: "string" },
						},
						required: ["sql"],
						additionalProperties: false,
					},
				},
			},
			{
				type: "function",
				function: {
					name: "memorize",
					description: "Store a memory",
					parameters: {
						type: "object",
						properties: {
							key: { type: "string" },
							value: { type: "string" },
						},
						required: ["key", "value"],
						additionalProperties: false,
					},
				},
			},
		];

		const payload = {
			model: "claude-3-5-sonnet-20241022",
			messages: [{ role: "user", content: "test" }],
			tools,
		};

		const result = inferenceRequestPayloadSchema.safeParse(payload);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.tools?.length).toBe(2);
			const parsed = result.data.tools as Record<string, unknown>[];
			expect(
				((parsed[0].function as Record<string, unknown>).name as string).length,
			).toBeGreaterThan(0);
			expect(
				((parsed[1].function as Record<string, unknown>).name as string).length,
			).toBeGreaterThan(0);
		}
	});
});

describe("wsStreamChunkSchema — discriminated union validation", () => {
	it("accepts a text chunk", () => {
		const result = wsStreamChunkSchema.safeParse({ type: "text", content: "Hello" });
		expect(result.success).toBe(true);
	});

	it("accepts a thinking chunk with optional fields", () => {
		const result = wsStreamChunkSchema.safeParse({
			type: "thinking",
			content: "Reasoning...",
			signature: "sig123",
			redacted_data: undefined,
		});
		expect(result.success).toBe(true);
	});

	it("accepts a thinking chunk without optional fields", () => {
		const result = wsStreamChunkSchema.safeParse({
			type: "thinking",
			content: "Just thinking",
		});
		expect(result.success).toBe(true);
	});

	it("accepts tool_use_start", () => {
		const result = wsStreamChunkSchema.safeParse({
			type: "tool_use_start",
			id: "call-123",
			name: "query",
		});
		expect(result.success).toBe(true);
	});

	it("accepts tool_use_args", () => {
		const result = wsStreamChunkSchema.safeParse({
			type: "tool_use_args",
			id: "call-123",
			partial_json: '{"sql": "SELECT',
		});
		expect(result.success).toBe(true);
	});

	it("accepts tool_use_end", () => {
		const result = wsStreamChunkSchema.safeParse({
			type: "tool_use_end",
			id: "call-123",
		});
		expect(result.success).toBe(true);
	});

	it("accepts done chunk with full usage", () => {
		const result = wsStreamChunkSchema.safeParse({
			type: "done",
			usage: {
				input_tokens: 150,
				output_tokens: 42,
				cache_write_tokens: 1000,
				cache_read_tokens: null,
				estimated: false,
			},
		});
		expect(result.success).toBe(true);
	});

	it("accepts done chunk with cost_usd", () => {
		const result = wsStreamChunkSchema.safeParse({
			type: "done",
			usage: {
				input_tokens: 150,
				output_tokens: 42,
				cache_write_tokens: null,
				cache_read_tokens: null,
				estimated: true,
			},
			cost_usd: 0.0045,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe("done");
			if (result.data.type === "done") {
				expect(result.data.cost_usd).toBe(0.0045);
			}
		}
	});

	it("accepts error chunk", () => {
		const result = wsStreamChunkSchema.safeParse({
			type: "error",
			error: "Rate limit exceeded",
		});
		expect(result.success).toBe(true);
	});

	it("rejects heartbeat chunks (not part of WS schema)", () => {
		const result = wsStreamChunkSchema.safeParse({ type: "heartbeat" });
		expect(result.success).toBe(false);
	});

	it("rejects chunks with unknown type", () => {
		const result = wsStreamChunkSchema.safeParse({ type: "unknown_thing", data: "foo" });
		expect(result.success).toBe(false);
	});

	it("rejects text chunk missing content field", () => {
		const result = wsStreamChunkSchema.safeParse({ type: "text" });
		expect(result.success).toBe(false);
	});

	it("rejects done chunk missing usage", () => {
		const result = wsStreamChunkSchema.safeParse({ type: "done" });
		expect(result.success).toBe(false);
	});

	it("rejects done chunk with incomplete usage", () => {
		const result = wsStreamChunkSchema.safeParse({
			type: "done",
			usage: { input_tokens: 10 },
		});
		expect(result.success).toBe(false);
	});
});

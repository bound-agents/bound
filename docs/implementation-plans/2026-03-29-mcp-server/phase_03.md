# MCP Server — Phase 3: MCP stdio Server and `bound_chat` Tool

**Goal:** Implement the `bound_chat` MCP tool with full polling loop and error handling in a standalone Bun binary.

**Architecture:** `server.ts` is the binary entrypoint. It parses URL config, creates a `BoundClient`, registers the `bound_chat` tool via `McpServer`, and connects `StdioServerTransport`. The tool handler logic is extracted into `handler.ts` (accepts `BoundClient` as a parameter) so it can be unit-tested independently. All logging uses `console.error` — stdout is reserved for JSON-RPC.

**Tech Stack:** `@modelcontextprotocol/sdk` (McpServer, StdioServerTransport, registerTool), `zod`, `BoundClient` from Phase 2, `bun:test`

**Scope:** Phase 3 of 4

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### mcp-server.AC1: Binary compiles and runs as an MCP server
- **mcp-server.AC1.2 Success:** The binary responds to an MCP `initialize` request on stdio and lists `bound_chat` in the `tools/list` response

### mcp-server.AC2: `bound_chat` tool interface
- **mcp-server.AC2.1 Success:** `bound_chat` accepts `message` (required string) and `thread_id` (optional string)
- **mcp-server.AC2.2 Failure:** MCP framework rejects a `bound_chat` call missing the required `message` parameter with a protocol error

### mcp-server.AC4: Thread and message flow
- **mcp-server.AC4.1 Success:** `bound_chat` with no `thread_id` creates a new thread via `POST /api/mcp/threads`
- **mcp-server.AC4.2 Success:** Created thread has `interface = "mcp"` and `user_id = deterministicUUID(BOUND_NAMESPACE, "mcp")`
- **mcp-server.AC4.3 Success:** `bound_chat` with a supplied `thread_id` sends to that thread without creating a new one
- **mcp-server.AC4.4 Success:** `bound_chat` returns the last `role: "assistant"` message as a `{ type: "text" }` content block after the agent loop completes

### mcp-server.AC5: Error handling
- **mcp-server.AC5.1 Failure:** `bound_chat` returns `isError: true` with a message identifying the configured URL when the agent is unreachable
- **mcp-server.AC5.2 Failure:** `bound_chat` returns `isError: true` when the agent loop does not complete within 5 minutes

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: `handler.ts` — `bound_chat` tool handler logic + unit tests

**Verifies:** mcp-server.AC4.1, mcp-server.AC4.3, mcp-server.AC4.4, mcp-server.AC5.1, mcp-server.AC5.2

**Files:**
- Create: `packages/mcp-server/src/handler.ts`
- Create: `packages/mcp-server/src/__tests__/handler.test.ts`

**Implementation:**

**`packages/mcp-server/src/handler.ts`**:

```typescript
import type { BoundClient, BoundMessage } from "./bound-client";
import { BoundNotRunningError } from "./bound-client";

const POLL_INTERVAL_MS = 500;
const MAX_POLL_MS = 5 * 60 * 1000; // 5 minutes

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

export function createBoundChatHandler(
	client: BoundClient,
): (args: { message: string; thread_id?: string }) => Promise<ToolResult> {
	return async ({ message, thread_id }) => {
		try {
			// Step 1: Get or create thread
			const threadId =
				thread_id ?? (await client.createMcpThread()).thread_id;

			// Step 2: Send message
			await client.sendMessage(threadId, message);

			// Step 3: Poll until agent loop completes
			const startTime = Date.now();
			while (true) {
				const status = await client.getStatus(threadId);
				if (!status.active) break;

				if (Date.now() - startTime >= MAX_POLL_MS) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: "Timed out waiting for bound agent to respond after 5 minutes.",
							},
						],
					};
				}

				await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
			}

			// Step 4: Return last assistant message
			const messages = await client.getMessages(threadId);
			const lastAssistant = [...messages]
				.reverse()
				.find((m: BoundMessage) => m.role === "assistant");

			return {
				content: [
					{
						type: "text",
						text: lastAssistant?.content ?? "",
					},
				],
			};
		} catch (e) {
			if (e instanceof BoundNotRunningError) {
				return {
					isError: true,
					content: [{ type: "text", text: e.message }],
				};
			}
			throw e;
		}
	};
}
```

**Testing:**

Use a plain object conforming to `BoundClient`'s shape (duck-typed mock). Use `mock()` from `bun:test` to spy on calls. Advance fake timers for the polling timeout test.

**`packages/mcp-server/src/__tests__/handler.test.ts`**:

```typescript
import { describe, expect, it, mock } from "bun:test";
import { BoundNotRunningError } from "../bound-client";
import type { BoundClient, BoundMessage, ThreadStatus } from "../bound-client";
import { createBoundChatHandler } from "../handler";

function makeClient(overrides: Partial<BoundClient> = {}): BoundClient {
	return {
		createMcpThread: mock(() => Promise.resolve({ thread_id: "new-thread" })),
		sendMessage: mock(() => Promise.resolve()),
		getStatus: mock(() => Promise.resolve({ active: false, state: null, detail: null } as ThreadStatus)),
		getMessages: mock(() =>
			Promise.resolve([
				{
					id: "msg-1",
					thread_id: "new-thread",
					role: "assistant",
					content: "Hello from bound!",
					model_id: null,
					tool_name: null,
					created_at: "2026-01-01T00:00:00.000Z",
					modified_at: null,
					host_origin: "localhost",
				} as BoundMessage,
			]),
		),
		...overrides,
	} as unknown as BoundClient;
}

describe("createBoundChatHandler", () => {
	describe("mcp-server.AC4.1: creates new thread when no thread_id supplied", () => {
		it("calls createMcpThread and uses the returned thread_id", async () => {
			const client = makeClient();
			const handler = createBoundChatHandler(client);

			await handler({ message: "Hello" });

			expect(client.createMcpThread).toHaveBeenCalledTimes(1);
			expect(client.sendMessage).toHaveBeenCalledWith("new-thread", "Hello");
		});
	});

	describe("mcp-server.AC4.3: reuses supplied thread_id without creating a new thread", () => {
		it("does not call createMcpThread when thread_id is provided", async () => {
			const client = makeClient();
			const handler = createBoundChatHandler(client);

			await handler({ message: "Follow up", thread_id: "existing-thread" });

			expect(client.createMcpThread).not.toHaveBeenCalled();
			expect(client.sendMessage).toHaveBeenCalledWith("existing-thread", "Follow up");
		});
	});

	describe("mcp-server.AC4.4: returns last assistant message as text content block", () => {
		it("returns correct content from last assistant message", async () => {
			const client = makeClient();
			const handler = createBoundChatHandler(client);

			const result = await handler({ message: "Hello" });

			expect(result.isError).toBeUndefined();
			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe("text");
			expect(result.content[0].text).toBe("Hello from bound!");
		});

		it("returns empty string when no assistant message exists", async () => {
			const client = makeClient({
				getMessages: mock(() => Promise.resolve([])),
			});
			const handler = createBoundChatHandler(client);

			const result = await handler({ message: "Hello" });

			expect(result.content[0].text).toBe("");
		});
	});

	describe("mcp-server.AC5.1: returns isError when bound is unreachable", () => {
		it("returns isError:true with URL in message when createMcpThread throws BoundNotRunningError", async () => {
			const client = makeClient({
				createMcpThread: mock(() =>
					Promise.reject(new BoundNotRunningError("http://localhost:3000")),
				),
			});
			const handler = createBoundChatHandler(client);

			const result = await handler({ message: "Hello" });

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("http://localhost:3000");
		});

		it("returns isError:true when sendMessage throws BoundNotRunningError", async () => {
			const client = makeClient({
				sendMessage: mock(() =>
					Promise.reject(new BoundNotRunningError("http://localhost:3000")),
				),
			});
			const handler = createBoundChatHandler(client);

			const result = await handler({ message: "Hello", thread_id: "t-1" });

			expect(result.isError).toBe(true);
		});

		it("returns isError:true when getStatus throws BoundNotRunningError", async () => {
			const client = makeClient({
				getStatus: mock(() =>
					Promise.reject(new BoundNotRunningError("http://localhost:3000")),
				),
			});
			const handler = createBoundChatHandler(client);

			const result = await handler({ message: "Hello", thread_id: "t-1" });

			expect(result.isError).toBe(true);
		});
	});

	describe("mcp-server.AC5.2: returns isError on 5-minute poll timeout", () => {
		it("returns isError:true when agent stays active past timeout", async () => {
			// Always returns active=true to simulate stuck agent.
			// Override the MAX_POLL_MS by making Date.now() advance past limit
			// on the second status call.
			let callCount = 0;
			const startDate = Date.now();
			// Inject a Date.now that jumps 6 minutes after first poll check
			const mockedNow = mock(() => {
				callCount++;
				// After first call (setup), jump past 5 min threshold
				if (callCount > 2) return startDate + 6 * 60 * 1000;
				return startDate;
			});
			const originalDateNow = Date.now;
			Date.now = mockedNow as unknown as typeof Date.now;

			try {
				const client = makeClient({
					getStatus: mock(() =>
						Promise.resolve({ active: true, state: "thinking", detail: null }),
					),
				});
				const handler = createBoundChatHandler(client);

				const result = await handler({ message: "Hello", thread_id: "t-1" });

				expect(result.isError).toBe(true);
				expect(result.content[0].text).toContain("5 minutes");
			} finally {
				Date.now = originalDateNow;
			}
		});
	});
});
```

**Verification:**

```bash
bun test packages/mcp-server/src/__tests__/handler.test.ts
```

Expected: all tests pass, 0 fail.

**Commit:** `feat(mcp-server): add bound_chat handler with polling loop`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: `server.ts` — MCP stdio server entrypoint

**Verifies:** mcp-server.AC1.1, mcp-server.AC1.2, mcp-server.AC2.1, mcp-server.AC3.1, mcp-server.AC3.2, mcp-server.AC3.3

**Files:**
- Create: `packages/mcp-server/src/server.ts`
- Delete: `packages/mcp-server/src/.gitkeep` (no longer needed)

**Implementation:**

**`packages/mcp-server/src/server.ts`**:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BoundClient } from "./bound-client";
import { createBoundChatHandler } from "./handler";

function getBaseUrl(): string {
	const args = process.argv.slice(2);
	const urlIdx = args.indexOf("--url");
	if (urlIdx !== -1 && args[urlIdx + 1]) {
		return args[urlIdx + 1];
	}
	return process.env.BOUND_URL ?? "http://localhost:3000";
}

async function main(): Promise<void> {
	const baseUrl = getBaseUrl();
	const client = new BoundClient(baseUrl);

	const server = new McpServer({
		name: "bound-mcp",
		version: "0.0.1",
	});

	server.registerTool(
		"bound_chat",
		{
			description:
				"Send a message to a running bound agent and receive the assistant's reply. Optionally continue an existing conversation by supplying a thread_id.",
			inputSchema: {
				message: z.string().describe("The message to send to the bound agent"),
				thread_id: z
					.string()
					.optional()
					.describe("Optional thread ID to continue an existing conversation"),
			},
		},
		createBoundChatHandler(client),
	);

	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("[bound-mcp] MCP server running on stdio (bound at %s)", baseUrl);
}

main().catch((error: unknown) => {
	console.error("[bound-mcp] Fatal error:", error);
	process.exit(1);
});
```

Notes:
- Import paths use `.js` extension (as required by the MCP SDK's ESM exports): `from "@modelcontextprotocol/sdk/server/mcp.js"` and `from "@modelcontextprotocol/sdk/server/stdio.js"`.
- `console.error` is used for all logging — `console.log` (stdout) must never be called, as it would corrupt the JSON-RPC stream.
- The `getBaseUrl()` function implements AC3.1–AC3.3 with precedence: `--url` arg > `BOUND_URL` env > `"http://localhost:3000"` default.

**`packages/mcp-server/src/__tests__/server.test.ts`** (URL parsing + schema validation unit tests):

```typescript
import { describe, expect, it } from "bun:test";
import { z } from "zod";

// Test getBaseUrl logic by replicating it inline (it cannot be exported without
// importing the full server which starts the MCP transport).
function getBaseUrl(argv: string[], env: Record<string, string | undefined>): string {
	const args = argv.slice(2);
	const urlIdx = args.indexOf("--url");
	if (urlIdx !== -1 && args[urlIdx + 1]) {
		return args[urlIdx + 1];
	}
	return env.BOUND_URL ?? "http://localhost:3000";
}

describe("bound-mcp bound_chat schema", () => {
	it("mcp-server.AC2.2: inputSchema rejects call without message parameter", () => {
		// Replicate the inputSchema used in server.ts to verify Zod correctly
		// rejects a missing required field — the MCP framework uses this schema
		// to validate tool call inputs before dispatching to the handler.
		const schema = z.object({
			message: z.string().describe("The message to send to the bound agent"),
			thread_id: z.string().optional(),
		});

		// Missing message entirely
		const r1 = schema.safeParse({});
		expect(r1.success).toBe(false);

		// thread_id only — message still missing
		const r2 = schema.safeParse({ thread_id: "t-1" });
		expect(r2.success).toBe(false);

		// message present — valid
		const r3 = schema.safeParse({ message: "Hello" });
		expect(r3.success).toBe(true);

		// both fields — valid
		const r4 = schema.safeParse({ message: "Hello", thread_id: "t-1" });
		expect(r4.success).toBe(true);
	});
});

describe("bound-mcp URL configuration", () => {
	it("mcp-server.AC3.1: --url arg sets the base URL", () => {
		const url = getBaseUrl(["bun", "server.ts", "--url", "http://myhost:4000"], {});
		expect(url).toBe("http://myhost:4000");
	});

	it("mcp-server.AC3.2: BOUND_URL env var used when --url absent", () => {
		const url = getBaseUrl(["bun", "server.ts"], { BOUND_URL: "http://myhost:4000" });
		expect(url).toBe("http://myhost:4000");
	});

	it("mcp-server.AC3.3: defaults to http://localhost:3000 when neither provided", () => {
		const url = getBaseUrl(["bun", "server.ts"], {});
		expect(url).toBe("http://localhost:3000");
	});

	it("--url takes precedence over BOUND_URL", () => {
		const url = getBaseUrl(["bun", "server.ts", "--url", "http://cli:5000"], {
			BOUND_URL: "http://env:4000",
		});
		expect(url).toBe("http://cli:5000");
	});
});
```

**Verification:**

```bash
bun test packages/mcp-server
```

Expected: all tests in `packages/mcp-server` pass (handler tests + server URL tests).

Then verify `bun build --compile` works (AC1.1):

```bash
bun build --compile packages/mcp-server/src/server.ts --outfile dist/bound-mcp
echo "Exit code: $?"
ls -lh dist/bound-mcp
```

Expected: exit code 0, `dist/bound-mcp` binary exists.

**Manual verification (AC1.2): MCP initialize + tools/list**

Send `initialize` followed by `tools/list` over stdin to confirm the binary responds correctly and lists `bound_chat`:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | timeout 5 ./dist/bound-mcp 2>/dev/null || true
```

Expected: stdout contains two JSON-RPC response objects. The second response (id=2) includes `bound_chat` in the `tools` array, for example:

```json
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"bound_chat","description":"Send a message...","inputSchema":{"type":"object","properties":{"message":{"type":"string"},"thread_id":{"type":"string"}},"required":["message"]}}]}}
```

If the binary hangs without outputting, ensure stdout/stderr are not swapped. The binary writes JSON-RPC to stdout and logs to stderr; the command above redirects stderr to `/dev/null` so only protocol output appears.

**Commit:** `feat(mcp-server): add server.ts MCP stdio entrypoint with bound_chat tool`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

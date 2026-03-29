# MCP Server — Phase 2: `packages/mcp-server` Scaffold and BoundClient

**Goal:** Create the new `@bound/mcp-server` package with project boilerplate and a `BoundClient` HTTP client class that wraps all bound agent API calls.

**Architecture:** New Bun workspace package under `packages/mcp-server`. `BoundClient` uses native `fetch` with explicit error handling — on any connection failure or non-2xx response it throws `BoundNotRunningError`. Tests mock `global.fetch` (save/restore in `afterAll` per project convention).

**Tech Stack:** Bun monorepo, TypeScript 6 (bundler moduleResolution), `@bound/shared` (workspace dep), `@modelcontextprotocol/sdk@^1.28.0`, `zod`, `bun:test`

**Scope:** Phase 2 of 4

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### mcp-server.AC1: Binary compiles and runs as an MCP server
- **mcp-server.AC1.1 Success:** `bun build --compile packages/mcp-server/src/server.ts --outfile dist/bound-mcp` exits 0 and produces the binary

### mcp-server.AC3: Bound agent URL configuration
- **mcp-server.AC3.1 Success:** `--url <url>` CLI arg sets the bound agent base URL
- **mcp-server.AC3.2 Success:** `BOUND_URL` env var sets the base URL when `--url` is absent
- **mcp-server.AC3.3 Success:** Defaults to `http://localhost:3000` when neither is provided

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Package scaffold

**Verifies:** None (infrastructure task — verified operationally)

**Files:**
- Create: `packages/mcp-server/package.json`
- Create: `packages/mcp-server/tsconfig.json`
- Create: `packages/mcp-server/src/.gitkeep` (placeholder until server.ts in Phase 3)

**Implementation:**

**`packages/mcp-server/package.json`**:

```json
{
	"name": "@bound/mcp-server",
	"version": "0.0.1",
	"type": "module",
	"main": "src/server.ts",
	"types": "src/server.ts",
	"bin": {
		"bound-mcp": "src/server.ts"
	},
	"dependencies": {
		"@bound/shared": "workspace:*",
		"@modelcontextprotocol/sdk": "^1.28.0",
		"zod": "^4.0.0"
	}
}
```

Note: `zod@^4.0.0` must be listed explicitly — the codebase uses Zod v4 throughout. The MCP SDK's `inputSchema` parameter type is `ZodRawShape` (an object of Zod schemas). Zod v4 schemas for basic types (`z.string()`, `z.optional()`) are API-compatible with v3 at runtime and structurally compatible with `ZodRawShape` at the TypeScript level. After implementing Phase 3, verify with `bun tsc -p packages/mcp-server --noEmit`; if type errors arise on the `inputSchema` parameter specifically, add an explicit annotation: `inputSchema: { message: z.ZodString; thread_id: z.ZodOptional<z.ZodString> }` to satisfy the type checker.

**`packages/mcp-server/tsconfig.json`**:

```json
{
	"extends": "../../tsconfig.json",
	"compilerOptions": {
		"outDir": "dist",
		"rootDir": "src"
	},
	"exclude": [
		"src/**/*.test.ts",
		"src/**/*.integration.test.ts"
	]
}
```

**`packages/mcp-server/src/.gitkeep`**: empty file (placeholder).

Root `package.json` already has `"workspaces": ["packages/*"]` — the glob includes the new package automatically.

**`package.json` (root) — update `typecheck` script:**

Add `&& tsc -p packages/mcp-server --noEmit` to the end of the `typecheck` script so the new package is included in project-wide type checking:

```json
"typecheck": "tsc -p packages/shared --noEmit && tsc -p packages/core --noEmit && tsc -p packages/sync --noEmit && tsc -p packages/sandbox --noEmit && tsc -p packages/llm --noEmit && tsc -p packages/agent --noEmit && tsc -p packages/platforms --noEmit && tsc -p packages/web --noEmit && tsc -p packages/cli --noEmit && tsc -p packages/mcp-server --noEmit"
```

**Verification:**

```bash
bun install
```

Expected: installs without errors; `@bound/mcp-server` appears in workspace resolution.

```bash
bun tsc -p packages/mcp-server --noEmit 2>&1 | head -5
```

Expected: no errors (empty output — `src/` only has `.gitkeep`).

**Commit:** `chore(mcp-server): scaffold @bound/mcp-server package`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: `BoundClient` and `BoundNotRunningError` + unit tests

**Verifies:** mcp-server.AC1.1 (partially — package must compile), mcp-server.AC3.1, mcp-server.AC3.2, mcp-server.AC3.3

**Files:**
- Create: `packages/mcp-server/src/bound-client.ts`
- Create: `packages/mcp-server/src/__tests__/bound-client.test.ts`

**Implementation:**

**`packages/mcp-server/src/bound-client.ts`**:

```typescript
export class BoundNotRunningError extends Error {
	constructor(url: string) {
		super(`Bound agent is not running at ${url}.`);
		this.name = "BoundNotRunningError";
	}
}

export interface ThreadStatus {
	active: boolean;
	state: string | null;
	detail: string | null;
}

export interface BoundMessage {
	id: string;
	thread_id: string;
	role: string;
	content: string;
	model_id: string | null;
	tool_name: string | null;
	created_at: string;
	modified_at: string | null;
	host_origin: string;
}

export class BoundClient {
	constructor(private readonly baseUrl: string) {}

	async createMcpThread(): Promise<{ thread_id: string }> {
		try {
			const res = await fetch(`${this.baseUrl}/api/mcp/threads`, { method: "POST" });
			if (!res.ok) throw new BoundNotRunningError(this.baseUrl);
			return (await res.json()) as { thread_id: string };
		} catch (e) {
			if (e instanceof BoundNotRunningError) throw e;
			throw new BoundNotRunningError(this.baseUrl);
		}
	}

	async sendMessage(threadId: string, text: string): Promise<void> {
		try {
			const res = await fetch(`${this.baseUrl}/api/threads/${threadId}/messages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: text }),
			});
			if (!res.ok) throw new BoundNotRunningError(this.baseUrl);
		} catch (e) {
			if (e instanceof BoundNotRunningError) throw e;
			throw new BoundNotRunningError(this.baseUrl);
		}
	}

	async getStatus(threadId: string): Promise<ThreadStatus> {
		try {
			const res = await fetch(`${this.baseUrl}/api/threads/${threadId}/status`);
			if (!res.ok) throw new BoundNotRunningError(this.baseUrl);
			return (await res.json()) as ThreadStatus;
		} catch (e) {
			if (e instanceof BoundNotRunningError) throw e;
			throw new BoundNotRunningError(this.baseUrl);
		}
	}

	async getMessages(threadId: string): Promise<BoundMessage[]> {
		try {
			const res = await fetch(`${this.baseUrl}/api/threads/${threadId}/messages`);
			if (!res.ok) throw new BoundNotRunningError(this.baseUrl);
			return (await res.json()) as BoundMessage[];
		} catch (e) {
			if (e instanceof BoundNotRunningError) throw e;
			throw new BoundNotRunningError(this.baseUrl);
		}
	}
}
```

**Testing:**

Tests mock `global.fetch`. Per project convention (see Ollama driver tests), save and restore in `afterAll`.

**`packages/mcp-server/src/__tests__/bound-client.test.ts`**:

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { BoundClient, BoundNotRunningError } from "../bound-client";

// Save original fetch — must be restored to prevent polluting other test suites
let originalFetch: typeof fetch;
let mockFetch: ReturnType<typeof mock>;

beforeAll(() => {
	originalFetch = global.fetch;
});

afterAll(() => {
	global.fetch = originalFetch;
});

beforeEach(() => {
	mockFetch = mock(() => Promise.resolve(new Response()));
	global.fetch = mockFetch as unknown as typeof fetch;
});

describe("BoundClient", () => {
	const BASE_URL = "http://localhost:3000";
	let client: BoundClient;

	beforeEach(() => {
		client = new BoundClient(BASE_URL);
	});

	describe("createMcpThread", () => {
		it("POST /api/mcp/threads and returns thread_id", async () => {
			mockFetch.mockImplementation(() =>
				Promise.resolve(
					new Response(JSON.stringify({ thread_id: "abc-123" }), {
						status: 201,
						headers: { "Content-Type": "application/json" },
					}),
				),
			);

			const result = await client.createMcpThread();

			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
			expect(url).toBe(`${BASE_URL}/api/mcp/threads`);
			expect(init.method).toBe("POST");
			expect(result.thread_id).toBe("abc-123");
		});

		it("throws BoundNotRunningError on non-2xx response", async () => {
			mockFetch.mockImplementation(() =>
				Promise.resolve(new Response("Not found", { status: 404 })),
			);

			await expect(client.createMcpThread()).rejects.toBeInstanceOf(BoundNotRunningError);
		});

		it("throws BoundNotRunningError when fetch throws (connection refused)", async () => {
			mockFetch.mockImplementation(() => Promise.reject(new TypeError("fetch failed")));

			await expect(client.createMcpThread()).rejects.toBeInstanceOf(BoundNotRunningError);
		});
	});

	describe("sendMessage", () => {
		it("POST /api/threads/:id/messages with content body", async () => {
			mockFetch.mockImplementation(() =>
				Promise.resolve(new Response("{}", { status: 201 })),
			);

			await client.sendMessage("thread-1", "Hello!");

			const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
			expect(url).toBe(`${BASE_URL}/api/threads/thread-1/messages`);
			expect(init.method).toBe("POST");
			expect(JSON.parse(init.body as string)).toEqual({ content: "Hello!" });
		});

		it("throws BoundNotRunningError on non-2xx response", async () => {
			mockFetch.mockImplementation(() =>
				Promise.resolve(new Response("Error", { status: 500 })),
			);

			await expect(client.sendMessage("thread-1", "Hello!")).rejects.toBeInstanceOf(
				BoundNotRunningError,
			);
		});

		it("throws BoundNotRunningError when fetch throws", async () => {
			mockFetch.mockImplementation(() => Promise.reject(new TypeError("fetch failed")));

			await expect(client.sendMessage("thread-1", "Hi")).rejects.toBeInstanceOf(
				BoundNotRunningError,
			);
		});
	});

	describe("getStatus", () => {
		it("GET /api/threads/:id/status and returns status object", async () => {
			const statusPayload = { active: false, state: null, detail: null };
			mockFetch.mockImplementation(() =>
				Promise.resolve(
					new Response(JSON.stringify(statusPayload), {
						headers: { "Content-Type": "application/json" },
					}),
				),
			);

			const status = await client.getStatus("thread-1");

			const [url] = mockFetch.mock.calls[0] as [string];
			expect(url).toBe(`${BASE_URL}/api/threads/thread-1/status`);
			expect(status.active).toBe(false);
		});

		it("throws BoundNotRunningError on non-2xx response", async () => {
			mockFetch.mockImplementation(() =>
				Promise.resolve(new Response("Error", { status: 503 })),
			);

			await expect(client.getStatus("thread-1")).rejects.toBeInstanceOf(BoundNotRunningError);
		});

		it("throws BoundNotRunningError when fetch throws", async () => {
			mockFetch.mockImplementation(() => Promise.reject(new TypeError("fetch failed")));

			await expect(client.getStatus("thread-1")).rejects.toBeInstanceOf(BoundNotRunningError);
		});
	});

	describe("getMessages", () => {
		it("GET /api/threads/:id/messages and returns message array", async () => {
			const messages = [
				{
					id: "msg-1",
					thread_id: "thread-1",
					role: "assistant",
					content: "Hello!",
					model_id: null,
					tool_name: null,
					created_at: "2026-01-01T00:00:00.000Z",
					modified_at: null,
					host_origin: "localhost",
				},
			];
			mockFetch.mockImplementation(() =>
				Promise.resolve(
					new Response(JSON.stringify(messages), {
						headers: { "Content-Type": "application/json" },
					}),
				),
			);

			const result = await client.getMessages("thread-1");

			const [url] = mockFetch.mock.calls[0] as [string];
			expect(url).toBe(`${BASE_URL}/api/threads/thread-1/messages`);
			expect(result).toHaveLength(1);
			expect(result[0].role).toBe("assistant");
			expect(result[0].content).toBe("Hello!");
		});

		it("throws BoundNotRunningError on non-2xx response", async () => {
			mockFetch.mockImplementation(() =>
				Promise.resolve(new Response("Error", { status: 404 })),
			);

			await expect(client.getMessages("thread-1")).rejects.toBeInstanceOf(BoundNotRunningError);
		});

		it("throws BoundNotRunningError when fetch throws", async () => {
			mockFetch.mockImplementation(() => Promise.reject(new TypeError("fetch failed")));

			await expect(client.getMessages("thread-1")).rejects.toBeInstanceOf(BoundNotRunningError);
		});
	});

	describe("BoundNotRunningError", () => {
		it("message contains the base URL", () => {
			const err = new BoundNotRunningError("http://localhost:3000");
			expect(err.message).toContain("http://localhost:3000");
			expect(err.name).toBe("BoundNotRunningError");
		});
	});
});
```

**Verification:**

```bash
bun test packages/mcp-server/src/__tests__/bound-client.test.ts
```

Expected: all tests pass, 0 fail.

**Commit:** `feat(mcp-server): add BoundClient with BoundNotRunningError`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

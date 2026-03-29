# MCP Server — Phase 1: Bound Server Additions

**Goal:** Auto-provision the `mcp` system user at startup and expose `POST /api/mcp/threads`.

**Architecture:** Add an idempotent `ensureMcpUser` helper to `start.ts`, a new `createMcpRoutes` Hono factory, and wire the route into the app. The existing global DNS-rebinding middleware in `server/index.ts` covers the new route automatically.

**Tech Stack:** Bun monorepo, Hono, bun:sqlite, `@bound/core` (insertRow, getSiteId), `@bound/shared` (deterministicUUID, BOUND_NAMESPACE), `bun:test`

**Scope:** Phase 1 of 4

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### mcp-server.AC6: Bound server additions
- **mcp-server.AC6.1 Success:** `POST /api/mcp/threads` returns 201 with `{ thread_id: string }`
- **mcp-server.AC6.2 Success:** Thread created by `POST /api/mcp/threads` has `user_id = deterministicUUID(BOUND_NAMESPACE, "mcp")` and `interface = "mcp"`
- **mcp-server.AC6.3 Success:** The `mcp` system user exists in the DB after bound startup with no `allowlist.json` entry
- **mcp-server.AC6.4 Success:** `mcp` user provisioning is idempotent — repeated restarts do not create duplicate rows or error
- **mcp-server.AC6.5 Failure:** `POST /api/mcp/threads` rejects requests with non-localhost `Host` headers (DNS-rebinding protection)

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: `ensureMcpUser` helper + call in `start.ts` + unit tests

**Verifies:** mcp-server.AC6.3, mcp-server.AC6.4

**Files:**
- Modify: `packages/cli/src/commands/start.ts` (add exported helper + call after line 151)
- Create: `packages/cli/src/__tests__/mcp-user.test.ts`

**Implementation:**

In `packages/cli/src/commands/start.ts`, add the following exported function **before** the `start` function (so it can be imported in tests). Also add the call inside `start` after the allowlist seeding block (after the closing `}` at line 151):

```typescript
// Add this export near the top of the start.ts function definitions,
// before the start() function:
export function ensureMcpUser(db: Database, siteId: string): void {
	const now = new Date().toISOString();
	const mcpUserId = deterministicUUID(BOUND_NAMESPACE, "mcp");
	const existingMcpUser = db
		.query("SELECT id FROM users WHERE id = ?")
		.get(mcpUserId) as { id: string } | null;
	if (!existingMcpUser) {
		insertRow(
			db,
			"users",
			{
				id: mcpUserId,
				display_name: "mcp",
				platform_ids: null,
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
	}
}
```

Inside the `start` function body, immediately after the closing `}` of the user seeding block (after line 151), add:

```typescript
	// 5.1 Provision mcp system user (idempotent)
	ensureMcpUser(appContext.db, appContext.siteId);
```

The `insertRow`, `BOUND_NAMESPACE`, `deterministicUUID`, and `Database` imports are already present in `start.ts`. No new imports needed.

**Testing:**

`packages/cli/src/__tests__/mcp-user.test.ts`:
- mcp-server.AC6.3: call `ensureMcpUser` once, then query the DB — user row exists with `id = deterministicUUID(BOUND_NAMESPACE, "mcp")`, `display_name = "mcp"`, `deleted = 0`
- mcp-server.AC6.4: call `ensureMcpUser` twice on the same DB — no error is thrown, still exactly one row with that id

```typescript
import { describe, expect, it } from "bun:test";
import { applySchema, createDatabase } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { ensureMcpUser } from "../commands/start";

describe("ensureMcpUser", () => {
	it("mcp-server.AC6.3: creates mcp user row on first call", () => {
		const db = createDatabase(":memory:");
		applySchema(db);
		const siteId = "test-site";

		ensureMcpUser(db, siteId);

		const mcpUserId = deterministicUUID(BOUND_NAMESPACE, "mcp");
		const row = db
			.query("SELECT id, display_name, deleted FROM users WHERE id = ?")
			.get(mcpUserId) as { id: string; display_name: string; deleted: number } | null;

		expect(row).not.toBeNull();
		expect(row!.id).toBe(mcpUserId);
		expect(row!.display_name).toBe("mcp");
		expect(row!.deleted).toBe(0);
	});

	it("mcp-server.AC6.4: idempotent — second call does not throw or create duplicate", () => {
		const db = createDatabase(":memory:");
		applySchema(db);
		const siteId = "test-site";

		ensureMcpUser(db, siteId);
		ensureMcpUser(db, siteId); // must not throw

		const mcpUserId = deterministicUUID(BOUND_NAMESPACE, "mcp");
		const rows = db
			.query("SELECT id FROM users WHERE id = ?")
			.all(mcpUserId) as { id: string }[];

		expect(rows.length).toBe(1);
	});
});
```

**Verification:**

```bash
bun test packages/cli/src/__tests__/mcp-user.test.ts
```

Expected: 2 tests pass, 0 fail.

**Commit:** `feat(cli): add ensureMcpUser helper and provision mcp system user at startup`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: `createMcpRoutes` factory, route registration, and integration tests

**Verifies:** mcp-server.AC6.1, mcp-server.AC6.2, mcp-server.AC6.5

**Files:**
- Create: `packages/web/src/server/routes/mcp.ts`
- Modify: `packages/web/src/server/routes/index.ts` (add import + mcp key to return)
- Modify: `packages/web/src/server/index.ts` (mount at `/api/mcp`)
- Create: `packages/web/src/server/__tests__/mcp.integration.test.ts`

**Implementation:**

**`packages/web/src/server/routes/mcp.ts`** (new file):

```typescript
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { getSiteId, insertRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { Hono } from "hono";

export function createMcpRoutes(db: Database): Hono {
	const app = new Hono();

	app.post("/threads", (c) => {
		try {
			const threadId = randomUUID();
			const now = new Date().toISOString();
			const siteId = getSiteId(db);
			const mcpUserId = deterministicUUID(BOUND_NAMESPACE, "mcp");

			// Assign next palette color by cycling (0-9)
			const lastThread = db
				.query("SELECT color FROM threads ORDER BY created_at DESC LIMIT 1")
				.get() as { color: number } | null;
			const nextColor = lastThread !== null ? (lastThread.color + 1) % 10 : 0;

			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: mcpUserId,
					interface: "mcp",
					host_origin: "localhost",
					color: nextColor,
					title: "",
					summary: null,
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			return c.json({ thread_id: threadId }, 201);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to create thread", details: message }, 500);
		}
	});

	return app;
}
```

**`packages/web/src/server/routes/index.ts`** — add one import and one return key:

At the top imports block, add:
```typescript
import { createMcpRoutes } from "./mcp";
```

In the `return { ... }` block of `registerRoutes` (currently lines 33–40), add `mcp` as a new key:
```typescript
	return {
		threads: createThreadsRoutes(db, modelsConfig?.default, statusForwardCache),
		messages: createMessagesRoutes(db, eventBus),
		files: createFilesRoutes(db),
		status: createStatusRoutes(db, eventBus, hostName, siteId, modelsConfig, activeDelegations),
		tasks: createTasksRoutes(db),
		advisories: createAdvisoriesRoutes(db),
		mcp: createMcpRoutes(db),
	};
```

**`packages/web/src/server/index.ts`** — add one route mount after line 82:
```typescript
	app.route("/api/mcp", routes.mcp);
```
Place it immediately after `app.route("/api/advisories", routes.advisories)` (line 82).

**Testing:**

`packages/web/src/server/__tests__/mcp.integration.test.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, createDatabase } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { Hono } from "hono";
import { createApp } from "../index";
import { TypedEventEmitter } from "@bound/shared";

describe("POST /api/mcp/threads", () => {
	let db: Database;
	let app: Hono;

	beforeEach(async () => {
		db = createDatabase(":memory:");
		applySchema(db);
		const eventBus = new TypedEventEmitter();
		app = await createApp(db, eventBus);
	});

	it("mcp-server.AC6.1: returns 201 with thread_id", async () => {
		const res = await app.fetch(
			new Request("http://localhost/api/mcp/threads", { method: "POST" }),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { thread_id: string };
		expect(typeof body.thread_id).toBe("string");
		expect(body.thread_id.length).toBeGreaterThan(0);
	});

	it("mcp-server.AC6.2: thread has correct user_id and interface", async () => {
		const res = await app.fetch(
			new Request("http://localhost/api/mcp/threads", { method: "POST" }),
		);
		const body = (await res.json()) as { thread_id: string };
		const thread = db
			.query("SELECT user_id, interface FROM threads WHERE id = ?")
			.get(body.thread_id) as { user_id: string; interface: string } | null;
		expect(thread).not.toBeNull();
		expect(thread!.user_id).toBe(deterministicUUID(BOUND_NAMESPACE, "mcp"));
		expect(thread!.interface).toBe("mcp");
	});

	it("mcp-server.AC6.5: rejects non-localhost Host header with 400", async () => {
		const res = await app.fetch(
			new Request("http://evil.example.com/api/mcp/threads", {
				method: "POST",
				headers: { host: "evil.example.com" },
			}),
		);
		expect(res.status).toBe(400);
	});
});
```

**Verification:**

```bash
bun test packages/web/src/server/__tests__/mcp.integration.test.ts
```

Expected: 3 tests pass, 0 fail.

Then run the full web package tests to confirm nothing regressed:

```bash
bun test packages/web
```

Expected: all previously passing tests still pass.

**Commit:** `feat(web): add POST /api/mcp/threads route with mcp user attribution`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

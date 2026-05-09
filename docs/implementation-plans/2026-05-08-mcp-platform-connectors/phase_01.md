# MCP Platform Connectors Implementation Plan — Phase 1

**Goal:** Establish the infrastructure foundation: new synced table, dependencies, registry skeleton, and connector handle persistence helpers.

**Architecture:** Add `connector_handles` as a new LWW synced table, introduce `json-stable-stringify` and `@modelcontextprotocol/sdk` to `packages/platforms`, create a `PlatformMcpRegistry` skeleton that manages `InMemoryTransport` pairs, and provide CRUD helpers for connector handle rows via the outbox pattern.

**Tech Stack:** TypeScript, bun:sqlite (STRICT tables, WAL mode), @modelcontextprotocol/sdk (InMemoryTransport, Client, Server), json-stable-stringify

**Scope:** 7 phases from original design (phase 1 of 7)

**Codebase verified:** 2026-05-08

---

## Acceptance Criteria Coverage

This phase is infrastructure foundation. It does not directly verify any acceptance criteria — it provides the substrate for all subsequent phases.

**Verifies:** None (infrastructure phase — verified operationally via typecheck and build)

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Add `connector_handles` synced table to schema

**Files:**
- Modify: `packages/core/src/schema.ts` (add CREATE TABLE after existing synced tables)
- Modify: `packages/shared/src/types.ts` (add to SyncedTableName union + TABLE_REDUCER_MAP)
- Modify: `packages/core/src/schema-introspection.ts` (add to SYNCED_TABLE_NAMES array)
- Modify: `packages/sync/src/ws-transport.ts` (add to SNAPSHOT_TABLE_ORDER array)

**Implementation:**

In `packages/core/src/schema.ts`, add after the last CREATE TABLE for synced tables:

```sql
CREATE TABLE IF NOT EXISTS connector_handles (
  id            TEXT PRIMARY KEY,
  server_name   TEXT NOT NULL,
  event_name    TEXT NOT NULL,
  event_args    TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  cursor        TEXT,
  task_id       TEXT,
  created_at    TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  modified_at   TEXT NOT NULL
) STRICT;
```

In `packages/shared/src/types.ts`, add `"connector_handles"` to the `SyncedTableName` union type. Add `connector_handles: "lww"` to the `TABLE_REDUCER_MAP` constant.

In `packages/core/src/schema-introspection.ts`, add `"connector_handles"` to the `SYNCED_TABLE_NAMES` array (so the agent can see its schema in the `## Database Schema` system prompt block).

In `packages/sync/src/ws-transport.ts`, add `"connector_handles"` to `SNAPSHOT_TABLE_ORDER`. Place it after `"tasks"` since connector handles reference task IDs (no FK constraint, but logical dependency for seeding order).

**Verification:**
Run: `bun run typecheck`
Expected: All packages typecheck clean with the new table type in the union.

**Commit:** `feat(core): add connector_handles synced table`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add `SyncedTableRowMap` entry for connector_handles

**Files:**
- Modify: `packages/shared/src/types.ts` (add row type to SyncedTableRowMap if it exists, or add typed interface)

**Implementation:**

Check if `SyncedTableRowMap` exists in `packages/shared/src/types.ts`. If it does, add the `connector_handles` entry:

```typescript
export interface ConnectorHandleRow {
  id: string;
  server_name: string;
  event_name: string;
  event_args: string; // JSON string of event subscription arguments
  delivery_mode: string; // "push" | "poll"
  cursor: string | null;
  task_id: string | null;
  created_at: string; // ISO 8601
  deleted: number; // 0 | 1
  modified_at: string; // ISO 8601
}
```

If `SyncedTableRowMap` is a mapped type, add the entry. If the codebase uses untyped row access (common with bun:sqlite), export the interface for consumers to cast against.

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(shared): add ConnectorHandleRow type`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Add `json-stable-stringify` and `@modelcontextprotocol/sdk` dependencies

**Files:**
- Modify: `packages/platforms/package.json` (add dependencies)

**Implementation:**

Add to `packages/platforms/package.json` dependencies (rxjs already exists, only adding new entries):

```json
{
  "dependencies": {
    "@bound/core": "workspace:*",
    "@bound/llm": "workspace:*",
    "@bound/shared": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.28.0",
    "json-stable-stringify": "^1.3.0",
    "rxjs": "^7.8.2"
  },
  "devDependencies": {
    "@types/json-stable-stringify": "^1.0.36"
  }
}
```

Note: `rxjs` is already present; only `@modelcontextprotocol/sdk`, `json-stable-stringify`, and `@types/json-stable-stringify` are new additions. `rxjs` will be removed in Phase 7 after the old connector code is deleted.

Run `bun install` from the repository root to update the lockfile.

**Verification:**
Run: `bun install`
Expected: Installs without errors, lockfile updated.

Run: `cd packages/platforms && echo "import stableStringify from 'json-stable-stringify'; console.log(stableStringify({b:2,a:1}))" | bun run -`
Expected: Outputs `{"a":1,"b":2}` (keys sorted alphabetically).

**Commit:** `chore(platforms): add json-stable-stringify and MCP SDK deps`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Create connector handle ID generation utility

**Files:**
- Create: `packages/platforms/src/connector-handle-id.ts`

**Implementation:**

Create a utility that generates deterministic connector handle IDs from `(server_name, event_name, event_args)` tuples using stable JSON serialization and the existing `deterministicUUID` helper:

```typescript
import stableStringify from "json-stable-stringify";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";

/**
 * Generates a deterministic ID for a connector handle from its identity tuple.
 * Same inputs always produce the same UUID, regardless of key ordering in event_args.
 */
export function connectorHandleId(
  serverName: string,
  eventName: string,
  eventArgs: Record<string, unknown>,
): string {
  const key = stableStringify({ server: serverName, event: eventName, args: eventArgs });
  return deterministicUUID(BOUND_NAMESPACE, key!);
}
```

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck. The function composes existing utilities — deterministic output guaranteed by json-stable-stringify + deterministicUUID.

**Commit:** `feat(platforms): add connector handle ID generation`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->
<!-- START_TASK_5 -->
### Task 5: Create connector handle CRUD persistence helpers

**Files:**
- Create: `packages/platforms/src/connector-handle.ts`

**Implementation:**

Provide typed CRUD wrappers around the outbox helpers (`insertRow`, `updateRow`, `softDelete`) for the `connector_handles` table. These enforce the outbox pattern and provide type-safe access:

```typescript
import { type Database } from "bun:sqlite";
import { insertRow, updateRow, softDelete } from "@bound/core";
import { connectorHandleId } from "./connector-handle-id.js";

export interface ConnectorHandleCreateParams {
  serverName: string;
  eventName: string;
  eventArgs: Record<string, unknown>;
  deliveryMode: "push" | "poll";
  taskId: string | null;
  cursor?: string | null;
}

export interface ConnectorHandleRecord {
  id: string;
  server_name: string;
  event_name: string;
  event_args: string;
  delivery_mode: string;
  cursor: string | null;
  task_id: string | null;
  created_at: string;
  deleted: number;
  modified_at: string;
}

/**
 * Creates a new connector handle row via the outbox pattern.
 * Returns the deterministic ID.
 */
export function createConnectorHandle(
  db: Database,
  siteId: string,
  params: ConnectorHandleCreateParams,
): string {
  const id = connectorHandleId(params.serverName, params.eventName, params.eventArgs);
  const now = new Date().toISOString();
  insertRow(db, "connector_handles", {
    id,
    server_name: params.serverName,
    event_name: params.eventName,
    event_args: JSON.stringify(params.eventArgs),
    delivery_mode: params.deliveryMode,
    cursor: params.cursor ?? null,
    task_id: params.taskId,
    created_at: now,
    deleted: 0,
    modified_at: now,
  }, siteId);
  return id;
}

/**
 * Updates the cursor on a connector handle after successful batch delivery.
 */
export function updateConnectorHandleCursor(
  db: Database,
  siteId: string,
  handleId: string,
  cursor: string,
): void {
  updateRow(db, "connector_handles", handleId, { cursor }, siteId);
}

/**
 * Links a connector handle to its event task.
 */
export function linkConnectorHandleTask(
  db: Database,
  siteId: string,
  handleId: string,
  taskId: string,
): void {
  updateRow(db, "connector_handles", handleId, { task_id: taskId }, siteId);
}

/**
 * Soft-deletes a connector handle.
 */
export function deleteConnectorHandle(
  db: Database,
  siteId: string,
  handleId: string,
): void {
  softDelete(db, "connector_handles", handleId, siteId);
}

/**
 * Reads a single connector handle by ID. Returns null if not found or deleted.
 */
export function getConnectorHandle(
  db: Database,
  handleId: string,
): ConnectorHandleRecord | null {
  return db.query(
    "SELECT * FROM connector_handles WHERE id = ? AND deleted = 0"
  ).get(handleId) as ConnectorHandleRecord | null;
}

/**
 * Reads all active connector handles for a given server.
 */
export function getConnectorHandlesByServer(
  db: Database,
  serverName: string,
): ConnectorHandleRecord[] {
  return db.query(
    "SELECT * FROM connector_handles WHERE server_name = ? AND deleted = 0"
  ).all(serverName) as ConnectorHandleRecord[];
}

/**
 * Reads all active connector handles (used for reconnection after failover).
 */
export function getAllActiveConnectorHandles(
  db: Database,
): ConnectorHandleRecord[] {
  return db.query(
    "SELECT * FROM connector_handles WHERE deleted = 0"
  ).all() as ConnectorHandleRecord[];
}
```

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck. Functions compose existing `insertRow`/`updateRow`/`softDelete` from `@bound/core`.

**Commit:** `feat(platforms): add connector handle CRUD persistence helpers`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Unit tests for connector handle helpers

**Verifies:** Operational correctness of CRUD helpers (not a design AC, but validates the infrastructure works)

**Files:**
- Create: `packages/platforms/src/__tests__/connector-handle.test.ts`

**Implementation:**

Test the CRUD helpers using a real temporary SQLite database (following project conventions — no DB mocking):

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import { applySchema } from "@bound/core";
import {
  createConnectorHandle,
  getConnectorHandle,
  getConnectorHandlesByServer,
  getAllActiveConnectorHandles,
  updateConnectorHandleCursor,
  linkConnectorHandleTask,
  deleteConnectorHandle,
} from "../connector-handle.js";
import { connectorHandleId } from "../connector-handle-id.js";

describe("connector-handle CRUD", () => {
  let db: Database;
  let dbPath: string;
  const siteId = "test-site-001";

  beforeEach(() => {
    dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
    db = new Database(dbPath);
    applySchema(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    try { unlinkSync(dbPath); } catch {}
  });

  it("creates a handle with deterministic ID", () => {
    const id = createConnectorHandle(db, siteId, {
      serverName: "discord",
      eventName: "message.received",
      eventArgs: { channel_id: "123" },
      deliveryMode: "push",
      taskId: null,
    });

    const expected = connectorHandleId("discord", "message.received", { channel_id: "123" });
    expect(id).toBe(expected);

    const row = getConnectorHandle(db, id);
    expect(row).not.toBeNull();
    expect(row!.server_name).toBe("discord");
    expect(row!.event_name).toBe("message.received");
    expect(row!.delivery_mode).toBe("push");
    expect(row!.deleted).toBe(0);
  });

  it("produces same ID regardless of event_args key order", () => {
    const id1 = connectorHandleId("discord", "message.received", { a: 1, b: 2 });
    const id2 = connectorHandleId("discord", "message.received", { b: 2, a: 1 });
    expect(id1).toBe(id2);
  });

  it("updates cursor", () => {
    const id = createConnectorHandle(db, siteId, {
      serverName: "discord",
      eventName: "message.received",
      eventArgs: { channel_id: "456" },
      deliveryMode: "push",
      taskId: null,
    });

    updateConnectorHandleCursor(db, siteId, id, "cursor-abc");
    const row = getConnectorHandle(db, id);
    expect(row!.cursor).toBe("cursor-abc");
  });

  it("links task to handle", () => {
    const id = createConnectorHandle(db, siteId, {
      serverName: "discord",
      eventName: "message.received",
      eventArgs: { channel_id: "789" },
      deliveryMode: "poll",
      taskId: null,
    });

    linkConnectorHandleTask(db, siteId, id, "task-001");
    const row = getConnectorHandle(db, id);
    expect(row!.task_id).toBe("task-001");
  });

  it("soft-deletes a handle", () => {
    const id = createConnectorHandle(db, siteId, {
      serverName: "discord",
      eventName: "message.received",
      eventArgs: { channel_id: "999" },
      deliveryMode: "push",
      taskId: null,
    });

    deleteConnectorHandle(db, siteId, id);
    const row = getConnectorHandle(db, id);
    expect(row).toBeNull(); // hidden by deleted=0 filter
  });

  it("lists handles by server", () => {
    createConnectorHandle(db, siteId, {
      serverName: "discord",
      eventName: "message.received",
      eventArgs: { channel_id: "aaa" },
      deliveryMode: "push",
      taskId: null,
    });
    createConnectorHandle(db, siteId, {
      serverName: "discord",
      eventName: "interaction.received",
      eventArgs: { channel_id: "bbb" },
      deliveryMode: "push",
      taskId: null,
    });
    createConnectorHandle(db, siteId, {
      serverName: "slack",
      eventName: "message.received",
      eventArgs: { channel_id: "ccc" },
      deliveryMode: "poll",
      taskId: null,
    });

    const discordHandles = getConnectorHandlesByServer(db, "discord");
    expect(discordHandles.length).toBe(2);

    const slackHandles = getConnectorHandlesByServer(db, "slack");
    expect(slackHandles.length).toBe(1);
  });

  it("lists all active handles", () => {
    createConnectorHandle(db, siteId, {
      serverName: "discord",
      eventName: "message.received",
      eventArgs: { channel_id: "111" },
      deliveryMode: "push",
      taskId: null,
    });
    const deletedId = createConnectorHandle(db, siteId, {
      serverName: "discord",
      eventName: "message.received",
      eventArgs: { channel_id: "222" },
      deliveryMode: "push",
      taskId: null,
    });
    deleteConnectorHandle(db, siteId, deletedId);

    const all = getAllActiveConnectorHandles(db);
    expect(all.length).toBe(1);
  });

  it("generates changelog entries (outbox pattern)", () => {
    createConnectorHandle(db, siteId, {
      serverName: "discord",
      eventName: "message.received",
      eventArgs: { channel_id: "changelog-test" },
      deliveryMode: "push",
      taskId: null,
    });

    const entries = db.query(
      "SELECT * FROM change_log WHERE table_name = 'connector_handles'"
    ).all();
    expect(entries.length).toBeGreaterThan(0);
  });
});
```

**Verification:**
Run: `bun test packages/platforms/src/__tests__/connector-handle.test.ts`
Expected: All tests pass.

**Commit:** `test(platforms): add connector handle CRUD tests`
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_C -->

<!-- START_SUBCOMPONENT_D (tasks 7-8) -->
<!-- START_TASK_7 -->
### Task 7: Create `PlatformMcpRegistry` skeleton class

**Files:**
- Create: `packages/platforms/src/mcp-registry.ts`

**Implementation:**

Create the registry skeleton that manages InMemoryTransport pairs and MCP client/server connections. This phase only implements transport lifecycle — event subscriptions and tool discovery come in later phases:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Database } from "bun:sqlite";
import type { TypedEventEmitter } from "@bound/shared";
import type { Logger } from "@bound/shared";

export interface PlatformServerEntry {
  name: string;
  server: Server;
  client: Client;
  clientTransport: InMemoryTransport;
  serverTransport: InMemoryTransport;
}

export interface PlatformMcpRegistryDeps {
  db: Database;
  siteId: string;
  eventBus: TypedEventEmitter;
  logger: Logger;
}

/**
 * Manages MCP server instances for platform connectors.
 * Creates InMemoryTransport pairs, connects clients to servers,
 * and manages the lifecycle of platform MCP connections.
 */
export class PlatformMcpRegistry {
  private servers = new Map<string, PlatformServerEntry>();
  private deps: PlatformMcpRegistryDeps;

  constructor(deps: PlatformMcpRegistryDeps) {
    this.deps = deps;
  }

  /**
   * Registers a platform MCP server and establishes an in-process connection.
   * Creates an InMemoryTransport pair, connects client and server.
   */
  async registerServer(name: string, server: Server): Promise<PlatformServerEntry> {
    if (this.servers.has(name)) {
      throw new Error(`Platform server '${name}' already registered`);
    }

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client(
      { name: `bound-platform-${name}`, version: "1.0.0" },
      { capabilities: {} },
    );

    // Connect both sides — server connects to its transport, client connects to its transport
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const entry: PlatformServerEntry = {
      name,
      server,
      client,
      clientTransport,
      serverTransport,
    };

    this.servers.set(name, entry);
    this.deps.logger.info(`Platform MCP server '${name}' registered and connected`);

    return entry;
  }

  /**
   * Unregisters a platform MCP server and tears down its transport.
   */
  async unregisterServer(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry) {
      return;
    }

    await entry.client.close();
    await entry.server.close();
    this.servers.delete(name);
    this.deps.logger.info(`Platform MCP server '${name}' unregistered`);
  }

  /**
   * Returns the MCP client for a given platform server name.
   */
  getClient(name: string): Client | undefined {
    return this.servers.get(name)?.client;
  }

  /**
   * Returns all registered server names.
   */
  getServerNames(): string[] {
    return Array.from(this.servers.keys());
  }

  /**
   * Returns a server entry by name.
   */
  getServerEntry(name: string): PlatformServerEntry | undefined {
    return this.servers.get(name);
  }

  /**
   * Tears down all registered servers. Called on shutdown or leader loss.
   */
  async shutdown(): Promise<void> {
    const names = Array.from(this.servers.keys());
    for (const name of names) {
      await this.unregisterServer(name);
    }
  }
}
```

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): add PlatformMcpRegistry skeleton`
<!-- END_TASK_7 -->

<!-- START_TASK_8 -->
### Task 8: Update `packages/platforms/src/index.ts` exports

**Files:**
- Modify: `packages/platforms/src/index.ts` (add new exports)

**Implementation:**

Add exports for the new modules alongside existing exports:

```typescript
// New MCP-based platform connector exports
export { PlatformMcpRegistry } from "./mcp-registry.js";
export type { PlatformServerEntry, PlatformMcpRegistryDeps } from "./mcp-registry.js";
export { connectorHandleId } from "./connector-handle-id.js";
export {
  createConnectorHandle,
  getConnectorHandle,
  getConnectorHandlesByServer,
  getAllActiveConnectorHandles,
  updateConnectorHandleCursor,
  linkConnectorHandleTask,
  deleteConnectorHandle,
} from "./connector-handle.js";
export type { ConnectorHandleCreateParams, ConnectorHandleRecord } from "./connector-handle.js";
```

Keep all existing exports intact — the old platform connector code is still in use until Phase 7.

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck across all packages.

Run: `bun test packages/platforms`
Expected: All existing and new tests pass.

**Commit:** `feat(platforms): export new MCP registry and connector handle modules`
<!-- END_TASK_8 -->
<!-- END_SUBCOMPONENT_D -->

# MCP Platform Connectors Implementation Plan — Phase 7

**Goal:** Remove all legacy platform connector code, update config handling, clean package exports, and ensure the entire codebase typechecks cleanly with no references to the old system.

**Architecture:** Pure deletion and cleanup phase — remove old files, event types, webhook routes, and legacy type fields. Update exports to reflect the new MCP-based system.

**Tech Stack:** TypeScript (typecheck verification), git (file deletion)

**Scope:** 7 phases from original design (phase 7 of 7)

**Codebase verified:** 2026-05-08

---

## Acceptance Criteria Coverage

This phase implements and tests:

### mcp-platform-connectors.AC8: Config unchanged, legacy removed
- **mcp-platform-connectors.AC8.1 Success:** Existing `platforms.json` config loads without modification
- **mcp-platform-connectors.AC8.2 Success:** No references to old `PlatformConnector` interface remain in codebase
- **mcp-platform-connectors.AC8.3 Success:** `platform:deliver` and `platform:webhook` event types removed
- **mcp-platform-connectors.AC8.4 Success:** Webhook route `POST /hooks/:platform` removed
- **mcp-platform-connectors.AC8.5 Success:** All packages typecheck clean

---

<!-- START_TASK_1 -->
### Task 1: Delete legacy connector implementation files

**Verifies:** mcp-platform-connectors.AC8.2 (partially)

**Files:**
- Delete: `packages/platforms/src/connector.ts` (old PlatformConnector interface)
- Delete: `packages/platforms/src/registry.ts` (old PlatformConnectorRegistry)
- Delete: `packages/platforms/src/connectors/discord.ts` (old DiscordConnector, 815 lines)
- Delete: `packages/platforms/src/connectors/discord-interaction.ts` (old DiscordInteractionConnector, 742 lines)
- Delete: `packages/platforms/src/connectors/discord-client-manager.ts` (old shared client manager)

**Implementation:**

Delete each file:
```bash
git rm packages/platforms/src/connector.ts
git rm packages/platforms/src/registry.ts
git rm packages/platforms/src/connectors/discord.ts
git rm packages/platforms/src/connectors/discord-interaction.ts
git rm packages/platforms/src/connectors/discord-client-manager.ts
git rm packages/platforms/src/connectors/webhook-stub.ts
```

After deletion, run typecheck to identify all broken imports that need updating.

**Verification:**
Run: `bun run typecheck` (expect failures — they'll be fixed in subsequent tasks)
Expected: Type errors at import sites of deleted modules.

**Commit:** `refactor(platforms): delete legacy platform connector files`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Remove `platform:deliver` and `platform:webhook` event types

**Verifies:** mcp-platform-connectors.AC8.3

**Files:**
- Modify: `packages/shared/src/events.ts` (remove event types from EventMap)

**Implementation:**

Remove these entries from the `EventMap` interface:
```typescript
// REMOVE:
"platform:deliver": PlatformDeliverPayload;
"platform:webhook": { platform: string; rawBody: string; headers: Record<string, string> };
```

Also remove the `PlatformDeliverPayload` type definition if it's only used by these event types.

Remove any imports of these types or event names throughout the codebase. Search for:
- `"platform:deliver"` — all usages
- `"platform:webhook"` — all usages
- `PlatformDeliverPayload` — all imports

**Verification:**
Run: `grep -r "platform:deliver\|platform:webhook\|PlatformDeliverPayload" packages/ --include="*.ts" --include="*.js"`
Expected: No matches.

**Commit:** `refactor(shared): remove platform:deliver and platform:webhook event types`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Remove webhook route

**Verifies:** mcp-platform-connectors.AC8.4

**Files:**
- Modify: `packages/web/src/` (find and remove POST /hooks/:platform route)

**Implementation:**

Find the webhook route handler in `packages/web/`. It should be a Hono route like:
```typescript
app.post("/hooks/:platform", async (c) => { ... });
```

Remove the entire route handler. If it's in a separate file (e.g., `packages/web/src/routes/hooks.ts`), delete the file and remove its import/registration from the main app.

Search for references:
```bash
grep -r "hooks/:platform\|/hooks/" packages/web/ --include="*.ts"
```

**Verification:**
Run: `bun run typecheck`
Expected: No errors from removed route (imports already cleaned in Task 2).

**Commit:** `refactor(web): remove POST /hooks/:platform webhook route`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Update `packages/platforms/src/index.ts` exports

**Files:**
- Modify: `packages/platforms/src/index.ts`

**Implementation:**

Remove all exports from deleted files and ensure only new MCP-based modules are exported:

```typescript
// NEW exports (from Phases 1-6)
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
export { seedDispatcher, DISPATCHER_TASK_ID } from "./dispatcher.js";
export {
  createConnectorListTool,
  createConnectorChannelsTool,
  createConnectorAttachTool,
} from "./dispatcher-tools.js";
export type { DispatcherToolContext } from "./dispatcher-tools.js";

// Preserved (unchanged)
export { PlatformLeaderElection } from "./leader-election.js";

// Server factories
export { createDiscordServer } from "./connectors/discord-server.js";

// REMOVED: connector.ts, registry.ts, discord.ts, discord-interaction.ts, discord-client-manager.ts exports
```

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck across platforms package.

**Commit:** `refactor(platforms): update package exports for MCP-based system`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Remove `platformTools` from AgentLoopConfig and update IntakePayload

**Files:**
- Modify: `packages/agent/src/types.ts` (remove platformTools field from AgentLoopConfig)
- Modify: `packages/shared/src/relay-schemas.ts` or wherever IntakePayload is defined (remove user_id field)

**Implementation:**

In `AgentLoopConfig` (packages/agent/src/types.ts), remove the legacy `platformTools` field:
```typescript
// REMOVE:
platformTools?: Map<string, { toolDefinition: ToolDefinition; execute: (input: Record<string, unknown>) => Promise<string> }>;
```

Platform tools now come exclusively through the unified `toolRegistry` field, populated by `PlatformMcpRegistry.getToolsForThread()`.

In `IntakePayload` schema/type, remove `user_id` field (design specifies no users table linkage):
```typescript
// REMOVE from IntakePayload:
user_id: z.string().min(1),
```

Update all call sites that construct IntakePayload to no longer include `user_id`.

Also remove the legacy platform tool dispatch path in `agent-loop.ts` (the waterfall fallback that checks `this.config.platformTools?.get(toolCall.name)`).

**Verification:**
Run: `bun run typecheck`
Expected: Type errors at any remaining references to removed fields — fix them all.

**Commit:** `refactor(agent): remove legacy platformTools field and update IntakePayload`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Fix all remaining import errors and verify full typecheck

**Verifies:** mcp-platform-connectors.AC8.2, mcp-platform-connectors.AC8.5

**Files:**
- Various files with broken imports from deleted modules

**Implementation:**

Run `bun run typecheck` and fix ALL remaining errors:

1. Find all imports of `PlatformConnector`, `PlatformConnectorRegistry`, `DiscordConnector`, `DiscordInteractionConnector`, `DiscordClientManager` and remove or replace them
2. Find all references to `connector.deliver()`, `connector.verifyDelivery()`, `connector.getPlatformTools()`, `connector.onLoopComplete()` and remove them
3. Find all references to `deliverPlatformPayload`, `runPostLoopDeliveryCheck` and remove them
4. Update any test files that reference deleted modules

Search for remaining references:
```bash
grep -r "PlatformConnector\|PlatformConnectorRegistry\|DiscordConnector\|DiscordInteractionConnector\|DiscordClientManager" packages/ --include="*.ts" --include="*.js" -l
grep -r "deliverPlatformPayload\|verifyDelivery\|runPostLoopDeliveryCheck" packages/ --include="*.ts" -l
grep -r "getPlatformTools\|onLoopComplete" packages/ --include="*.ts" -l
```

Fix each reference until zero matches remain (AC8.2).

**Verification:**
Run: `bun run typecheck`
Expected: ALL packages typecheck clean (AC8.5).

Run: `bun test --recursive`
Expected: All tests pass.

**Commit:** `refactor: fix all remaining legacy platform connector references`
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Verify config compatibility

**Verifies:** mcp-platform-connectors.AC8.1

**Files:**
- Verify: `packages/shared/src/config-schemas.ts` (platformsConfig schema unchanged)

**Implementation:**

Verify that the `platforms.json` Zod schema has NOT changed. The `connectorConfigSchema` should still accept:
```json
{
  "connectors": [
    {
      "platform": "discord",
      "token": "...",
      "allowed_users": ["user_id_1", "user_id_2"],
      "leadership": "auto",
      "failover_threshold_ms": 30000
    }
  ]
}
```

The new MCP server factory (`createDiscordServer`) reads from the same `PlatformConnectorConfig` type. No schema changes should have been necessary. Verify by:
1. Reading the current schema definition
2. Confirming it matches the documented shape
3. Testing with a sample platforms.json

```bash
# Verify schema hasn't changed from original:
grep -A 20 "connectorConfigSchema" packages/shared/src/config-schemas.ts
```

If any field was inadvertently modified during implementation, restore it.

**Verification:**
Run: `bun run packages/cli/src/bound.ts init --help` (verify no schema parse errors with existing config)
Expected: No errors related to platforms.json parsing.

**Commit:** `chore: verify platforms.json config compatibility`
<!-- END_TASK_7 -->

<!-- START_TASK_8 -->
### Task 8: Remove legacy test files

**Files:**
- Delete or update: `packages/platforms/src/__tests__/discord-connector.test.ts` (if exists)
- Delete or update: `packages/platforms/src/__tests__/intake-pipeline.integration.test.ts` (if references old connector)
- Update: any other test files referencing legacy connector code

**Implementation:**

Remove test files that test the old connector system:
```bash
git rm packages/platforms/src/__tests__/discord-connector.test.ts
```

For integration tests like `intake-pipeline.integration.test.ts`, either:
- Delete if they test only the old system
- Update if they test relay intake behavior that still exists (just update to use new registry)

Run tests to find any remaining failures:
```bash
bun test packages/platforms
```

Fix any test failures caused by removed modules.

**Verification:**
Run: `bun test --recursive`
Expected: All tests pass. No test references deleted modules.

**Commit:** `test(platforms): remove legacy connector test files`
<!-- END_TASK_8 -->

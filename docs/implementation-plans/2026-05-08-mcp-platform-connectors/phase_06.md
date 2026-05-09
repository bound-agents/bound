# MCP Platform Connectors Implementation Plan — Phase 6

**Goal:** Wire the new `PlatformMcpRegistry` into the startup sequence, integrate with leader election (only leader instantiates), update relay intake routing, and remove legacy delivery verification.

**Architecture:** Replace `PlatformConnectorRegistry` instantiation in `server.ts` with `PlatformMcpRegistry`, wire into relay processor, seed the dispatcher task at startup, advertise `hosts.platforms` from the new registry, gate MCP server instantiation behind leader election, and remove `verifyDelivery`/`deliverPlatformPayload` paths.

**Tech Stack:** TypeScript, bun:sqlite (cluster_config), PlatformLeaderElection, relay outbox

**Scope:** 7 phases from original design (phase 6 of 7)

**Codebase verified:** 2026-05-08

---

## Acceptance Criteria Coverage

This phase implements and tests:

### mcp-platform-connectors.AC6: Leader election and failover
- **mcp-platform-connectors.AC6.1 Success:** Only leader host instantiates MCP server + transport pair
- **mcp-platform-connectors.AC6.2 Success:** Non-leader hosts have no MCP server, no platform tools, no subscriptions
- **mcp-platform-connectors.AC6.5 Success:** `hosts.platforms` advertised correctly for relay platform affinity routing

### mcp-platform-connectors.AC7: Relay intake preserved
- **mcp-platform-connectors.AC7.1 Success:** Event listener writes relay intake entries with platform field
- **mcp-platform-connectors.AC7.2 Success:** Hub routes intake to host with platform affinity (leader)
- **mcp-platform-connectors.AC7.3 Success:** `executeProcess()` injects platform tools from new registry

---

<!-- START_TASK_1 -->
### Task 1: Bootstrap PlatformMcpRegistry in startup sequence

**Verifies:** mcp-platform-connectors.AC6.1, mcp-platform-connectors.AC6.5

**Files:**
- Modify: `packages/cli/src/commands/start/server.ts` (replace old registry creation with new)

**Implementation:**

In `initServer()` (around line 855), replace the old `PlatformConnectorRegistry` creation with `PlatformMcpRegistry`:

```typescript
// Replace old platform registry instantiation:
// const platformRegistry = new PlatformConnectorRegistry(appContext, platformsConfig);
// platformRegistry.start();

// NEW:
import { PlatformMcpRegistry, seedDispatcher } from "@bound/platforms";
import { createDiscordServer } from "@bound/platforms/connectors/discord-server";

const platformMcpRegistry = new PlatformMcpRegistry({
  db: appContext.db,
  siteId: appContext.siteId,
  eventBus: appContext.eventBus,
  logger: appContext.logger,
});

// Register platform servers based on config (only if leader — see Task 2)
for (const connectorConfig of platformsConfig.connectors) {
  if (connectorConfig.platform === "discord" || connectorConfig.platform === "discord-interaction") {
    const server = createDiscordServer(connectorConfig);
    await platformMcpRegistry.registerServer(connectorConfig.platform, server);
  }
}
```

Seed the dispatcher task after registry creation:
```typescript
seedDispatcher(appContext.db, appContext.siteId);
```

Advertise `hosts.platforms` from the new registry:
```typescript
const platformNames = platformMcpRegistry.getServerNames();
if (platformNames.length > 0) {
  updateRow(appContext.db, "hosts", appContext.siteId, {
    platforms: JSON.stringify(platformNames),
  }, appContext.siteId);
}
```

Wire the `connector:list_changed` event to scheduler's onEvent:
```typescript
appContext.eventBus.on("connector:list_changed", (payload) => {
  scheduler.onEvent("connector:list_changed", payload);
});
appContext.eventBus.on("connector:event", (payload) => {
  scheduler.onEvent("connector:event", payload);
});
```

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(cli): bootstrap PlatformMcpRegistry in startup sequence`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Integrate leader election with MCP server instantiation

**Verifies:** mcp-platform-connectors.AC6.1, mcp-platform-connectors.AC6.2

**Files:**
- Modify: `packages/cli/src/commands/start/server.ts` (gate server creation behind leader election)
- Modify: `packages/platforms/src/leader-election.ts` (or create adapter)

**Implementation:**

The existing `PlatformLeaderElection` class calls `connector.connect()` on leadership gain and `connector.disconnect()` on loss. Adapt this pattern for the new MCP registry:

Create an adapter that wraps `PlatformMcpRegistry` operations behind the connector interface expected by leader election:

```typescript
// In server.ts, after creating platformMcpRegistry:
const mcpLeaderAdapter = {
  platform: "mcp-platforms", // aggregate identifier
  delivery: "broadcast" as const,
  async connect() {
    // On leadership gain: register all servers and reconnect subscriptions
    for (const connectorConfig of platformsConfig.connectors) {
      if (connectorConfig.platform === "discord" || connectorConfig.platform === "discord-interaction") {
        const server = createDiscordServer(connectorConfig);
        await platformMcpRegistry.registerServer(connectorConfig.platform, server);
      }
    }
    // Reconstitute subscriptions from DB
    await platformMcpRegistry.reconnectAll();
  },
  async disconnect() {
    // On leadership loss: tear down all servers and subscriptions
    await platformMcpRegistry.shutdown();
  },
  // Other PlatformConnector methods are no-ops for the adapter
  async deliver() {},
};
```

Use existing `PlatformLeaderElection` with this adapter:
```typescript
const leaderElection = new PlatformLeaderElection(
  mcpLeaderAdapter,
  platformsConfig.connectors[0], // use first config for leadership settings
  appContext.db,
  appContext.siteId,
);
await leaderElection.start();
```

Non-leader hosts (AC6.2): `platformMcpRegistry` exists but has no registered servers, no tools, no subscriptions. `getServerNames()` returns empty array. `getToolsForThread()` returns empty map.

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(cli): integrate leader election with MCP server lifecycle`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Update relay processor to use new registry

**Verifies:** mcp-platform-connectors.AC7.3

**Files:**
- Modify: `packages/agent/src/relay-processor.ts` (inject PlatformMcpRegistry, use for tool scoping)

**Implementation:**

Add `PlatformMcpRegistry` as a dependency on the relay processor. Replace the old `platformConnectorRegistry` reference:

1. Add constructor parameter or setter: `setPlatformMcpRegistry(registry: PlatformMcpRegistry)`
2. In `runDelegatedLoop()`, replace old tool injection (lines 1571-1585) with new registry-based scoping (as designed in Phase 5 Task 4)
3. Remove `verifyDelivery` post-loop check (the entire block around lines 1616-1650)
4. Remove `deliverPlatformPayload` method (lines 1746-1786) and all call sites

The relay processor should NOT call `connector.deliver()` directly anymore — all outbound communication goes through MCP tools (which the agent calls via tool_call → execute closure → mcpClient.callTool).

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(agent): update relay processor to use PlatformMcpRegistry`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Wire relay intake from MCP event listener

**Verifies:** mcp-platform-connectors.AC7.1, mcp-platform-connectors.AC7.2

**Files:**
- Modify: `packages/platforms/src/mcp-registry.ts` (add intake writing on event delivery)

**Implementation:**

When the connector handle infrastructure delivers a batch to a task thread, it should also write a relay intake entry so that multi-host clusters can route correctly:

In `deliverBatch()`, after persisting the developer-role message, write the relay outbox entry:

```typescript
// After insertRow for the developer-role message:
if (this.hubSiteId && this.hubSiteId !== this.deps.siteId) {
  // Multi-host mode: write intake for hub routing
  writeOutbox(this.deps.db, {
    id: randomUUID(),
    source_site_id: this.deps.siteId,
    target_site_id: this.hubSiteId,
    kind: "intake",
    ref_id: null,
    idempotency_key: `intake:${subscription.serverName}:${newEvents[0].eventId}`,
    stream_id: null,
    payload: JSON.stringify({
      platform: subscription.serverName,
      platform_event_id: newEvents[0].eventId,
      thread_id: subscription.threadId,
      message_id: messageId, // ID of the developer-role message just persisted
      content: batchContent,
      attachments: [],
    }),
    created_at: now,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  });
}
```

The hub's existing `selectIntakeHost()` already does Tier 0 platform affinity routing by checking `hosts.platforms` — no changes needed there (AC7.2). The leader host advertises its platforms in `hosts.platforms`, so intake routes back to it.

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): write relay intake entries on event delivery`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Remove old platform:deliver and platform:webhook event handlers

**Files:**
- Modify: `packages/cli/src/commands/start/server.ts` (remove old event bus handlers)
- Modify: `packages/agent/src/relay-processor.ts` (remove deliverPlatformPayload and its call sites)

**Implementation:**

Remove the event bus registrations for `platform:deliver` and `platform:webhook`:
- In server.ts, find and remove `eventBus.on("platform:deliver", ...)` handler
- In server.ts, find and remove `eventBus.on("platform:webhook", ...)` handler
- In relay-processor.ts, remove the `deliverPlatformPayload()` private method
- In relay-processor.ts, remove all call sites of `deliverPlatformPayload()`
- Remove `runPostLoopDeliveryCheck()` import and its usage in server.ts

These paths are no longer needed because:
- Outbound delivery now goes through MCP tools (agent calls discord_send_message → execute closure → mcpClient.callTool)
- Delivery verification is dropped per design (incompatible with new execution model)
- Webhooks are excluded from scope

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

Run: `bun test --recursive`
Expected: All tests pass (some may need updating if they reference removed handlers).

**Commit:** `refactor(cli): remove legacy platform:deliver and platform:webhook handlers`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Integration test for startup and relay routing

**Verifies:** mcp-platform-connectors.AC6.1, mcp-platform-connectors.AC6.2, mcp-platform-connectors.AC6.5, mcp-platform-connectors.AC7.1, mcp-platform-connectors.AC7.2, mcp-platform-connectors.AC7.3

**Files:**
- Create: `packages/platforms/src/__tests__/relay-integration.integration.test.ts`

**Testing:**

Tests verify the full startup → leader election → event delivery → relay routing chain:

- **AC6.1**: Start with leader election → verify MCP servers registered only on leader
- **AC6.2**: Start second instance as standby → verify no servers, no tools, no subscriptions
- **AC6.5**: After leader starts → verify hosts.platforms contains server names in DB
- **AC7.1**: Emit event from MCP server → verify relay outbox entry written with platform field
- **AC7.2**: Simulate hub routing with two hosts (one with platforms, one without) → verify intake routes to platform host
- **AC7.3**: Simulate executeProcess with thread bound to connector handle → verify platform tools injected from new registry

Test setup:
- Two temp DBs simulating two hosts
- Mock leader election (force one leader, one standby)
- Verify DB state for relay outbox entries and hosts.platforms

**Verification:**
Run: `bun test packages/platforms/src/__tests__/relay-integration.integration.test.ts`
Expected: All tests pass.

**Commit:** `test(platforms): add relay integration and leader election tests`
<!-- END_TASK_6 -->

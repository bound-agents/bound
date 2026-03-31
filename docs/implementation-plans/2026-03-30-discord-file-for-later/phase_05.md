# Discord "File for Later" Implementation Plan — Phase 5

**Goal:** Wire both DiscordConnector and DiscordInteractionConnector through PlatformConnectorRegistry from a single `platform: "discord"` config entry, with shared leader election and interface-based delivery routing.

**Architecture:** The registry detects `platform === "discord"` and creates a DiscordClientManager plus both connectors. A compound connector wrapper drives the lifecycle: `clientManager.connect()` → `dmConnector.connect()` → `interactionConnector.connect()` (reverse on disconnect). One PlatformLeaderElection governs the compound connector. A `connectorsByPlatform` map routes `platform:deliver` events to the correct connector: "discord" → DiscordConnector, "discord-interaction" → DiscordInteractionConnector. Both share the same leader election check. DiscordConnector's connect/disconnect are updated to no longer drive the clientManager lifecycle (the compound connector handles it).

**Tech Stack:** TypeScript, bun:test

**Scope:** 5 phases from original design (phase 5 of 5)

**Codebase verified:** 2026-03-30

---

## Acceptance Criteria Coverage

This phase implements and tests:

### discord-file-for-later.AC5: DiscordClientManager (continued from Phase 1)
- **discord-file-for-later.AC5.2 Success:** Both connectors register event handlers on the same client instance
- **discord-file-for-later.AC5.3 Success:** `disconnect()` destroys client and both connectors' handlers are cleaned up

### discord-file-for-later.AC7: Registry integration
- **discord-file-for-later.AC7.1 Success:** Single `{ "platform": "discord" }` config entry creates both `DiscordConnector` and `DiscordInteractionConnector`
- **discord-file-for-later.AC7.2 Success:** `platform:deliver` for thread with `interface = 'discord'` routes to `DiscordConnector.deliver()`
- **discord-file-for-later.AC7.3 Success:** `platform:deliver` for thread with `interface = 'discord-interaction'` routes to `DiscordInteractionConnector.deliver()`
- **discord-file-for-later.AC7.4 Success:** Both connectors share one `PlatformLeaderElection` and connect/disconnect together

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Remove lifecycle driving from DiscordConnector

**Files:**
- Modify: `packages/platforms/src/connectors/discord.ts` (modified in Phase 1)

**Implementation:**

Phase 1 added `clientManager.connect(token)` and `clientManager.disconnect()` calls to DiscordConnector's `connect()` and `disconnect()` methods. Phase 5 moves lifecycle control to the registry's compound connector. Remove these calls.

**In `connect()` — remove the manager lifecycle call:**

```typescript
async connect(_hostBaseUrl?: string): Promise<void> {
    // Token validation removed — registry validates before creating connectors
    // clientManager.connect() removed — compound connector drives lifecycle

    const client = this.clientManager.getClient();
    const { ChannelType } = await import("discord.js");

    // ... rest of handler registration unchanged
}
```

Remove the `config.token` check from connect() — the compound connector already validated and passed the token to clientManager.connect(). The connector's connect() now only registers event handlers.

**In `disconnect()` — remove the manager lifecycle call:**

```typescript
async disconnect(): Promise<void> {
    for (const threadId of this.typingTimers.keys()) {
        this.stopTyping(threadId);
    }
    try {
        const client = this.clientManager.getClient();
        if (this.onClientReady) client.off("clientReady", this.onClientReady);
        if (this.onMessageCreate) client.off("messageCreate", this.onMessageCreate);
    } catch {
        // Client already disconnected
    }
    this.onClientReady = null;
    this.onMessageCreate = null;
    // clientManager.disconnect() removed — compound connector drives lifecycle
}
```

**Verification:**
Run: `tsc -p packages/platforms --noEmit`
Expected: No type errors

**Commit:** `refactor(platforms): remove lifecycle driving from DiscordConnector`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Update DiscordConnector tests for lifecycle change

**Files:**
- Modify: `packages/platforms/src/__tests__/discord-connector.test.ts` (modified in Phase 1)

**Implementation:**

Since DiscordConnector.connect() no longer calls clientManager.connect(), tests that relied on the connector driving the lifecycle may need updates. The mock clientManager's `getClient()` now needs to return a valid mock client (since connect() calls `getClient()` directly without first calling `connect()`).

Update `createMockClientManager()` to return a mock that:
- `getClient()` returns a mock client with `on()` / `off()` stubs
- `connect()` and `disconnect()` are no-ops

This matches the Phase 5 reality where the registry drives the manager lifecycle before calling connector.connect().

**Verification:**
Run: `bun test packages/platforms/src/__tests__/discord-connector.test.ts`
Expected: All existing tests pass

**Commit:** `test(platforms): update DiscordConnector tests for registry-driven lifecycle`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-5) -->

<!-- START_TASK_3 -->
### Task 3: Modify PlatformConnectorRegistry for dual-connector Discord support

**Verifies:** discord-file-for-later.AC7.1, discord-file-for-later.AC7.4

**Files:**
- Modify: `packages/platforms/src/registry.ts` (108 lines)

**Implementation:**

Add a `connectorsByPlatform` map alongside the existing `elections` map. Modify `createConnector()` to return an array for the "discord" case with a compound connector for the election. Modify `platform:deliver` routing to use the new map.

**Add import at top:**

```typescript
import { DiscordClientManager } from "./connectors/discord-client-manager.js";
import { DiscordInteractionConnector } from "./connectors/discord-interaction.js";
```

**Add new private field:**

```typescript
private connectorsByPlatform = new Map<string, { connector: PlatformConnector; electionKey: string }>();
```

**Rewrite `start()` method:**

```typescript
start(): void {
    for (const connectorConfig of this.platformsConfig.connectors) {
        if (connectorConfig.platform === "discord") {
            this.startDiscord(connectorConfig);
        } else {
            this.startSingleConnector(connectorConfig);
        }
    }

    // Route platform:deliver to the correct connector (leader only)
    this.ctx.eventBus.on("platform:deliver", (payload) => {
        const entry = this.connectorsByPlatform.get(payload.platform);
        if (!entry) return;
        const election = this.elections.get(entry.electionKey);
        if (!election?.isLeader()) return;
        entry.connector
            .deliver(payload.thread_id, payload.message_id, payload.content, payload.attachments)
            .catch((err) => {
                this.ctx.logger.error("Deliver failed", {
                    platform: payload.platform,
                    error: String(err),
                });
            });
    });

    // Route platform:webhook to the correct connector (leader only).
    // Note: For Discord, webhooks only route to the DM connector ("discord" key
    // in connectorsByPlatform). Interactions arrive via the gateway's interactionCreate
    // event, not webhooks, so "discord-interaction" never receives webhook events.
    this.ctx.eventBus.on("platform:webhook", (payload) => {
        const entry = this.connectorsByPlatform.get(payload.platform);
        if (!entry) return;
        const election = this.elections.get(entry.electionKey);
        if (!election?.isLeader()) return;
        entry.connector.handleWebhookPayload?.(payload.rawBody, payload.headers).catch((err) => {
            this.ctx.logger.error("Webhook handling failed", {
                platform: payload.platform,
                error: String(err),
            });
        });
    });
}
```

**Add `startDiscord()` method — AC7.1, AC7.4:**

```typescript
private startDiscord(connectorConfig: PlatformConnectorConfig): void {
    const token = connectorConfig.token;
    if (!token) {
        throw new Error("Discord connector requires a token in platforms.json");
    }

    const clientManager = new DiscordClientManager(this.ctx.logger);

    const dmConnector = new DiscordConnector(
        connectorConfig,
        this.ctx.db,
        this.ctx.siteId,
        this.ctx.eventBus,
        this.ctx.logger,
        clientManager,
    );

    const interactionConnector = new DiscordInteractionConnector(
        connectorConfig,
        this.ctx.db,
        this.ctx.siteId,
        this.ctx.eventBus,
        this.ctx.logger,
        clientManager,
    );

    // Compound connector for the election — drives lifecycle for both
    const compoundConnector: PlatformConnector = {
        platform: "discord",
        delivery: "broadcast" as const,
        async connect(hostBaseUrl?: string): Promise<void> {
            await clientManager.connect(token);
            await dmConnector.connect(hostBaseUrl);
            await interactionConnector.connect(hostBaseUrl);
        },
        async disconnect(): Promise<void> {
            await interactionConnector.disconnect();
            await dmConnector.disconnect();
            await clientManager.disconnect();
        },
        async deliver(): Promise<void> {
            // Delivery routing handled by registry, not compound connector
        },
    };

    const election = new PlatformLeaderElection(
        compoundConnector,
        connectorConfig,
        this.ctx.db,
        this.ctx.siteId,
        this.hostBaseUrl,
    );

    this.elections.set("discord", election);
    this.connectorsByPlatform.set("discord", { connector: dmConnector, electionKey: "discord" });
    this.connectorsByPlatform.set("discord-interaction", {
        connector: interactionConnector,
        electionKey: "discord",
    });

    election.start().catch((err) => {
        this.ctx.logger.error("Leader election failed to start", {
            platform: "discord",
            error: String(err),
        });
    });
}
```

**Add `startSingleConnector()` method** (extracted from current logic):

```typescript
private startSingleConnector(connectorConfig: PlatformConnectorConfig): void {
    const connector = this.createConnector(connectorConfig);

    const election = new PlatformLeaderElection(
        connector,
        connectorConfig,
        this.ctx.db,
        this.ctx.siteId,
        this.hostBaseUrl,
    );

    this.elections.set(connectorConfig.platform, election);
    this.connectorsByPlatform.set(connectorConfig.platform, {
        connector,
        electionKey: connectorConfig.platform,
    });

    election.start().catch((err) => {
        this.ctx.logger.error("Leader election failed to start", {
            platform: connectorConfig.platform,
            error: String(err),
        });
    });
}
```

**Update `getConnector()` method:**

```typescript
getConnector(platform: string): PlatformConnector | undefined {
    return this.connectorsByPlatform.get(platform)?.connector;
}
```

**Update `stop()` method:**

```typescript
stop(): void {
    for (const election of this.elections.values()) {
        election.stop();
    }
    this.elections.clear();
    this.connectorsByPlatform.clear();
}
```

**Update `createConnector()` — remove "discord" case (handled by startDiscord):**

```typescript
private createConnector(config: PlatformConnectorConfig): PlatformConnector {
    switch (config.platform) {
        case "webhook-stub":
            return new WebhookStubConnector();
        default:
            throw new Error(`Unknown platform: ${config.platform}`);
    }
}
```

**Verification:**
Run: `tsc -p packages/platforms --noEmit`
Expected: No type errors

**Commit:** `feat(platforms): dual-connector Discord support in PlatformConnectorRegistry`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Write registry integration tests

**Verifies:** discord-file-for-later.AC7.1, discord-file-for-later.AC7.2, discord-file-for-later.AC7.3, discord-file-for-later.AC7.4

**Files:**
- Modify: `packages/platforms/src/__tests__/registry.test.ts`

**Testing:**

Add a new `describe("Discord dual-connector")` block. Tests need a real SQLite database and mock connectors to verify the registry correctly creates and routes between Discord connectors.

Since the registry now creates real DiscordConnector and DiscordInteractionConnector for "discord" configs, and these depend on discord.js (dynamic import), the integration tests should either:
1. Mock discord.js at the module level, OR
2. Test the routing logic separately from connector creation

Recommended: Test the routing behavior by creating the registry, then verifying that `getConnector("discord")` and `getConnector("discord-interaction")` return different connector instances. For delivery routing, emit `platform:deliver` events and verify the correct connector's `deliver()` is called.

**IMPORTANT: Update existing `platform:deliver` routing test.** The existing test at `registry.test.ts:136-195` injects directly into the `elections` map to test routing. Phase 5's rewritten `start()` routes via `connectorsByPlatform` instead of `elections`. The existing test MUST be updated to also inject into `connectorsByPlatform` (or refactored to use `startSingleConnector()` via a test-platform config entry). Without this update, the existing routing test will fail because the new `platform:deliver` handler looks up `connectorsByPlatform` first. Verify the existing test passes after updating.

**AC test cases:**

- **AC7.1 (dual creation)**: Create registry with a single `{ platform: "discord", token: "test" }` config. Verify `getConnector("discord")` returns a DiscordConnector instance. Verify `getConnector("discord-interaction")` returns a DiscordInteractionConnector instance. Verify both are non-null and different objects.

- **AC7.2 (DM routing)**: Set up registry. Create a thread in the DB with `interface = 'discord'`. Emit `platform:deliver` with `platform = "discord"` and the thread's ID. Verify DiscordConnector's `deliver()` was called (spy or mock). Verify DiscordInteractionConnector's `deliver()` was NOT called.

- **AC7.3 (interaction routing)**: Set up registry. Create a thread with `interface = 'discord-interaction'`. Emit `platform:deliver` with `platform = "discord-interaction"` and the thread's ID. Verify DiscordInteractionConnector's `deliver()` was called. Verify DiscordConnector's `deliver()` was NOT called.

- **AC5.2 (both connectors on same client)**: After the compound connector's `connect()` completes, verify the mock client's `on()` method was called with both `"messageCreate"` (from DiscordConnector) and `"interactionCreate"` (from DiscordInteractionConnector). This proves both connectors registered event handlers on the same Discord.js Client instance.

- **AC5.3 (complete disconnect sequence)**: Call the compound connector's `disconnect()`. Verify the following sequence:
  1. `interactionConnector.disconnect()` called (removes `interactionCreate` handler via `client.off()`)
  2. `dmConnector.disconnect()` called (removes `messageCreate` and `clientReady` handlers via `client.off()`)
  3. `clientManager.disconnect()` called (calls `client.destroy()`)
  Verify `client.off()` was called for both `"messageCreate"` and `"interactionCreate"` event types. Verify `client.destroy()` is called last.

- **AC7.4 (shared election)**: Verify that calling `registry.stop()` disconnects both connectors (both `disconnect()` methods called). Verify that the compound connector's `connect()` calls `clientManager.connect()`, `dmConnector.connect()`, and `interactionConnector.connect()` in order.

Note: Since PlatformLeaderElection requires writing to `cluster_config` in the DB, these tests need the full schema applied. The leader election behavior (heartbeat, failover) is already tested in `leader-election.test.ts` — these tests focus on the dual-connector routing.

Follow project testing patterns in:
- `packages/platforms/src/__tests__/registry.test.ts` (existing mock connector pattern)
- Root `CLAUDE.md` lines 123-131 (testing conventions)

**Verification:**
Run: `bun test packages/platforms/src/__tests__/registry.test.ts`
Expected: All tests pass (existing + new)

**Commit:** `test(platforms): add dual-connector Discord registry tests`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Verify full test suite and finalize exports

**Files:**
- Verify: `packages/platforms/src/index.ts` (should already export DiscordClientManager, DiscordConnector, DiscordInteractionConnector from Phase 2)

**Verification:**
Run: `bun test packages/platforms`
Expected: All platform tests pass

Run: `tsc -p packages/platforms --noEmit`
Expected: No type errors

Run: `bun test --recursive`
Expected: All project tests pass (no regressions from registry changes)

**Commit:** `feat(platforms): complete Discord File for Later registry integration`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_B -->

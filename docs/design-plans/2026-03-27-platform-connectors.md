# Platform Connectors Design

## Summary

This design completes the service-channel specification by adding a generalized platform connector layer that decouples message intake, processing, and delivery from Discord-specific code. The core innovation is a dual-delivery-model framework: broadcast connectors (like Discord) maintain persistent platform connections with automatic leader election and failover, while exclusive-delivery connectors (webhooks for Telegram/Slack) register a URL and receive events via HTTP, re-registering on failover. A new relay intake pipeline routes incoming platform messages to the most-appropriate host based on thread affinity, model availability, or tool compatibility.

This is paired with cross-host event broadcast (the `emit` command now sends `event_broadcast` relay messages that fan out to all cluster nodes), AbortSignal plumbing for real HTTP-level LLM cancellation, and schema generalization to remove Discord-specific columns (`users.discord_id` → `users.platform_ids` JSON). The implementation creates a new `packages/platforms/` package with the `PlatformConnector` interface and `PlatformLeaderElection` state machine, migrates existing Discord bot logic into a connector implementation, and deletes the standalone `@bound/discord` package. All three new relay kinds (`intake`, `platform_deliver`, `event_broadcast`) are wired through the `RelayProcessor` with idempotency, routing logic, and event emission.

## Definition of Done

All remaining work from the service-channel spec (`docs/design/specs/2026-03-25-service-channel.md`) is implemented:

1. **Schema migrations**: `users.discord_id` → `users.platform_ids` (JSON object), `hosts.platforms` column added, `threads.interface` type generalized beyond `"web" | "discord"`, `allowlist.json` schema updated from per-user `discord_id` to `platforms` object — all handled via the migration runner with `ALTER TABLE`.
2. **Config**: `platforms.json` config schema + loader added (replaces `discord.json`). `discord.json` removed from supported optional configs.
3. **Relay kinds**: `intake`, `platform_deliver`, and `event_broadcast` added to `RELAY_KINDS` with typed payloads in shared. RelayProcessor handles these kinds.
4. **`emit` command**: broadcasts `event_broadcast` via relay outbox after firing locally; remote hosts receive it and fire their local schedulers.
5. **`platforms` package** (new): `PlatformConnector` interface + leader election + failover logic + Discord connector (migrated from `discord` package) + one exclusive-delivery stub connector (to be deleted when a real exclusive-delivery integration ships).
6. **Discord migrated**: uses relay intake pipeline — no direct agent loop on message receipt, no hostname-based pinning, no `discord.json`.
7. **`discord` package**: deleted from the monorepo.
8. **LLM driver AbortSignal**: `ChatParams.signal?: AbortSignal` wired through all four LLM drivers (Anthropic, Bedrock, OpenAI-compatible, Ollama), resolving the existing TODO in `relay-processor.ts`.

## Acceptance Criteria

### platform-connectors.AC1: Schema migrations applied correctly
- **platform-connectors.AC1.1 Success:** `users` table has `platform_ids TEXT` column after migration
- **platform-connectors.AC1.2 Success:** Rows with existing `discord_id` have `platform_ids` populated as `{"discord":"<id>"}` after migration
- **platform-connectors.AC1.3 Success:** `discord_id` column no longer exists after migration
- **platform-connectors.AC1.4 Success:** `hosts` table has `platforms TEXT` column after migration
- **platform-connectors.AC1.5 Success:** `threads.interface` accepts values other than `"web"` and `"discord"` (e.g. `"telegram"`)
- **platform-connectors.AC1.6 Failure:** `allowlist.json` with `discord_id` field fails validation with message referencing `platforms.discord`
- **platform-connectors.AC1.7 Success:** `allowlist.json` with `platforms.discord` passes validation

### platform-connectors.AC2: Config schema and loader
- **platform-connectors.AC2.1 Success:** `platforms.json` with valid Discord connector config loads successfully
- **platform-connectors.AC2.2 Failure:** `platforms.json` with invalid `leadership` value (`"manual"`) fails Zod validation
- **platform-connectors.AC2.3 Success:** `configSchemaMap` has no entry for `"discord.json"`
- **platform-connectors.AC2.4 Success:** `DiscordConfig` / `discordSchema` are not exported from `@bound/shared`

### platform-connectors.AC3: Relay kind handlers (intake, platform_deliver, event_broadcast)
- **platform-connectors.AC3.1 Success:** `"intake"`, `"platform_deliver"`, `"event_broadcast"` are all in `RELAY_REQUEST_KINDS`
- **platform-connectors.AC3.2 Success:** Duplicate `intake` with same `platform` + `platform_event_id` is discarded (idempotency)
- **platform-connectors.AC3.3 Success:** Intake routing selects host with active loop for the thread (thread affinity)
- **platform-connectors.AC3.4 Success:** Intake routing selects host that has the thread's model when no affinity
- **platform-connectors.AC3.5 Success:** Intake routing selects host with most matching `mcp_tools` when no model match
- **platform-connectors.AC3.6 Success:** Intake routing falls back to least-loaded host when no other signal
- **platform-connectors.AC3.7 Success:** `platform_deliver` receipt emits `"platform:deliver"` on `eventBus`
- **platform-connectors.AC3.8 Success:** `event_broadcast` receipt fires event on local `eventBus` with correct `event_depth`
- **platform-connectors.AC3.9 Success:** `target_site_id="*"` fan-out writes one outbox entry per spoke, excluding source spoke

### platform-connectors.AC4: emit command cross-host broadcast
- **platform-connectors.AC4.1 Success:** `emit` writes `event_broadcast` relay entry when hub is in `cluster_config`
- **platform-connectors.AC4.2 Success:** `emit` does NOT write relay entry in single-host mode (no hub in `cluster_config`)
- **platform-connectors.AC4.3 Success:** Remote host's scheduler fires a matching event-driven task on receipt
- **platform-connectors.AC4.4 Success:** `event_depth` is incremented by 1 on each relay hop

### platform-connectors.AC5: platforms package — leader election and registry
- **platform-connectors.AC5.1 Success:** `PlatformLeaderElection` claims leadership when `cluster_config` has no leader
- **platform-connectors.AC5.2 Success:** `PlatformLeaderElection` enters standby when another host is already leader
- **platform-connectors.AC5.3 Success:** Standby host promotes itself when leader `hosts.modified_at` exceeds `failover_threshold_ms`
- **platform-connectors.AC5.4 Success:** Leader writes heartbeat to `hosts.modified_at` every `failover_threshold_ms / 3`
- **platform-connectors.AC5.5 Success:** `PlatformConnectorRegistry` routes `"platform:deliver"` to correct connector by platform name
- **platform-connectors.AC5.6 Success:** `WebhookStubConnector` has `delivery = "exclusive"`
- **platform-connectors.AC5.7 Success:** `WebhookStubConnector.deliver()` throws (validates exclusive-delivery contract is enforced)

### platform-connectors.AC6: Discord connector migrated
- **platform-connectors.AC6.1 Success:** `DiscordConnector.onMessage()` writes `intake` relay to outbox (no direct agent loop)
- **platform-connectors.AC6.2 Success:** `DiscordConnector.onMessage()` persists user message via `insertRow`
- **platform-connectors.AC6.3 Success:** `DiscordConnector.deliver()` sends message content to correct Discord channel
- **platform-connectors.AC6.4 Success:** `DiscordConnector` has no hostname check (`shouldActivate` removed)
- **platform-connectors.AC6.5 Success:** `DiscordConnector` reads `allowed_users` from `platforms.json` connector config

### platform-connectors.AC7: discord package deleted + webhook route
- **platform-connectors.AC7.1 Success:** `packages/discord/` directory does not exist after Phase 6
- **platform-connectors.AC7.2 Success:** `bun run build` succeeds with no `@bound/discord` references
- **platform-connectors.AC7.3 Success:** `POST /hooks/discord` returns 200 and emits `"platform:webhook"` on `eventBus`

### platform-connectors.AC8: AbortSignal wiring in LLM drivers
- **platform-connectors.AC8.1 Success:** Anthropic driver terminates stream when `AbortSignal` is aborted mid-stream
- **platform-connectors.AC8.2 Success:** Bedrock driver terminates stream when `AbortSignal` is aborted mid-stream
- **platform-connectors.AC8.3 Success:** OpenAI-compatible driver terminates stream when `AbortSignal` is aborted mid-stream
- **platform-connectors.AC8.4 Success:** Ollama driver terminates stream when `AbortSignal` is aborted mid-stream
- **platform-connectors.AC8.5 Success:** `relay-processor.ts` passes `abortController.signal` to `backend.chat()`

## Glossary

- **Intake pipeline**: The relay-based message routing system that receives a platform event (e.g. Discord DM), writes an `intake` relay to the hub, which routes a `process` signal to the appropriate host, and returns the response via `platform_deliver` relay.
- **Broadcast connector**: A platform connector that maintains a persistent, long-lived connection to the platform (Discord gateway, Matrix homeserver). Only the elected leader connects; standbys wait for failover.
- **Exclusive-delivery connector**: A platform connector that receives events via webhook HTTP POST callbacks rather than maintaining a persistent connection. On failover, the new leader re-registers the webhook URL with the platform, pointing to its own host.
- **PlatformConnector**: The interface defined in `packages/platforms/` that all platform integrations implement. Provides `connect(hostBaseUrl?)`, `disconnect()`, `deliver()`, and optionally `handleWebhookPayload()`.
- **PlatformLeaderElection**: The class that manages which host is the active connector leader per platform. Writes leadership to `cluster_config`, maintains a heartbeat via `hosts.modified_at`, and promotes standby hosts when the leader goes stale.
- **PlatformConnectorRegistry**: Instantiates all configured platform connectors, starts their leader elections, and routes `"platform:deliver"` and `"platform:webhook"` eventBus events to the correct connector.
- **Event broadcast** (`event_broadcast` relay kind): A relay message with `target_site_id = "*"` that the hub fans out to all spoke nodes, allowing one host to trigger a scheduler event across the entire cluster.
- **Event depth** (`event_depth`): A counter incremented on each relay hop to prevent infinite event loop cascades across hosts.
- **Thread affinity**: An in-memory hub-local map of `thread_id → site_id` used to route `intake` messages to the host that most recently processed that thread, reducing context-switch latency.
- **Idempotency key** (relay): A deterministic hash of request properties (e.g. `"intake:{platform}:{platform_event_id}"`) used by `RelayProcessor` to detect and discard duplicate relay entries.
- **Eager push**: Optional direct HTTP delivery of relay messages from hub to spoke nodes (bypassing the next sync cycle) when the spoke's `sync_url` is reachable.
- **RelayProcessor**: The component in `packages/agent/` that reads from `relay_inbox`, executes each relay kind, and writes responses or fires eventBus events.
- **relay_outbox / relay_inbox**: Local-only SQLite tables on every host storing pending outbound relay messages (outbox) and received messages awaiting processing (inbox). Not synced via change_log.
- **Webhook routing** (`POST /hooks/:platform`): A generic HTTP endpoint on the web server that receives incoming webhook payloads and emits `"platform:webhook"` on the eventBus for connectors to handle.
- **AbortSignal**: A Web API primitive (part of `AbortController`) for cancelling async operations. Wired through LLM drivers to enable mid-stream cancellation of inference calls.
- **Failover threshold** (`failover_threshold_ms`): Configurable duration after which a leader is considered offline if no heartbeat has been seen; triggers standby promotion.

---

## Architecture

This plan completes the service-channel spec by building on the fully-implemented relay transport core. It adds the platform connector layer (intake pipeline, leader election, message delivery), the three remaining relay kinds, cross-host event broadcast, schema generalization, and AbortSignal cancellation support for LLM inference streams.

**Platform connector framework.** A new `packages/platforms/` package defines the `PlatformConnector` interface and `PlatformLeaderElection` class. Each platform (Discord, future Slack/Telegram/Matrix) implements the interface. `PlatformConnectorRegistry` wires connectors to the eventBus and starts leader elections at CLI startup. The `packages/discord/` package is deleted; its logic migrates to `packages/platforms/src/connectors/discord.ts`.

**Two delivery models, one interface.** Broadcast connectors (Discord) maintain a persistent gateway connection; only the leader connects. Exclusive-delivery connectors (webhooks: Telegram, Slack Events API) register a webhook URL at the platform on `connect(hostBaseUrl)` and receive events via HTTP; on failover the new leader re-registers its own URL. The `handleWebhookPayload?` optional method distinguishes these at the type level.

**Intake pipeline.** When a platform message arrives, the connector persists the user message via `insertRow()` and writes an `intake` relay message to `relay_outbox` addressed to the hub. The hub's `RelayProcessor` deduplicates (idempotency key `"intake:{platform}:{event_id}"`) and selects a processing host using the routing algorithm from spec §5.4 (thread affinity → model match → tool match → fallback). It writes a `process` signal to the selected host. The processing host runs the agent loop; the response travels back to the connector leader via `platform_deliver` relay + `"platform:deliver"` eventBus event.

**Cross-host event broadcast.** The `emit` command writes an `event_broadcast` relay entry with `target_site_id = "*"`. The hub's relay phase copies it to every spoke's outbox (echo-suppressed). Each spoke's `RelayProcessor` fires the event locally via eventBus, including `event_depth` for loop protection. The scheduler picks up matching event-driven tasks with no additional latency.

**AbortSignal wiring.** `ChatParams` gains `signal?: AbortSignal`. All four LLM drivers forward it to their underlying fetch/SDK calls, enabling genuine HTTP-level cancellation. `relay-processor.ts` passes `abortController.signal`, resolving its existing TODO.

**Cross-package wiring.** `agent` cannot import `platforms` (cycle). All communication between them uses the existing `TypedEventEmitter` — the same pattern used by `status:forward`. Two new events are added to `EventMap`: `"platform:deliver"` and `"platform:webhook"`.

---

## Existing Patterns

**`ALTER TABLE` idempotent migrations** (`packages/core/src/schema.ts`): existing columns (`stream_id` on relay tables) are added via `try { db.run("ALTER TABLE ... ADD COLUMN ...") } catch { /* already exists */ }`. Schema additions for `platform_ids` and `hosts.platforms` follow this pattern.

**`TypedEventEmitter` for cross-package coordination** (`packages/shared/src/events.ts`): `status:forward` is already emitted by `RelayProcessor` (in `@bound/agent`) and consumed by the web server (in `@bound/web`). The new `platform:deliver` and `platform:webhook` events follow the same pattern — emitted from `@bound/agent`, consumed by `@bound/platforms`.

**`RelayProcessor` case dispatch** (`packages/agent/src/relay-processor.ts`): `processEntry()` switches on `entry.kind`. New kinds (`intake`, `platform_deliver`, `event_broadcast`) add cases to this switch.

**`configSchemaMap` + optional config loading** (`packages/shared/src/config-schemas.ts`, `packages/core/src/config-loader.ts`): optional configs are defined in `configSchemaMap` and loaded best-effort in `loadOptionalConfigs()`. `platforms.json` follows this pattern; `discord.json` is removed from both.

**`CommandDefinition` pattern** (`packages/sandbox/src/`): `emit.ts` follows the existing shape — returns `commandSuccess` / `commandError`, accesses `ctx.db` for relay writes.

**`insertRow` / `updateRow` for all synced table writes** (`packages/core/src/change-log.ts`): leader heartbeat uses `updateRow("hosts", ...)`. Leadership claim uses `updateRow("cluster_config", ...)`. User and thread persistence in connectors uses `insertRow`.

**`packages/discord/` as the migration reference**: structure, test patterns, and Discord.js integration from the existing discord package are carried forward verbatim into `packages/platforms/src/connectors/discord.ts`.

---

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Schema + Type Foundations

**Goal:** Generalize all data model types from Discord-specific to platform-generic. No behavior changes — purely structural.

**Components:**
- `packages/core/src/schema.ts` — `ALTER TABLE users ADD COLUMN platform_ids TEXT`; populate from existing `discord_id`; `ALTER TABLE users DROP COLUMN discord_id`; drop `idx_users_discord`; `ALTER TABLE hosts ADD COLUMN platforms TEXT`
- `packages/shared/src/types.ts` — `User.discord_id` removed, `User.platform_ids: string | null` added; `Host.platforms: string | null` added; `Thread.interface` widened from `"web" | "discord"` to `string`; new payload interfaces: `IntakePayload`, `PlatformDeliverPayload`, `EventBroadcastPayload`
- `packages/shared/src/types.ts` — `RELAY_REQUEST_KINDS` gains `"intake"`, `"platform_deliver"`, `"event_broadcast"`
- `packages/shared/src/events.ts` — two new `EventMap` entries: `"platform:deliver": PlatformDeliverPayload` and `"platform:webhook": { platform: string; rawBody: string; headers: Record<string, string> }`
- `packages/shared/src/config-schemas.ts` — `userEntrySchema`: remove `discord_id`, add `platforms?: z.record(z.string(), z.string())`; new `platformsSchema` with `connectors` array (fields: `platform`, `token`/`signing_secret`, `allowed_users`, `leadership: "auto"|"leader"|"standby"|"all"`, `failover_threshold_ms`); remove `discordSchema`/`DiscordConfig`; add `PlatformConnectorConfig`; update `configSchemaMap` and `ConfigType` union
- `packages/core/src/config-loader.ts` — remove `discord.json` from `optionalConfigs`; add `platforms.json` with `platformsSchema`

**Dependencies:** None (first phase).

**Done when:** `bun run typecheck` passes across all packages. `bun test packages/core` passes with schema migration tests verifying `platform_ids` is populated from existing `discord_id` values and `hosts.platforms` column exists. No existing tests broken by type changes.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Relay Kind Handlers

**Goal:** Implement the three new relay kinds end-to-end: intake routing on the hub, platform delivery dispatch, and event broadcast forwarding.

**Components:**
- `packages/agent/src/relay-processor.ts` — three new `case` branches in `processEntry()`:
  - `"intake"`: checks idempotency cache (`"intake:{platform}:{platform_event_id}"`); runs §5.4 intake routing (hub-local `Map<thread_id, site_id>` for thread affinity, then `hosts.models` match, then `hosts.mcp_tools` match, then least-loaded fallback from `relay_outbox` depth); writes `process` signal via `writeOutbox()`; marks processed; `response = null`
  - `"platform_deliver"`: emits `"platform:deliver"` on `eventBus`; `response = null`
  - `"event_broadcast"`: emits `entry.payload.event_name` on `eventBus` with payload merged with `{ __relay_event_depth }`; `response = null`
- `packages/sync/src/routes.ts` — `POST /sync/relay` handler: before existing routing, check `entry.target_site_id === "*"`; if broadcast, iterate all keyring site IDs except `requesterSiteId`, call `writeOutbox()` per spoke, attempt `eagerPushToSpoke()` per spoke; also peek at routed `status_forward` messages to update hub-local thread-affinity map (passed into `createSyncRoutes` as optional mutable `Map<string, string>`)

**Dependencies:** Phase 1 (new relay kinds must exist in `RELAY_REQUEST_KINDS`).

**Done when:** Unit tests cover: intake idempotency dedup, all four intake routing cases (thread affinity, model match, tool match, fallback), `platform_deliver` eventBus emission, `event_broadcast` local firing with depth propagation, broadcast `target_site_id="*"` fan-out in routes.ts. Covers `platform-connectors.AC3.x`, `platform-connectors.AC4.x`.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: `platforms` Package

**Goal:** Create the new `packages/platforms/` package with the `PlatformConnector` interface, `PlatformLeaderElection`, `PlatformConnectorRegistry`, `DiscordConnector`, and `WebhookStubConnector`.

**Components:**
- `packages/platforms/package.json` — new package `@bound/platforms`; depends on `@bound/agent`, `@bound/core`, `@bound/shared`; peer dep `discord.js`
- `packages/platforms/src/connector.ts` — `PlatformConnector` interface:
  ```typescript
  interface PlatformConnector {
    readonly platform: string;
    readonly delivery: "broadcast" | "exclusive";
    connect(hostBaseUrl?: string): Promise<void>;
    disconnect(): Promise<void>;
    deliver(threadId: string, messageId: string, content: string,
            attachments?: unknown[]): Promise<void>;
    handleWebhookPayload?(rawBody: string,
                          headers: Record<string, string>): Promise<void>;
  }
  ```
- `packages/platforms/src/leader-election.ts` — `PlatformLeaderElection`: `start()` reads `cluster_config.platform_leader:{platform}`; if absent or self, writes self via `updateRow("cluster_config", ...)` (LWW race), calls `connector.connect(hostBaseUrl)`, starts heartbeat interval (`updateRow("hosts", ...)` every `failover_threshold_ms / 3`); if other host, starts staleness-check interval (reads leader `hosts.modified_at`; if stale > `failover_threshold_ms`, promotes self); `stop()` clears intervals, calls `disconnect()`; `isLeader(): boolean`
- `packages/platforms/src/registry.ts` — `PlatformConnectorRegistry`: constructed with `AppContext` + `PlatformConnectorConfig`; `start()` instantiates connectors, starts `PlatformLeaderElection` per connector, registers `eventBus.on("platform:deliver", ...)` dispatcher (routes by `payload.platform`), registers `eventBus.on("platform:webhook", ...)` dispatcher
- `packages/platforms/src/connectors/discord.ts` — `DiscordConnector`: migrated from `packages/discord/src/bot.ts`; `connect()` creates Discord.js client + logs in; `onMessage()` persists user message via `insertRow()` then writes `intake` relay to `relay_outbox` (target = hub site_id from `cluster_config`); `deliver()` looks up Discord channel for thread, sends chunked content; no `agentLoopFactory`, no `shouldActivate()` hostname check
- `packages/platforms/src/connectors/webhook-stub.ts` — `WebhookStubConnector`: `delivery = "exclusive"`; `connect()`/`disconnect()` are no-ops; `deliver()` throws `"not implemented — stub only"`; `handleWebhookPayload()` is a no-op; JSDoc: `@remarks DELETE when first real exclusive-delivery connector (Slack, Telegram, etc.) ships`

**Dependencies:** Phase 1 (payload types, EventMap entries), Phase 2 (RelayProcessor emits `"platform:deliver"`).

**Done when:** `bun test packages/platforms` passes. Tests cover: `PlatformLeaderElection` startup claim, heartbeat writes, standby promotion on stale leader, `PlatformConnectorRegistry` eventBus dispatch, `DiscordConnector` intake relay write on message receipt (mock Discord.js), `DiscordConnector` deliver chunking. Covers `platform-connectors.AC5.x`, `platform-connectors.AC6.x`.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: `emit` Broadcast + Webhook Route

**Goal:** Wire the `emit` command to broadcast events cluster-wide, and expose a generic webhook ingress on the web server for exclusive-delivery connectors.

**Components:**
- `packages/agent/src/commands/emit.ts` — after local `eventBus.emit()`, check `cluster_config` for a `hub` entry (sync enabled); if present, call `writeOutbox()` with `target_site_id = "*"`, `kind = "event_broadcast"`, payload `{ event_name, event_payload, source_host, event_depth: (payload.__relay_event_depth ?? 0) + 1 }`; emit `sync:trigger`
- `packages/web/src/server/routes/webhooks.ts` — new file; `createWebhookRoutes(eventBus)` returns a Hono app with `POST /hooks/:platform`; no auth middleware; reads raw body + headers; emits `"platform:webhook"` on eventBus; returns `200 OK`
- `packages/web/src/server/index.ts` — mount `createWebhookRoutes(eventBus)` on the app

**Dependencies:** Phase 1 (EventMap entries, `EventBroadcastPayload`), Phase 2 (`target_site_id="*"` broadcast in routes.ts).

**Done when:** Unit tests verify: `emit` writes `event_broadcast` outbox entry when hub is configured; `emit` does NOT write outbox entry in single-host mode (no hub in cluster_config); `POST /hooks/discord` returns 200 and emits `"platform:webhook"` event. Covers `platform-connectors.AC4.1`, `platform-connectors.AC4.2`, `platform-connectors.AC7.x`.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: AbortSignal Wiring

**Goal:** Enable genuine HTTP-level cancellation of in-flight LLM inference by plumbing `AbortSignal` through all four drivers.

**Components:**
- `packages/llm/src/types.ts` — `ChatParams` gains `signal?: AbortSignal`
- `packages/llm/src/drivers/anthropic.ts` — forward `signal` to `fetch()` call
- `packages/llm/src/drivers/bedrock.ts` — forward `signal` as `abortSignal` on the `InvokeModelWithResponseStreamCommand` options
- `packages/llm/src/drivers/openai-compatible.ts` — forward `signal` to `fetch()` call
- `packages/llm/src/drivers/ollama.ts` — forward `signal` to `fetch()` call
- `packages/agent/src/relay-processor.ts` — `backend.chat({ ..., signal: abortController.signal })` (resolves existing TODO comment at line ~724)

**Dependencies:** Phase 1 only (type changes).

**Done when:** Tests for each driver verify that aborting the signal mid-stream causes the async iterator to terminate and the underlying fetch to be cancelled (mock `fetch` with abort detection). Covers `platform-connectors.AC8.x`.
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Config Migration + `discord` Package Deletion

**Goal:** Remove the `discord` package and all `discord.json` references; wire `PlatformConnectorRegistry` into CLI startup.

**Components:**
- `packages/discord/` — deleted entirely
- `packages/cli/src/bound.ts` (or equivalent startup file) — remove `DiscordBot` import + instantiation; add `PlatformConnectorRegistry` construction from `optionalConfig.platforms`; registry started after agent loop setup, stopped in shutdown handler
- `packages/cli/package.json` — remove `@bound/discord` dependency; add `@bound/platforms`
- `packages/shared/src/config-schemas.ts` — `configSchemaMap`: remove `"discord.json"` entry; add `"platforms.json"` with `platformsSchema`
- `packages/shared/src/config-schemas.ts` — `ConfigType` union: remove `DiscordConfig`; add `PlatformConnectorsConfig`
- Any remaining `discord_id` references in `packages/discord/src/allowlist.ts`, `packages/discord/src/thread-mapping.ts` logic now lives in `packages/platforms/src/connectors/discord.ts` (already migrated in Phase 3)

**Dependencies:** Phase 3 (`@bound/platforms` must exist before cli can import it), all prior phases complete.

**Done when:** `bun run build` succeeds with no references to `@bound/discord`. `bun test packages/cli` passes. `bun test --recursive` passes (no regressions from discord package removal). Covers `platform-connectors.AC2.x` (config schema validation).
<!-- END_PHASE_6 -->

<!-- START_PHASE_7 -->
### Phase 7: Integration + End-to-End Validation

**Goal:** Validate the complete intake pipeline and event broadcast path in multi-instance integration tests.

**Components:**
- `packages/platforms/src/__tests__/intake-pipeline.integration.test.ts` — two-instance test (hub + spoke); spoke's `DiscordConnector.onMessage()` writes `intake` relay; hub routes to `process`; spoke's agent loop runs with mock LLM; response persisted; `platform_deliver` relay emitted; `"platform:deliver"` eventBus event fires on spoke
- `packages/sync/src/__tests__/event-broadcast.integration.test.ts` — two-instance test; `emit` on spoke A writes `event_broadcast`; sync delivers to hub; hub fans out to spoke B; spoke B's scheduler fires a matching event-driven task
- `packages/agent/src/__tests__/relay-processor.test.ts` — extend existing file: intake routing unit tests (all four routing strategies), `event_broadcast` depth propagation
- `packages/sync/src/__tests__/multi-instance.integration.test.ts` — extend existing file: `target_site_id="*"` fan-out reaches all spokes

**Dependencies:** All prior phases complete.

**Done when:** All new integration tests pass. `bun test --recursive` is green. Coverage thresholds maintained (core/agent/sync ≥ 80%, web/discord not applicable post-deletion). Covers remaining uncovered ACs from all prior phases.
<!-- END_PHASE_7 -->

---

## Additional Considerations

**`WebhookStubConnector` lifetime.** The stub exists solely to validate that `PlatformLeaderElection` and `PlatformConnectorRegistry` correctly handle exclusive-delivery connectors (webhook URL rotation on leader promotion). It has no production use. A `// TODO: DELETE — stub only` comment in `webhook-stub.ts` and an entry in the package's `README.md` ensure it is removed when the first real exclusive-delivery connector (Slack, Telegram, etc.) is implemented.

**SQLite column drop compatibility.** `ALTER TABLE ... DROP COLUMN` requires SQLite 3.35.0+. Bun bundles a recent SQLite version; the migration uses `DROP COLUMN` directly. If the running SQLite is older, the migration falls back gracefully: `discord_id` stays (orphaned but harmless); `platform_ids` is populated from it. A schema version check in `applySchema()` guards this path.

**`AllowlistConfig` migration.** Existing `allowlist.json` files using `discord_id` will fail validation after Phase 1 removes the field. The config-loader error message explicitly says: `"discord_id is no longer supported — use platforms.discord instead"`. Operators must update their `allowlist.json` before upgrading.

**Thread-affinity map on hub.** The `Map<thread_id, site_id>` used for intake routing in `RelayProcessor` is in-memory and not persisted. It is populated as `status_forward` messages pass through the hub's relay phase. A fresh hub restart loses affinity state; the router falls back to model-match → tool-match → fallback. This is acceptable: affinity is a latency optimization, not a correctness guarantee.

**`event_depth` injection.** The `__relay_event_depth` key is a private convention between the `emit` command and `RelayProcessor`. It is stripped before the scheduler sees the payload (scheduler receives `event_payload` only, not the merged object). The implementation plan must ensure this stripping happens in the `RelayProcessor` event-broadcast handler, not in the scheduler.

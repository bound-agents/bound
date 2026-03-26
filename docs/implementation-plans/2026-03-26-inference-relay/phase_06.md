# Inference Relay Implementation Plan — Phase 6: Web UI Model Selector

**Goal:** The web UI shows cluster-wide model pool with relay and liveness annotations; volatile context includes model location when inference is relayed.

**Architecture:** Four changes: (1) Register local model IDs in the `hosts.models` column on startup so peer hosts can discover them via sync. (2) Update `GET /api/models` to union local backends with remote models queried from the `hosts` table, annotating each with `host`, `via`, and `status` fields. (3) Update `ModelSelector.svelte` to display relay/offline annotations. (4) Add relay location line to volatile context when the model resolution in `ContextParams` indicates remote inference. A new Playwright e2e test validates the annotated model list.

**Tech Stack:** Hono (server), Svelte 5 (client), bun:test, Playwright

**Scope:** Phase 6 of 7. Depends on Phase 2 (`findEligibleHostsByModel()` staleness constants), Phase 3 (RELAY_STREAM state, model resolution happens before context assembly).

**Codebase verified:** 2026-03-26

---

## Acceptance Criteria Coverage

### inference-relay.AC5: Web UI model selector
- **inference-relay.AC5.1 Success:** `/api/models` returns union of local backends and remote models from `hosts.models`
- **inference-relay.AC5.2 Success:** Remote models annotated with host name and `"via relay"`
- **inference-relay.AC5.3 Success:** Stale remote models (host `online_at` > 2 x sync_interval) annotated `"offline?"`
- **inference-relay.AC5.4 Success:** Volatile context includes model location: `"You are: {model} (via {provider} on host {host}, relayed from {local})"`
- **inference-relay.AC5.5 Edge:** Same model ID on multiple remote hosts listed as separate entries with different host annotations

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Register local model IDs in `hosts.models` on startup

**Verifies:** inference-relay.AC5.1 (prerequisite — remote hosts need to advertise models)

**Files:**
- Modify: `packages/cli/src/commands/start.ts` (after ModelRouter is created, around line 429-431)

**Implementation:**

After the `modelRouter` is created in start.ts (the block starting around line 429), update the local host record in the `hosts` table to include the model IDs from the router. Use `updateRow()` from `@bound/core` (per the CLAUDE.md change-log outbox pattern for synced tables).

First find the local host's `site_id` (this is `appContext.siteId`). The `hosts` table must have a row for the local host. Check if one exists; if not, use the sync bootstrap that inserts it. Then update `models`:

```typescript
// Register local model IDs so remote peers can discover them
if (modelRouter) {
    const modelIds = modelRouter.listBackends().map((b) => b.id);
    const existingHost = appContext.db
        .query("SELECT site_id FROM hosts WHERE site_id = ?")
        .get(appContext.siteId) as { site_id: string } | null;

    if (existingHost) {
        updateRow(
            appContext.db,
            "hosts",
            appContext.siteId,
            { models: JSON.stringify(modelIds) },
            appContext.siteId,
        );
    }
    // If no host row yet, the sync bootstrap will create it — hosts.models is set
    // on the initial row insertion in the sync announcement (handled by sync package).
    // We'll re-update after the row exists on the first sync cycle via the same
    // updateRow call above (safe because the if-guard re-runs on next start).
}
```

Also update `packages/sync/src/` wherever the host announces itself (look for where `host_name` and `online_at` are written to the `hosts` table for the local host). Add `models: JSON.stringify(localModelIds)` to that announcement payload.

Find the announcement code by searching for where `host_name` is written to the hosts table during sync initialization. Add models there as well.

**Verification:**
Run: `tsc -p packages/cli --noEmit`
Expected: No type errors

After running the app once, query: `SELECT models FROM hosts WHERE site_id = '<local>'`
Expected: JSON array of model IDs, e.g., `["claude-3-5-sonnet", "claude-3-haiku"]`

**Commit:** `feat(cli): register local model IDs in hosts.models on startup`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Update `/api/models` to return cluster-wide model pool

**Verifies:** inference-relay.AC5.1, inference-relay.AC5.2, inference-relay.AC5.3, inference-relay.AC5.5

**Files:**
- Modify: `packages/web/src/server/routes/status.ts` (the `/models` route at lines 85-93 and the `ModelInfo` interface at lines 9-17)
- Modify: `packages/web/src/server/routes/status.ts` (add `hostName` and `siteId` parameters to `createStatusRoutes()`)

**Implementation:**

First, extend `ModelInfo` and add new interfaces in status.ts:

```typescript
export interface ModelInfo {
	id: string;
	provider: string;
}

export interface ClusterModelInfo {
	id: string;
	provider: string;
	host: string;           // host_name or "local"
	via: "local" | "relay"; // how inference reaches this model
	status: "local" | "online" | "offline?"; // liveness annotation
}
```

Update `createStatusRoutes()` signature to receive both `hostName` and `siteId`. `hostName` is used for the display label on local models (`host: "local"`); `siteId` is used for the DB query exclusion (matches the pattern in `findEligibleHosts()` in relay-router.ts):

```typescript
export function createStatusRoutes(
	db: Database,
	eventBus: TypedEventEmitter,
	hostName: string,            // <-- for display: host: hostName on local models
	siteId: string,              // <-- for DB filter: exclude local host by site_id
	modelsConfig?: ModelsConfig,
): Hono {
```

Update the `/models` route to aggregate local and remote models:

```typescript
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes (mirrors relay-router.ts STALE_THRESHOLD_MS)

app.get("/models", (c) => {
    const localModels: ClusterModelInfo[] = (modelsConfig?.models ?? []).map((m) => ({
        id: m.id,
        provider: m.provider,
        host: hostName,
        via: "local",
        status: "local",
    }));

    // AC5.1: Query remote models from hosts table
    // Exclude local host by site_id (unique key) not host_name (not guaranteed unique)
    const remoteHosts = db
        .query(
            `SELECT host_name, models, online_at
             FROM hosts
             WHERE deleted = 0 AND models IS NOT NULL AND site_id != ?`,
        )
        .all(siteId) as Array<{ host_name: string; models: string; online_at: string | null }>;

    const remoteModels: ClusterModelInfo[] = [];
    for (const host of remoteHosts) {
        let modelIds: string[];
        try {
            modelIds = JSON.parse(host.models);
        } catch {
            continue;
        }
        // AC5.3: Annotate stale models with "offline?"
        const isStale =
            !host.online_at ||
            Date.now() - new Date(host.online_at).getTime() > STALE_THRESHOLD_MS;

        // AC5.5: Same model ID on multiple hosts → separate entries
        for (const modelId of modelIds) {
            remoteModels.push({
                id: modelId,
                provider: "remote",
                host: host.host_name,
                via: "relay",
                status: isStale ? "offline?" : "online",
            });
        }
    }

    return c.json({
        models: [...localModels, ...remoteModels],
        default: modelsConfig?.default ?? "",
    });
});
```

Update the call site in `packages/cli/src/commands/start.ts` where `createStatusRoutes()` is called — pass `appContext.hostName` and `appContext.siteId` as the new second and third arguments.

**Testing:**
Tests must verify each AC listed:
- AC5.1: Call `/api/models` with a DB containing two hosts with non-null `models` — verify all model IDs from both hosts appear in the response.
- AC5.2: Remote model entry has `via: "relay"` and `host: <host_name>`.
- AC5.3: Remote model from host with `online_at` >5 minutes ago has `status: "offline?"`.
- AC5.5: Two hosts both advertising `"claude-3-5-sonnet"` appear as two separate entries with different `host` values.

Test file: `packages/web/src/server/__tests__/status-models.test.ts` (create new, following the pattern of existing routes.integration.test.ts which uses in-memory DB).

**Verification:**
Run: `bun test packages/web/src/server/__tests__/status-models.test.ts`
Expected: All tests pass

Run: `tsc -p packages/web --noEmit`
Expected: No type errors

**Commit:** `feat(web): update /api/models to return cluster-wide model pool with relay annotations`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Update `ModelSelector.svelte` with relay and offline annotations

**Verifies:** inference-relay.AC5.2, inference-relay.AC5.3, inference-relay.AC5.5

**Files:**
- Modify: `packages/web/src/client/components/ModelSelector.svelte`

**Implementation:**

Update the `ModelInfo` interface in the component to match `ClusterModelInfo`:

```typescript
interface ClusterModelInfo {
    id: string;
    provider: string;
    host: string;
    via: "local" | "relay";
    status: "local" | "online" | "offline?";
}
```

Update the `onMount` fetch to use the extended type:

```typescript
const data = (await res.json()) as { models: ClusterModelInfo[]; default: string };
```

Update the `<select>` options to show annotations for remote/stale models:

```svelte
<select id="model" aria-label="Model" bind:value={selectedModel} onchange={handleChange}>
    {#each models as model}
        <option
            value={model.id + "@" + model.host}
            class:relay={model.via === "relay"}
            class:stale={model.status === "offline?"}
        >
            {model.id}
            {#if model.via === "relay"}
                ({model.host}{model.status === "offline?" ? " · offline?" : " · via relay"})
            {/if}
        </option>
    {/each}
</select>
```

Note: The option `value` is now `modelId@hostName` to distinguish same model ID on different hosts (AC5.5). Update `handleChange()` to parse this composite value and set `activeModel` to just the model ID part (or the full composite if the agent loop needs to resolve by host).

Add CSS for annotation styling:

```css
option.relay {
    color: var(--text-muted);
}
option.stale {
    color: var(--text-muted);
    font-style: italic;
}
```

Also update `activeModel` export to carry the model ID (strip `@host` suffix when setting `activeModel`).

**Verification:**
Run: `bun run build` (Vite build for web assets)
Expected: Build succeeds with no TypeScript errors

Visually verify in browser: model selector shows remote models with "(host · via relay)" suffix and stale models in italic.

**Commit:** `feat(web): show relay and liveness annotations in ModelSelector`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Add volatile context model location (AC5.4)

**Verifies:** inference-relay.AC5.4

**Files:**
- Modify: `packages/agent/src/context-assembly.ts` (ContextParams interface and volatile context section lines 464-524)
- Modify: `packages/agent/src/agent-loop.ts` (resolve model before context assembly; pass relay info)

**Implementation:**

**Part A: ContextParams extension**

Find the `ContextParams` interface in context-assembly.ts (the interface passed to `assembleContext()`). Add an optional `relayInfo` field:

```typescript
export interface ContextParams {
    // ... existing fields ...
    relayInfo?: {
        remoteHost: string;   // host_name of the host providing inference
        localHost: string;    // this host's hostname
        model: string;        // model ID
        provider: string;     // provider name (from hosts.models or remote model info)
    };
}
```

**Part B: Volatile context injection**

In the volatile context section (lines 466-523), add the relay location line when `relayInfo` is provided:

```typescript
// AC5.4: Model location when inference is relayed
if (params.relayInfo) {
    volatileLines.push(
        `You are: ${params.relayInfo.model} (via remote on host ${params.relayInfo.remoteHost}, relayed from ${params.relayInfo.localHost})`,
    );
}
```

**Part C: Agent loop wiring**

In `agent-loop.ts`, resolve the model BEFORE calling `assembleContext()` (currently resolution happens in LLM_CALL after context assembly). Move the `resolveModel()` call to ASSEMBLE_CONTEXT state:

1. Add a private field `private lastModelResolution: ModelResolution | null = null` to `AgentLoop`
2. In ASSEMBLE_CONTEXT state, call `resolveModel()` and store the result in `this.lastModelResolution`
3. If resolution is `remote`, pass `relayInfo` to `assembleContext()` containing the first eligible host's details
4. In LLM_CALL state, use `this.lastModelResolution` instead of resolving again

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

Add a test to `packages/agent/src/__tests__/context-assembly.test.ts`:
- Call `assembleContext()` with `relayInfo` set — verify the assembled context contains the relay location line
- Call without `relayInfo` — verify no relay location line appears

**Commit:** `feat(agent): inject relay model location into volatile context (AC5.4)`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->

<!-- START_TASK_5 -->
### Task 5: Playwright e2e test for model selector

**Verifies:** inference-relay.AC5.1, inference-relay.AC5.2, inference-relay.AC5.3

**Files:**
- Create: `e2e/model-selector.spec.ts`

**Implementation:**

Follow the pattern from `e2e/web-chat.spec.ts`. This test requires a multi-host setup. Since Playwright runs against a live server, the test must use the API to inject test data into the database before verifying the UI.

The test scenario:
1. Via API: insert a remote host into the `hosts` table with `models = '["remote-claude-3"]'` and a recent `online_at`
2. Via API: insert a stale remote host with `models = '["offline-model"]'` and `online_at` >5 minutes ago
3. Load the chat page
4. Verify model selector contains:
   - Local models (from the running server's config)
   - `remote-claude-3 (test-remote-host · via relay)` option
   - `offline-model (test-offline-host · offline?)` option in italic

Use `page.evaluate()` to call the API for inserting test hosts, and Playwright locators to find option elements in the model selector.

Note: This test requires a test-mode API endpoint for inserting test hosts (or direct DB access via a test endpoint). Check if such an endpoint exists. If not, the test can mock the `/api/status/models` response directly using Playwright's route interception: `await page.route("/api/status/models", ...)` to return crafted test data.

**Verification:**
Run: `bun run test:e2e -- --grep "model selector"`
Expected: Test passes

**Commit:** `test(e2e): add Playwright test for model selector relay annotations`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Unit tests for `/api/models` aggregation

**Verifies:** inference-relay.AC5.1, inference-relay.AC5.2, inference-relay.AC5.3, inference-relay.AC5.5

**Files:**
- Create: `packages/web/src/server/__tests__/status-models.test.ts`

**Implementation:**

Follow the pattern of `packages/web/src/server/__tests__/routes.integration.test.ts` — use in-memory SQLite (`:memory:`) with `applySchema(db)` applied. Create a Hono app via `createStatusRoutes(db, eventBus, "local-host", modelsConfig)`.

Tests must verify each AC listed:
- **AC5.1**: Insert a host with `models = '["gpt-4"]'` and fresh `online_at`. GET `/models`. Verify response includes both local model and `gpt-4` with `via: "relay"`.
- **AC5.2**: Remote model entry has `via: "relay"` and correct `host` field.
- **AC5.3**: Insert a host with `online_at` set to `new Date(Date.now() - 6 * 60 * 1000).toISOString()` (6 minutes ago). Verify that model's `status === "offline?"`.
- **AC5.5**: Insert two hosts both with `models = '["shared-model"]'`. Verify two separate entries appear with different `host` values.

Use `app.fetch(new Request(...))` for HTTP-style testing (no live server needed).

**Verification:**
Run: `bun test packages/web/src/server/__tests__/status-models.test.ts`
Expected: All tests pass

**Commit:** `test(web): add unit tests for /api/models cluster aggregation`
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_C -->

---

## Phase Completion Verification

After all 6 tasks are committed:

Run tests for all affected packages:
```bash
bun test packages/web
bun test packages/agent
```
Expected: All tests pass.

Run typechecks:
```bash
tsc -p packages/web   --noEmit
tsc -p packages/agent --noEmit
tsc -p packages/cli   --noEmit
```
Expected: Zero type errors.

Verify Playwright test:
```bash
bun run test:e2e -- --grep "model selector"
```
Expected: Test passes.

Confirm AC5.1–AC5.5 coverage via test output.

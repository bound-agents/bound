# Inference Relay Implementation Plan — Phase 2: Model Resolution & Routing

**Goal:** Enable cluster-wide model resolution so the agent loop knows whether inference is local or remote, and wire `ModelRouter` into `AgentLoop` for runtime resolution at inference time.

**Architecture:** New `findEligibleHostsByModel()` mirrors the existing `findEligibleHosts()` pattern in relay-router.ts but filters by `hosts.models` JSON column. A new `model-resolution.ts` module in agent defines `ModelResolution` (discriminated union) and `resolveModel()` — combining local backend lookup with remote host lookup. `AgentLoop` constructor changes from `LLMBackend` to `ModelRouter`; two call sites in start.ts are updated to pass `modelRouter` directly. `model-hint` gains cluster-wide model validation.

**Tech Stack:** bun:sqlite, TypeScript 6.x strict, bun:test

**Scope:** Phase 2 of 7 (inference-relay). Depends on Phase 1 (EligibleHost type is in relay-router.ts, which is the agent package's dependency domain).

**Codebase verified:** 2026-03-26

---

## Acceptance Criteria Coverage

### inference-relay.AC2: Cluster-wide model resolution
- **inference-relay.AC2.1 Success:** Local model resolves to `{ kind: "local", backend }` — no relay
- **inference-relay.AC2.2 Success:** Remote model resolves to `{ kind: "remote", hosts }` sorted by `online_at` recency
- **inference-relay.AC2.3 Success:** `model-hint` validates against cluster-wide model pool (local + remote)
- **inference-relay.AC2.4 Failure:** Unknown model (not in any host's `models`) returns error with available alternatives
- **inference-relay.AC2.5 Edge:** Host with matching model but stale `online_at` (> 2 x sync_interval) filtered from eligible hosts

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: `findEligibleHostsByModel()` in relay-router.ts

**Verifies:** inference-relay.AC2.2, inference-relay.AC2.5

**Files:**
- Modify: `packages/agent/src/relay-router.ts` (append after `isHostStale()` at line 74)

**Implementation:**

Add `findEligibleHostsByModel()` after the existing `isHostStale()` function. The stale threshold for model routing mirrors the existing 5-minute `STALE_THRESHOLD_MS`:

```typescript
export function findEligibleHostsByModel(
	db: Database,
	modelId: string,
	localSiteId: string,
): RelayRoutingResult | RelayRoutingError {
	const rows = db
		.query(
			`SELECT site_id, host_name, sync_url, models, online_at
			 FROM hosts
			 WHERE deleted = 0 AND site_id != ?`,
		)
		.all(localSiteId) as Array<{
		site_id: string;
		host_name: string;
		sync_url: string | null;
		models: string | null;
		online_at: string | null;
	}>;

	const eligible: EligibleHost[] = [];
	for (const row of rows) {
		if (!row.models) continue;
		// Stale hosts are excluded (online_at older than STALE_THRESHOLD_MS)
		if (row.online_at) {
			const age = Date.now() - new Date(row.online_at).getTime();
			if (age > STALE_THRESHOLD_MS) continue;
		} else {
			continue; // No online_at means never seen — skip
		}
		let models: string[];
		try {
			models = JSON.parse(row.models);
		} catch {
			continue; // Malformed JSON — skip host
		}
		if (!models.includes(modelId)) continue;
		eligible.push({
			site_id: row.site_id,
			host_name: row.host_name,
			sync_url: row.sync_url,
			online_at: row.online_at,
		});
	}

	if (eligible.length === 0) {
		return { ok: false, error: `Model "${modelId}" not available on any remote host` };
	}

	// Sort by online_at descending (most recent first)
	eligible.sort((a, b) => {
		if (!a.online_at && !b.online_at) return 0;
		if (!a.online_at) return 1;
		if (!b.online_at) return -1;
		return new Date(b.online_at).getTime() - new Date(a.online_at).getTime();
	});

	return { ok: true, hosts: eligible };
}
```

Note: `findEligibleHosts()` (for tools) does NOT filter stale hosts — it sorts by recency and lets `isHostStale()` be called separately. `findEligibleHostsByModel()` filters them eagerly per AC2.5 which requires stale hosts to be excluded entirely from resolution results.

**Testing:**
Tests must verify each AC listed:
- AC2.2: Insert hosts with `models` JSON arrays, call `findEligibleHostsByModel()` for a model ID present on some hosts — verify only matching hosts returned, sorted by `online_at` descending.
- AC2.5: Insert a host with matching model but `online_at` older than `STALE_THRESHOLD_MS` — verify it is absent from results. Insert another with fresh `online_at` with same model — verify it IS included.

Test file: `packages/agent/src/__tests__/relay-router.test.ts` (create if it doesn't exist; if it does, add to it).

**Verification:**
Run: `bun test packages/agent/src/__tests__/relay-router.test.ts`
Expected: All relay-router tests pass

**Commit:** `feat(agent): add findEligibleHostsByModel for cluster-wide model routing`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: `ModelResolution` type and `resolveModel()` in model-resolution.ts

**Verifies:** inference-relay.AC2.1, inference-relay.AC2.2, inference-relay.AC2.4

**Files:**
- Create: `packages/agent/src/model-resolution.ts`
- Modify: `packages/agent/src/index.ts` (re-export `ModelResolution`, `resolveModel`)

**Implementation:**

Create `packages/agent/src/model-resolution.ts`:

```typescript
import type { Database } from "bun:sqlite";
import type { LLMBackend } from "@bound/llm";
import { ModelRouter } from "@bound/llm";

import { type EligibleHost, findEligibleHostsByModel } from "./relay-router";

export type ModelResolution =
	| { kind: "local"; backend: LLMBackend; modelId: string }
	| { kind: "remote"; hosts: EligibleHost[]; modelId: string }
	| { kind: "error"; error: string };

/**
 * Resolves a model ID to either a local LLM backend or a list of remote eligible hosts.
 *
 * Resolution order:
 * 1. If modelId maps to a local backend in modelRouter → return local
 * 2. If modelId is found on remote hosts → return remote
 * 3. Otherwise → return error with context
 *
 * If modelId is undefined, resolves to the default local backend.
 */
export function resolveModel(
	modelId: string | undefined,
	modelRouter: ModelRouter,
	db: Database,
	localSiteId: string,
): ModelResolution {
	const effectiveModelId = modelId ?? modelRouter.getDefaultId();

	// Check local backends first
	const localBackend = modelRouter.tryGetBackend(effectiveModelId);
	if (localBackend) {
		return { kind: "local", backend: localBackend, modelId: effectiveModelId };
	}

	// Fall back to remote hosts
	const remoteResult = findEligibleHostsByModel(db, effectiveModelId, localSiteId);
	if (remoteResult.ok) {
		return { kind: "remote", hosts: remoteResult.hosts, modelId: effectiveModelId };
	}

	// Build informative error — list all known local model IDs
	const localIds = modelRouter.listBackends().map((b) => b.id);
	return {
		kind: "error",
		error: `Unknown model "${effectiveModelId}". Local backends: [${localIds.join(", ")}]. ${remoteResult.error}`,
	};
}
```

Note: `resolveModel()` calls `modelRouter.tryGetBackend()` and `modelRouter.getDefaultId()` — these are new non-throwing methods that need to be added to `ModelRouter` in the same task (see below).

**Also modify `packages/llm/src/model-router.ts`** to add two non-throwing helper methods:

```typescript
/** Returns the default backend ID. */
getDefaultId(): string {
	return this.defaultId;
}

/** Returns the backend for modelId, or null if not found (non-throwing). */
tryGetBackend(modelId: string): LLMBackend | null {
	return this.backends.get(modelId) ?? null;
}
```

**Testing:**
Tests must verify each AC listed:
- AC2.1: Call `resolveModel()` with a model ID that exists in modelRouter backends — verify `kind === "local"` and backend returned is correct.
- AC2.2: Insert a host in DB with matching `models` JSON, call `resolveModel()` with a model ID NOT in local backends — verify `kind === "remote"` and hosts list contains the inserted host.
- AC2.4: Call `resolveModel()` with a model ID not in local backends and no matching hosts in DB — verify `kind === "error"` with message containing the model ID.

Test file: `packages/agent/src/__tests__/model-resolution.test.ts` (create new).

**Verification:**
Run: `bun test packages/agent/src/__tests__/model-resolution.test.ts`
Expected: All model resolution tests pass

Run: `tsc -p packages/agent --noEmit && tsc -p packages/llm --noEmit`
Expected: No type errors

**Commit:** `feat(agent): add ModelResolution type and resolveModel for cluster-wide model lookup`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Update `AgentLoop` constructor to accept `ModelRouter`

**Verifies:** None directly (wiring change — tested indirectly by Phase 3+)

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` (constructor at lines 57-74, LLM_CALL state at lines ~106-123, imports at lines 1-20)

**Implementation:**

Update the imports at the top of `agent-loop.ts` to remove `LLMBackend` type import and add `ModelRouter`:

```typescript
import type { ModelRouter } from "@bound/llm";
import type { StreamChunk } from "@bound/llm";
```

Change the constructor at lines 57-74 to replace `private llmBackend: LLMBackend` with `private modelRouter: ModelRouter`:

```typescript
constructor(
	private ctx: AppContext,
	private sandbox: BashLike,
	private modelRouter: ModelRouter,
	private config: AgentLoopConfig,
) {
	if (config.abortSignal) {
		config.abortSignal.addEventListener("abort", () => {
			this.aborted = true;
		});
	}

	this.ctx.eventBus.on("agent:cancel", ({ thread_id }) => {
		if (thread_id === this.config.threadId) {
			this.aborted = true;
		}
	});
}
```

Update the LLM_CALL state (lines ~106-123) to resolve the backend before calling `chat()`. For Phase 2, only local resolution is wired; remote resolution (`kind === "remote"`) throws a placeholder error that Phase 3 will replace with RELAY_STREAM:

```typescript
this.state = "LLM_CALL";
const chunks: StreamChunk[] = [];
const SILENCE_TIMEOUT_MS = 120_000;

try {
	const systemMessages = llmMessages.filter((m) => m.role === "system");
	const nonSystemMessages = llmMessages.filter((m) => m.role !== "system");
	const systemPrompt = systemMessages
		.map((m) => (typeof m.content === "string" ? m.content : ""))
		.join("\n\n");

	const resolution = resolveModel(
		this.config.modelId,
		this.modelRouter,
		this.ctx.db,
		this.ctx.siteId,
	);

	if (resolution.kind === "error") {
		throw new Error(resolution.error);
	}

	if (resolution.kind === "remote") {
		// Phase 3 will implement RELAY_STREAM here.
		// For now, fall back to the default local backend so Phase 2 is fully functional.
		const fallback = this.modelRouter.getDefault();
		const chatStream = fallback.chat({
			model: resolution.modelId,
			messages: nonSystemMessages,
			system: systemPrompt || undefined,
			tools: this.config.tools,
		});
		for await (const chunk of this.withSilenceTimeout(chatStream, SILENCE_TIMEOUT_MS)) {
			if (this.aborted) break;
			chunks.push(chunk);
		}
	} else {
		const chatStream = resolution.backend.chat({
			model: resolution.modelId,
			messages: nonSystemMessages,
			system: systemPrompt || undefined,
			tools: this.config.tools,
		});
		for await (const chunk of this.withSilenceTimeout(chatStream, SILENCE_TIMEOUT_MS)) {
			if (this.aborted) break;
			chunks.push(chunk);
		}
	}
}
```

Add import for `resolveModel` at the top:
```typescript
import { resolveModel } from "./model-resolution";
```

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: Type errors will appear in start.ts (call sites passing LLMBackend). Fix call sites in next task.

**No standalone commit** — commit together with Task 4.
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Update start.ts call sites to pass `ModelRouter`

**Verifies:** None directly (wiring change)

**Files:**
- Modify: `packages/cli/src/commands/start.ts` (lines ~517-529 and ~593-627)

**Implementation:**

**Call site 1** (lines 515-529, the `message:created` event handler):

Replace the LLMBackend resolution and AgentLoop construction with a direct pass-through of `modelRouter`:

```typescript
// Before:
let llmBackend: LLMBackend;
try {
    llmBackend = modelRouter.getBackend(selectedModelId);
} catch {
    llmBackend = modelRouter.getDefault();
}
const activeModelId = selectedModelId || routerConfig.default;
const agentLoop = new AgentLoop(appContext, sandbox?.bash ?? ({} as any), llmBackend, {
    threadId: thread_id,
    userId: message.user_id || appContext.config.allowlist.default_web_user,
    modelId: activeModelId,
});

// After:
const activeModelId = selectedModelId || routerConfig.default;
const agentLoop = new AgentLoop(appContext, sandbox?.bash ?? ({} as any), modelRouter, {
    threadId: thread_id,
    userId: message.user_id || appContext.config.allowlist.default_web_user,
    modelId: activeModelId,
});
```

`generateThreadTitle` at line 553 still needs an `LLMBackend`. Update that call to use `modelRouter.getDefault()`:

```typescript
generateThreadTitle(appContext.db, thread_id, modelRouter.getDefault(), appContext.siteId)
```

**Call site 2** (lines 593-627, the `agentLoopFactory` closure):

Replace the backend resolution logic with a direct pass-through of `modelRouter`:

```typescript
const agentLoopFactory = (config: AgentLoopConfig): AgentLoop => {
    if (!modelRouter) {
        // No model router — return a no-op loop (same behavior as before)
        const noopRouter = new ModelRouter(
            new Map(),
            "",
        ) as unknown as ModelRouter;
        return new AgentLoop(appContext, sandbox?.bash ?? ({} as any), noopRouter, {
            ...config,
            tools: config.tools ?? [sandboxTool],
        });
    }
    return new AgentLoop(appContext, sandbox?.bash ?? ({} as any), modelRouter, {
        ...config,
        tools: config.tools ?? [sandboxTool],
    });
};
```

Actually the "no-op loop" pattern is ugly. Since `modelRouter` is used before the factory is called, and the guard at line 503 prevents loops when `modelRouter` is null, the factory can assert non-null:

```typescript
const agentLoopFactory = (config: AgentLoopConfig): AgentLoop => {
    if (!modelRouter) {
        throw new Error("agentLoopFactory called without a configured model router");
    }
    return new AgentLoop(appContext, sandbox?.bash ?? ({} as any), modelRouter, {
        ...config,
        tools: config.tools ?? [sandboxTool],
    });
};
```

Remove the now-unused `LLMBackend` import and `backend: LLMBackend` variable from start.ts if they are no longer referenced.

**Verification:**
Run: `tsc -p packages/cli --noEmit`
Expected: No type errors

Run: `bun test packages/agent`
Expected: All existing agent tests pass

**Commit:** `feat(agent): wire ModelRouter into AgentLoop constructor, update start.ts call sites`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->

<!-- START_TASK_5 -->
### Task 5: Update `model-hint` command to validate against cluster-wide pool

**Verifies:** inference-relay.AC2.3

**Files:**
- Modify: `packages/agent/src/commands/model-hint.ts`
- Modify: `packages/sandbox/src/types.ts` (check if `CommandContext` has `modelRouter` field; add it if not)

**Implementation:**

First, check if `CommandContext` in `packages/sandbox/src/types.ts` already has a `modelRouter` field. If not, add it as optional:

```typescript
// In CommandContext interface, add:
modelRouter?: import("@bound/llm").ModelRouter;
```

Then update `model-hint.ts` handler to validate the model ID against the cluster-wide pool before storing it. The validation uses `resolveModel()` from `packages/agent/src/model-resolution.ts`, but since `model-hint.ts` lives in agent and has access to that module, this is fine.

Replace the `updates` building block with validation:

```typescript
import { resolveModel } from "../model-resolution";

// In the handler, after checking `!args.model`:
if (args.model && ctx.modelRouter) {
    const resolution = resolveModel(
        args.model,
        ctx.modelRouter,
        ctx.db,
        ctx.siteId,
    );
    if (resolution.kind === "error") {
        return {
            stdout: "",
            stderr: `Error: ${resolution.error}\n`,
            exitCode: 1,
        };
    }
}
```

Note: If `ctx.modelRouter` is not available (e.g., in tests without a router), skip validation and allow the hint to be stored as before. This keeps the command backward-compatible.

Also remove the `updates.model_hint_turns = turns` line at line 63 — this sets a column (`model_hint_turns`) that does not exist in the schema. The `--for-turns` functionality should be considered unimplemented and the arg should be left as no-op for now, or removed entirely from the args list. For this phase, simply omit the `model_hint_turns` assignment:

```typescript
// Remove or comment out:
// updates.model_hint_turns = turns;
```

**Testing:**
Tests must verify each AC listed:
- AC2.3: Create a `CommandContext` with a `modelRouter` containing a local backend with ID "claude-3", call model-hint handler with `--model claude-3` — verify success response. Call with `--model unknown-model-xyz` and no remote hosts matching — verify error response containing "unknown-model-xyz".

Test file: `packages/agent/src/__tests__/model-hint.test.ts` (create new).

**Verification:**
Run: `bun test packages/agent/src/__tests__/model-hint.test.ts`
Expected: All model-hint tests pass

Run: `tsc -p packages/agent --noEmit && tsc -p packages/sandbox --noEmit`
Expected: No type errors

**Commit:** `feat(agent): validate model-hint against cluster-wide pool; remove phantom model_hint_turns write`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Write unit tests for `findEligibleHostsByModel()` edge cases

**Verifies:** inference-relay.AC2.2, inference-relay.AC2.5

**Files:**
- Modify: `packages/agent/src/__tests__/relay-router.test.ts`

**Implementation:**

Add to `relay-router.test.ts` (alongside existing tests from Task 1):

Tests must verify:
- AC2.2: Multiple remote hosts with matching model, result sorted by `online_at` most-recent-first.
- AC2.5: A host with matching model but stale `online_at` (set `online_at` to `new Date(Date.now() - 6 * 60 * 1000).toISOString()` to be older than the 5-minute threshold) is excluded; a host with `online_at` within 5 minutes is included.
- AC2.2 + AC2.4 combined: If a model is only present on stale hosts (all filtered out), the result is `{ ok: false }` not `{ ok: true, hosts: [] }`.

Use real SQLite database with `applySchema()` applied (matching the pattern in `relay-wait.test.ts` — randomBytes temp path, cleanup in afterEach).

**Verification:**
Run: `bun test packages/agent/src/__tests__/relay-router.test.ts`
Expected: All tests pass

**Commit:** `test(agent): add stale host filtering tests for findEligibleHostsByModel`
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_C -->

---

## Phase Completion Verification

After all 6 tasks are committed:

Run full test suite for affected packages:
```bash
bun test packages/llm
bun test packages/agent
bun test packages/cli
```
Expected: All tests pass. No regressions.

Run typechecks in dependency order:
```bash
tsc -p packages/shared --noEmit
tsc -p packages/llm    --noEmit
tsc -p packages/agent  --noEmit
tsc -p packages/cli    --noEmit
```
Expected: Zero type errors.

Confirm AC2.1–AC2.5 coverage:
- `resolveModel()` with local model → `{ kind: "local" }` ✓
- `resolveModel()` with remote model → `{ kind: "remote" }` ✓
- `model-hint` validates against cluster pool ✓
- Unknown model returns error with alternatives ✓
- Stale hosts filtered from `findEligibleHostsByModel()` ✓

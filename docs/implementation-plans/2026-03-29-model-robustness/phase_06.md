# Model Robustness Implementation Plan — Phase 6

**Goal:** `hosts.models` advertises per-model capability metadata in `HostModelEntry` object format. `findEligibleHostsByModel` filters by capabilities when requirements are provided. Legacy string-array format remains parseable as unverified entries.

**Architecture:** Two files changed:
1. `packages/cli/src/commands/start.ts` — emit `HostModelEntry[]` objects (with `id`, `tier`, `capabilities`) instead of a flat string array; also pass `tier` through `routerConfig` (currently missing)
2. `packages/agent/src/relay-router.ts` — `EligibleHost` gains `capabilities` and `tier` fields; `findEligibleHostsByModel` accepts optional `requirements`; parser handles both legacy string entries and new object entries

**Current state:**
- `hosts.models` stored as `JSON.stringify(["id1", "id2"])` — flat string array
- `EligibleHost` has only `site_id`, `host_name`, `sync_url`, `online_at`
- `tier` from `modelBackendSchema` is NOT propagated through `routerConfig` or `hosts.models`

**Tech Stack:** TypeScript 6.x, bun:sqlite, bun:test

**Scope:** Phase 6 of 7

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### model-robustness.AC7: Remote capability metadata
- **model-robustness.AC7.1 Success:** A host's `models` advertisement includes capability metadata in the new object-array format
- **model-robustness.AC7.2 Success:** `findEligibleHostsByModel` with a vision requirement excludes remote hosts that advertise `vision: false`
- **model-robustness.AC7.3 Success:** Remote hosts advertising without capability metadata (legacy string format) remain eligible for unconstrained requests
- **model-robustness.AC7.4 Edge:** Legacy string-format `models` entries are parsed without error and treated as unverified (no capability metadata)

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Pass `tier` through `routerConfig` and emit `HostModelEntry[]` in `start.ts`

**Verifies:** model-robustness.AC7.1

**Files:**
- Modify: `packages/cli/src/commands/start.ts` — two sections (routerConfig construction ~lines 428-442, and model registration ~lines 459-477)

**Implementation:**

**Part A: Pass `tier` through `routerConfig`.**

Currently the `routerConfig` mapping (lines 428-442) doesn't pass `tier`. `BackendConfig` has `[key: string]: unknown` so it can carry arbitrary fields. Add `tier` to the mapping:

```typescript
const routerConfig: ModelBackendsConfig = {
	backends: rawBackends.backends.map(
		(b): BackendConfig => ({
			id: b.id,
			provider: b.provider,
			model: b.model,
			baseUrl: b.base_url,
			contextWindow: b.context_window,
			apiKey: b.api_key,
			region: b.region,
			profile: b.profile,
			capabilities: b.capabilities, // Phase 4 addition
			tier: b.tier,                 // Phase 6 addition — needed for HostModelEntry
		}),
	),
	default: rawBackends.default,
};
```

**Part B: Emit `HostModelEntry[]` instead of `string[]`.**

`HostModelEntry` is defined in `packages/shared/src/types.ts` (added in Phase 1). Import it:
```typescript
import type { HostModelEntry } from "@bound/shared";
```

Replace the model registration section (currently lines 459-477):

```typescript
// Register local model capabilities in hosts.models for sync advertisement
if (modelRouter) {
	// Emit HostModelEntry objects with tier and effective capabilities.
	// NOTE: Tier is sourced from rawBackends (the Zod-validated config) rather than through
	// ModelRouter because BackendInfo.capabilities does not currently expose tier.
	// `tier` passes through BackendConfig's [key:string]:unknown index signature but is not
	// a typed field on BackendInfo. A future improvement could add tier to BackendInfo.
	const modelEntries: HostModelEntry[] = modelRouter.listBackends().map((b) => {
		const rawBackend = rawBackends.backends.find((rb) => rb.id === b.id);
		return {
			id: b.id,
			tier: rawBackend?.tier,
			capabilities: b.capabilities,
		};
	});

	const existingHost = appContext.db
		.query("SELECT site_id FROM hosts WHERE site_id = ?")
		.get(appContext.siteId) as { site_id: string } | null;

	if (existingHost) {
		updateRow(
			appContext.db,
			"hosts",
			appContext.siteId,
			{ models: JSON.stringify(modelEntries) },
			appContext.siteId,
		);
	}
}
```

Note: `modelRouter.listBackends()` now returns effective capabilities (from Phase 4). The `tier` is sourced from `rawBackends.backends` (the Zod-validated config) since `BackendConfig` carries `tier` as `unknown` and we need the typed value from the schema.

**Verification:**
```bash
tsc -p packages/cli --noEmit
bun test packages/cli
```
Expected: exits 0, all tests pass

**Commit:** `feat(cli): emit HostModelEntry objects with tier and capabilities in hosts.models`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Extend `EligibleHost` and update `findEligibleHostsByModel` in `relay-router.ts`

**Verifies:** model-robustness.AC7.2, model-robustness.AC7.3, model-robustness.AC7.4

**Files:**
- Modify: `packages/agent/src/relay-router.ts` (full update of `EligibleHost` interface and `findEligibleHostsByModel` function)

**Implementation:**

**1. Extend `EligibleHost` interface** to include capability and tier fields:

```typescript
export interface EligibleHost {
	site_id: string;
	host_name: string;
	sync_url: string | null;
	online_at: string | null;
	/** Capability metadata from the host's HostModelEntry. Present for verified hosts only. */
	capabilities?: {
		streaming?: boolean;
		tool_use?: boolean;
		system_prompt?: boolean;
		prompt_caching?: boolean;
		vision?: boolean;
		max_context?: number;
	};
	/** Tier preference (lower = preferred). Present for verified hosts only. */
	tier?: number;
	/**
	 * Whether this host entry was parsed from legacy string format (no metadata).
	 * Unverified hosts are used as fallback when no verified match exists.
	 */
	unverified?: boolean;
}
```

**2. Update `findEligibleHostsByModel`** to accept optional `requirements` and parse both formats:

Add `CapabilityRequirements` import at the top:
```typescript
import type { CapabilityRequirements } from "@bound/llm";
import type { HostModelEntry } from "@bound/shared";
```

Replace `findEligibleHostsByModel` with:

```typescript
export function findEligibleHostsByModel(
	db: Database,
	modelId: string,
	localSiteId: string,
	requirements?: CapabilityRequirements,
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

	const verified: EligibleHost[] = [];
	const unverified: EligibleHost[] = [];

	for (const row of rows) {
		if (!row.models) continue;
		// Stale hosts are excluded (online_at older than STALE_THRESHOLD_MS)
		if (row.online_at) {
			const age = Date.now() - new Date(row.online_at).getTime();
			if (age > STALE_THRESHOLD_MS) continue;
		} else {
			continue; // No online_at means never seen — skip
		}

		let rawModels: unknown;
		try {
			rawModels = JSON.parse(row.models);
		} catch {
			continue; // Malformed JSON — skip host
		}

		if (!Array.isArray(rawModels)) continue;

		// Parse each entry as either a legacy string or a HostModelEntry object
		for (const entry of rawModels) {
			if (typeof entry === "string") {
				// Legacy format: plain model ID string, no capability metadata
				if (entry === modelId) {
					unverified.push({
						site_id: row.site_id,
						host_name: row.host_name,
						sync_url: row.sync_url,
						online_at: row.online_at,
						unverified: true,
					});
				}
			} else if (entry && typeof entry === "object" && typeof (entry as HostModelEntry).id === "string") {
				// New object format: HostModelEntry with id, tier, capabilities
				const hostEntry = entry as HostModelEntry;
				if (hostEntry.id !== modelId) continue;

				const host: EligibleHost = {
					site_id: row.site_id,
					host_name: row.host_name,
					sync_url: row.sync_url,
					online_at: row.online_at,
					capabilities: hostEntry.capabilities,
					tier: hostEntry.tier,
					unverified: false,
				};

				// Apply capability filter (only for verified hosts)
				if (requirements) {
					const caps = hostEntry.capabilities;
					if (!caps) {
						// No capability metadata → treat as unverified fallback
						unverified.push({ ...host, unverified: true });
						continue;
					}
					if (requirements.vision && !caps.vision) continue; // Exclude
					if (requirements.tool_use && !caps.tool_use) continue;
					if (requirements.system_prompt && !caps.system_prompt) continue;
					if (requirements.prompt_caching && !caps.prompt_caching) continue;
				}

				verified.push(host);
			}
		}
	}

	// When requirements are set: return only verified matches; unverified hosts are
	// fallback when no verified match exists (AC7.3/AC7.4).
	// When no requirements: return all (verified + unverified) sorted by preference.
	let eligible: EligibleHost[];
	if (requirements && verified.length > 0) {
		eligible = verified;
	} else if (requirements && verified.length === 0) {
		// No verified match — fall back to unverified hosts
		eligible = unverified;
	} else {
		// No requirements — combine all, verified first
		eligible = [...verified, ...unverified];
	}

	if (eligible.length === 0) {
		return { ok: false, error: `Model "${modelId}" not available on any remote host` };
	}

	// Sort: by tier (ascending, lower is better), then by online_at (descending)
	eligible.sort((a, b) => {
		// Verified before unverified
		if (!a.unverified && b.unverified) return -1;
		if (a.unverified && !b.unverified) return 1;
		// By tier (lower tier = preferred)
		const tierA = a.tier ?? 99;
		const tierB = b.tier ?? 99;
		if (tierA !== tierB) return tierA - tierB;
		// By online_at (most recent first)
		if (!a.online_at && !b.online_at) return 0;
		if (!a.online_at) return 1;
		if (!b.online_at) return -1;
		return new Date(b.online_at).getTime() - new Date(a.online_at).getTime();
	});

	return { ok: true, hosts: eligible };
}
```

**Verification:**
```bash
tsc -p packages/agent --noEmit
```
Expected: exits 0

**Commit:** `feat(agent): extend EligibleHost and findEligibleHostsByModel with capability filtering`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-3) -->

<!-- START_TASK_3 -->
### Task 3: Tests for `findEligibleHostsByModel` with capability metadata

**Verifies:** model-robustness.AC7.1, model-robustness.AC7.2, model-robustness.AC7.3, model-robustness.AC7.4

**Files:**
- Modify: `packages/agent/src/__tests__/relay-router.test.ts` (add new tests)

**Testing:**

The existing tests in `relay-router.test.ts` insert `models` as `JSON.stringify(["id1", "id2"])`. The new tests should use both formats. Add a `describe("Phase 6: capability metadata in hosts.models")` block:

```typescript
describe("Phase 6: capability metadata in hosts.models", () => {
    // AC7.4 — legacy string format parsed without error
    it("legacy string-format hosts remain eligible for unconstrained requests (AC7.3, AC7.4)", async () => {
        // Insert host with models: JSON.stringify(["claude-3"])
        // findEligibleHostsByModel("claude-3", ...) with no requirements
        // Assert: host is returned as eligible with unverified: true
        const result = findEligibleHostsByModel(db, "claude-3", "local-site");
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.hosts[0].unverified).toBe(true);
        }
    });

    // AC7.1 — object-format hosts include capability metadata
    it("object-format HostModelEntry is parsed and returned with capabilities (AC7.1)", async () => {
        // Insert host with models: JSON.stringify([{ id: "claude-3", tier: 1, capabilities: { vision: true, tool_use: true, ... } }])
        const result = findEligibleHostsByModel(db, "claude-3", "local-site");
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.hosts[0].unverified).toBe(false);
            expect(result.hosts[0].capabilities?.vision).toBe(true);
            expect(result.hosts[0].tier).toBe(1);
        }
    });

    // AC7.2 — vision requirement excludes hosts with vision: false
    it("excludes object-format hosts lacking vision capability when requirements.vision is set (AC7.2)", async () => {
        // Insert two hosts: one with vision: true, one with vision: false
        const result = findEligibleHostsByModel(db, "claude-3", "local-site", { vision: true });
        expect(result.ok).toBe(true);
        if (result.ok) {
            // Only the vision-capable host should be returned
            expect(result.hosts.every((h) => h.capabilities?.vision !== false)).toBe(true);
        }
    });

    // AC7.3 — unverified hosts are fallback when no verified match exists
    it("uses unverified hosts as fallback when no verified capability match exists (AC7.3)", async () => {
        // Insert: one verified host with vision: false, one legacy string host for same model
        // Request with requirements = { vision: true }
        // Expected: falls back to unverified host
        const result = findEligibleHostsByModel(db, "claude-3", "local-site", { vision: true });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.hosts[0].unverified).toBe(true);
        }
    });

    // AC7.4 — mixed format array (string + object) in same hosts.models
    it("handles mixed string/object entries in hosts.models without error (AC7.4)", async () => {
        // Insert host with models: JSON.stringify(["old-model", { id: "new-model", tier: 1, capabilities: { vision: true } }])
        // findEligibleHostsByModel("old-model") → should find unverified
        // findEligibleHostsByModel("new-model") → should find verified
        const r1 = findEligibleHostsByModel(db, "old-model", "local-site");
        const r2 = findEligibleHostsByModel(db, "new-model", "local-site");
        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);
        if (r1.ok) expect(r1.hosts[0].unverified).toBe(true);
        if (r2.ok) expect(r2.hosts[0].unverified).toBe(false);
    });

    // Tier ordering: lower tier preferred
    it("sorts verified hosts by tier (lower first) then by online_at", async () => {
        // Insert two hosts with same model, one tier=1 one tier=3
        const result = findEligibleHostsByModel(db, "model-x", "local-site");
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.hosts[0].tier).toBe(1);
        }
    });
});
```

**Verification:**
```bash
bun test packages/agent --test-name-pattern "Phase 6"
bun test packages/agent
```
Expected: all existing relay-router tests pass (backward-compatible), new Phase 6 tests pass

**Commit:** `test(agent): add relay-router tests for HostModelEntry capability metadata`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_4 -->
### Task 4: Update `resolveModel()` to pass `requirements` through to the remote path

**Verifies:** model-robustness.AC7.2, model-robustness.AC2.1 (remote path)

**Files:**
- Modify: `packages/agent/src/model-resolution.ts` — the remote path in `resolveModel()`

**Problem:** Phase 5's `resolveModel()` (Task 2 of phase_05.md) calls `findEligibleHostsByModel(db, effectiveModelId, localSiteId)` with only 3 arguments in the remote fallback path. After Phase 6 adds the 4th optional `requirements` parameter to `findEligibleHostsByModel`, the remote path still never filters by capability — a vision-required request dispatched to a remote model would not exclude non-vision hosts.

**Implementation:**

In `packages/agent/src/model-resolution.ts`, find the remote path fallback (the section that calls `findEligibleHostsByModel` — written in Phase 5 Task 2). Pass `requirements` as the 4th argument:

```typescript
// Phase 1 fallback: check remote hosts
const remoteResult = findEligibleHostsByModel(db, effectiveModelId, localSiteId, requirements);
```

This is a single one-line change. `requirements` is already in scope from the function parameter.

**Testing:**

Add a test in `packages/agent/src/__tests__/relay-router.test.ts` or a new test file that verifies the end-to-end flow:

```typescript
it("resolveModel with vision requirement excludes remote hosts without vision capability (AC7.2 end-to-end)", async () => {
    // Insert a remote host with models: [{id: "vision-model", tier: 1, capabilities: {vision: false}}]
    // Call resolveModel("vision-model", mockRouter, db, "local-site", { vision: true })
    // Expected: kind === "error" (no eligible remote hosts with vision)
    const resolution = resolveModel("vision-model", mockRouter, db, "local-site", { vision: true });
    expect(resolution.kind).toBe("error");
});

it("resolveModel with no requirements accepts remote hosts without capability metadata (AC7.3 end-to-end)", async () => {
    // Insert a remote host with models: ["vision-model"] (legacy string format, no capabilities)
    // Call resolveModel("vision-model", mockRouter, db, "local-site") // no requirements
    // Expected: kind === "remote" with the host included
    const resolution = resolveModel("vision-model", mockRouter, db, "local-site");
    expect(resolution.kind).toBe("remote");
});
```

**Verification:**
```bash
tsc -p packages/agent --noEmit
bun test packages/agent
```
Expected: exits 0, all tests pass

**Commit:** `feat(agent): pass requirements through to remote path in resolveModel`
<!-- END_TASK_4 -->

# Model Robustness Implementation Plan — Phase 4

**Goal:** `ModelRouter` becomes the single source of truth for per-backend effective capabilities (driver baseline merged with config overrides) and rate-limit state. New methods `getEffectiveCapabilities()`, `listEligible()`, `markRateLimited()`, and `isRateLimited()` are added. The factory function `createModelRouter()` computes effective capabilities at construction time.

**Architecture:** All changes are confined to `packages/llm/src/model-router.ts` and the conversion in `packages/cli/src/commands/start.ts` that passes `capabilities` through `BackendConfig`. `CapabilityRequirements` (defined in Phase 1 in `llm/types.ts`) is imported and used by `listEligible()`. Rate-limit state is in-memory only — intentionally lost on restart (rate-limit windows are short-lived, ~60 s).

**Tech Stack:** TypeScript 6.x, bun:test

**Scope:** Phase 4 of 7

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### model-robustness.AC3: Per-model capability overrides
- **model-robustness.AC3.1 Success:** A backend with `provider: "ollama"` and `capabilities: { vision: true }` in config reports `vision: true` from `getEffectiveCapabilities()`
- **model-robustness.AC3.2 Success:** Override merges with baseline — unspecified fields retain provider default values
- **model-robustness.AC3.3 Success:** An operator can suppress vision on a vision-capable provider by setting `capabilities: { vision: false }`
- **model-robustness.AC3.4 Edge:** Missing `capabilities` field in config falls back to provider baseline (backward-compatible)

### model-robustness.AC5: Rate-limit handling (partial — router infrastructure only; agent-loop integration in Phase 5)
- **model-robustness.AC5.1 Success:** `markRateLimited` + `isRateLimited` round-trip works correctly
- **model-robustness.AC5.4 Failure (partial):** `listEligible` excludes rate-limited backends

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Extend `ModelRouter` with effectiveCaps, rateLimits, and new methods

**Verifies:** model-robustness.AC3.1, model-robustness.AC3.2, model-robustness.AC3.3, model-robustness.AC3.4, model-robustness.AC5.1, model-robustness.AC5.4 (partial)

**Files:**
- Modify: `packages/llm/src/model-router.ts` (entire file)
- Modify: `packages/llm/src/index.ts` (export `CapabilityRequirements`)

**Implementation:**

Replace the contents of `packages/llm/src/model-router.ts` with the following updated version. The key changes are:
1. Import `CapabilityRequirements` (added in Phase 1)
2. Add `effectiveCaps: Map<string, BackendCapabilities>` and `rateLimits: Map<string, number>` private fields
3. Update constructor to accept effectiveCaps
4. Update `listBackends()` to return effective caps (not driver baseline)
5. Add new methods

```typescript
import { AnthropicDriver } from "./anthropic-driver";
import { BedrockDriver } from "./bedrock-driver";
import { OllamaDriver } from "./ollama-driver";
import { OpenAICompatibleDriver } from "./openai-driver";
import type {
	BackendCapabilities,
	BackendConfig,
	CapabilityRequirements,
	LLMBackend,
	ModelBackendsConfig,
} from "./types";
import { LLMError } from "./types";

export interface BackendInfo {
	id: string;
	capabilities: BackendCapabilities;
}

export class ModelRouter {
	private backends: Map<string, LLMBackend>;
	private defaultId: string;
	private effectiveCaps: Map<string, BackendCapabilities>;
	private rateLimits: Map<string, number>; // backendId → expiry timestamp (ms)

	constructor(
		backends: Map<string, LLMBackend>,
		defaultId: string,
		effectiveCaps: Map<string, BackendCapabilities>,
	) {
		this.backends = backends;
		this.defaultId = defaultId;
		this.effectiveCaps = effectiveCaps;
		this.rateLimits = new Map();
	}

	getBackend(modelId?: string): LLMBackend {
		const id = modelId ?? this.defaultId;
		const backend = this.backends.get(id);
		if (!backend) {
			const available = Array.from(this.backends.keys()).join(", ");
			throw new Error(`Unknown backend ID: ${id}. Available backends: ${available}`);
		}
		return backend;
	}

	getDefault(): LLMBackend {
		const backend = this.backends.get(this.defaultId);
		if (!backend) {
			throw new Error(`Default backend not found: ${this.defaultId}`);
		}
		return backend;
	}

	/** Returns BackendInfo list with EFFECTIVE capabilities (driver baseline merged with config overrides). */
	listBackends(): BackendInfo[] {
		return Array.from(this.backends.keys()).map((id) => ({
			id,
			capabilities: this.effectiveCaps.get(id) ?? this.backends.get(id)!.capabilities(),
		}));
	}

	/** Returns the default backend ID. */
	getDefaultId(): string {
		return this.defaultId;
	}

	/** Returns the backend for modelId, or null if not found (non-throwing). */
	tryGetBackend(modelId: string): LLMBackend | null {
		return this.backends.get(modelId) ?? null;
	}

	/**
	 * Returns the effective capabilities for a backend (driver baseline merged with config override).
	 * Returns null if the backend ID is not registered.
	 */
	getEffectiveCapabilities(id: string): BackendCapabilities | null {
		return this.effectiveCaps.get(id) ?? null;
	}

	/**
	 * Returns all backends that are not rate-limited and satisfy the given capability requirements.
	 * Sorted by backend registration order (Map iteration order).
	 *
	 * @param requirements - Optional capability requirements to filter by. If omitted, only rate-limited
	 *   backends are excluded (text-only requests with no special requirements).
	 */
	listEligible(requirements?: CapabilityRequirements): BackendInfo[] {
		return Array.from(this.backends.keys())
			.filter((id) => !this.isRateLimited(id))
			.filter((id) => {
				if (!requirements) return true;
				const caps = this.effectiveCaps.get(id);
				if (!caps) return false;
				if (requirements.vision && !caps.vision) return false;
				if (requirements.tool_use && !caps.tool_use) return false;
				if (requirements.system_prompt && !caps.system_prompt) return false;
				if (requirements.prompt_caching && !caps.prompt_caching) return false;
				return true;
			})
			.map((id) => ({
				id,
				capabilities: this.effectiveCaps.get(id)!,
			}));
	}

	/**
	 * Marks a backend as rate-limited for the given duration.
	 * The backend will be excluded from `listEligible()` for `retryAfterMs` milliseconds.
	 *
	 * @param id - Backend ID to mark rate-limited
	 * @param retryAfterMs - Duration in milliseconds (use 60_000 as default if Retry-After header is absent)
	 */
	markRateLimited(id: string, retryAfterMs: number): void {
		this.rateLimits.set(id, Date.now() + retryAfterMs);
	}

	/**
	 * Returns true if the backend is currently rate-limited.
	 * Automatically cleans up expired entries.
	 */
	isRateLimited(id: string): boolean {
		const expiry = this.rateLimits.get(id);
		if (expiry === undefined) return false;
		if (Date.now() >= expiry) {
			this.rateLimits.delete(id); // Clean up expired entry
			return false;
		}
		return true;
	}
}

function createBackendFromConfig(config: BackendConfig): LLMBackend {
	const provider = config.provider.toLowerCase();

	switch (provider) {
		case "anthropic": {
			const apiKey = config.apiKey as string | undefined;
			if (!apiKey) {
				throw new Error("Anthropic driver requires apiKey in config");
			}
			const contextWindow = config.contextWindow ?? 200000;
			return new AnthropicDriver({
				apiKey,
				model: config.model,
				contextWindow,
			});
		}

		case "bedrock": {
			const region = config.region as string | undefined;
			if (!region) {
				throw new Error("Bedrock driver requires region in config");
			}
			const profile = config.profile as string | undefined;
			const contextWindow = config.contextWindow ?? 200000;
			return new BedrockDriver({
				region,
				model: config.model,
				contextWindow,
				profile,
			});
		}

		case "openai-compatible": {
			const baseUrl = config.baseUrl ?? "http://localhost:8000";
			const apiKey = config.apiKey as string | undefined;
			if (!apiKey) {
				throw new Error("OpenAI-compatible driver requires apiKey in config");
			}
			const contextWindow = config.contextWindow ?? 8192;
			return new OpenAICompatibleDriver({
				baseUrl,
				apiKey,
				model: config.model,
				contextWindow,
			});
		}

		case "ollama": {
			const baseUrl = config.baseUrl ?? "http://localhost:11434";
			const contextWindow = config.contextWindow ?? 4096;
			return new OllamaDriver({
				baseUrl,
				model: config.model,
				contextWindow,
			});
		}

		default:
			throw new Error(`Provider not yet implemented: ${config.provider}`);
	}
}

export function createModelRouter(config: ModelBackendsConfig): ModelRouter {
	const backends = new Map<string, LLMBackend>();
	const effectiveCaps = new Map<string, BackendCapabilities>();

	for (const backendConfig of config.backends) {
		const backend = createBackendFromConfig(backendConfig);
		backends.set(backendConfig.id, backend);

		// Compute effective capabilities: driver baseline merged with config override.
		// The config override (from capabilities field added in Phase 1) allows operators
		// to add or suppress capabilities on a per-backend basis.
		const baseline = backend.capabilities();
		const override = (backendConfig.capabilities as Partial<BackendCapabilities> | undefined) ?? {};
		effectiveCaps.set(backendConfig.id, { ...baseline, ...override });
	}

	// Verify default backend exists
	const defaultExists = backends.has(config.default);
	if (!defaultExists) {
		throw new LLMError(`Default backend "${config.default}" not found in backends`, "router");
	}

	return new ModelRouter(backends, config.default, effectiveCaps);
}
```

**Also update `packages/llm/src/index.ts`** to export `CapabilityRequirements` (it's defined in `types.ts` from Phase 1 and needs to be importable from `@bound/llm` by consumers like `packages/agent`):

Add to the exports in `index.ts`:
```typescript
export type { CapabilityRequirements } from "./types";
```

**Verification:**
```bash
tsc -p packages/llm --noEmit
```
Expected: exits 0

**Commit:** `feat(llm): add effectiveCaps, rateLimits, and capability/rate-limit methods to ModelRouter`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Pass `capabilities` override through `start.ts` conversion

**Verifies:** model-robustness.AC3.1 (end-to-end wiring from config file through router)

**Files:**
- Modify: `packages/cli/src/commands/start.ts` (the `routerConfig` mapping section, around lines 428–442)

**Problem:** The conversion from raw config (snake_case `b.capabilities`) to `BackendConfig` (camelCase) currently does not pass through the `capabilities` override. After Phase 1 adds `capabilities` to `modelBackendSchema`, the raw config will have `b.capabilities` as a `Partial<{...}>` object. It needs to be passed into `BackendConfig` so `createModelRouter()` can use it.

**Implementation:**

Find the section in `start.ts` that maps `rawBackends.backends` to `BackendConfig[]` (around lines 428–442). Add `capabilities: b.capabilities` to the mapping:

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
			capabilities: b.capabilities, // Pass through capabilities override (may be undefined)
		}),
	),
	default: rawBackends.default,
};
```

`BackendConfig` already has `[key: string]: unknown` (an index signature) so it can carry `capabilities` without a type error.

**Verification:**
```bash
tsc -p packages/cli --noEmit
bun test packages/cli
```
Expected: exits 0, all tests pass

**Commit:** `feat(cli): pass capabilities override through start.ts BackendConfig mapping`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-3) -->

<!-- START_TASK_3 -->
### Task 3: Unit tests for ModelRouter — effective caps and rate-limit methods

**Verifies:** model-robustness.AC3.1, model-robustness.AC3.2, model-robustness.AC3.3, model-robustness.AC3.4, model-robustness.AC5.1, model-robustness.AC5.4

**Files:**
- Modify: `packages/llm/src/__tests__/model-router.test.ts`

**Testing:**

Add a `describe("Phase 4: capability management")` block to the existing test file. The existing `MockBackend` class will be reused. The tests should use `createModelRouter()` with mock config.

**IMPORTANT:** Test configs must use camelCase field names matching `BackendConfig` from `packages/llm/src/types.ts` (e.g., `baseUrl`, `contextWindow`, `apiKey`) — NOT the snake_case names from the Zod schema (`base_url`, `context_window`, `api_key`). The conversion from snake_case (JSON/config) to camelCase (BackendConfig) happens in `start.ts`, not inside `createModelRouter()`.

```typescript
describe("Phase 4: capability management", () => {
    // AC3.4 — no capabilities field falls back to driver baseline
    it("uses driver baseline when no capabilities override in config (AC3.4)", () => {
        const router = createModelRouter({
            backends: [{ id: "test", provider: "ollama", model: "llama3", baseUrl: "http://localhost:11434", contextWindow: 4096, tier: 1 }],
            default: "test",
        });
        const caps = router.getEffectiveCapabilities("test");
        expect(caps).not.toBeNull();
        expect(caps?.vision).toBe(false); // Ollama baseline has vision: false
        expect(caps?.tool_use).toBe(true); // Ollama baseline has tool_use: true
    });

    // AC3.1 — capabilities override adds vision: true to an Ollama backend
    it("merges capabilities override with driver baseline (AC3.1)", () => {
        const router = createModelRouter({
            backends: [{
                id: "test",
                provider: "ollama",
                model: "llava",
                baseUrl: "http://localhost:11434", // camelCase: BackendConfig uses camelCase, not snake_case
                contextWindow: 4096,
                tier: 1,
                capabilities: { vision: true },
            }],
            default: "test",
        });
        const caps = router.getEffectiveCapabilities("test");
        expect(caps?.vision).toBe(true); // Override applied
        expect(caps?.tool_use).toBe(true); // Baseline retained (AC3.2)
    });

    // AC3.2 — unspecified fields retain provider default
    it("unspecified override fields retain provider defaults (AC3.2)", () => {
        const router = createModelRouter({
            backends: [{
                id: "test",
                provider: "ollama",
                model: "llama3",
                baseUrl: "http://localhost:11434",
                contextWindow: 4096,
                tier: 1,
                capabilities: { vision: true }, // Only override vision
            }],
            default: "test",
        });
        const caps = router.getEffectiveCapabilities("test");
        // Non-overridden fields come from driver baseline
        expect(caps?.streaming).toBe(true);
        expect(caps?.system_prompt).toBe(true);
        expect(caps?.max_context).toBe(4096);
    });

    // AC3.3 — suppress vision on a vision-capable provider
    it("can suppress vision on a vision-capable provider (AC3.3)", () => {
        // Use Anthropic (which has vision: true by default in its capabilities())
        const router = createModelRouter({
            backends: [{
                id: "claude",
                provider: "anthropic",
                model: "claude-3-opus",
                apiKey: "test-key",
                contextWindow: 200000,
                tier: 1,
                capabilities: { vision: false }, // Suppress vision
            }],
            default: "claude",
        });
        const caps = router.getEffectiveCapabilities("claude");
        expect(caps?.vision).toBe(false);
    });

    // AC5.1 — markRateLimited + isRateLimited round-trip
    it("markRateLimited + isRateLimited round-trip (AC5.1)", () => {
        const router = createModelRouter({
            backends: [{ id: "test", provider: "ollama", model: "llama3", baseUrl: "http://localhost:11434", contextWindow: 4096, tier: 1 }],
            default: "test",
        });
        expect(router.isRateLimited("test")).toBe(false);
        router.markRateLimited("test", 60_000);
        expect(router.isRateLimited("test")).toBe(true);
    });

    it("isRateLimited returns false after expiry", async () => {
        const router = createModelRouter({
            backends: [{ id: "test", provider: "ollama", model: "llama3", baseUrl: "http://localhost:11434", contextWindow: 4096, tier: 1 }],
            default: "test",
        });
        router.markRateLimited("test", 1); // 1ms — expires immediately
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(router.isRateLimited("test")).toBe(false);
    });

    // AC5.4 — listEligible excludes rate-limited backends
    it("listEligible excludes rate-limited backends (AC5.4)", () => {
        const router = createModelRouter({
            backends: [
                { id: "a", provider: "ollama", model: "llama3", baseUrl: "http://localhost:11434", contextWindow: 4096, tier: 1 },
                { id: "b", provider: "ollama", model: "llama3", baseUrl: "http://localhost:11434", contextWindow: 4096, tier: 2 },
            ],
            default: "a",
        });
        router.markRateLimited("a", 60_000);
        const eligible = router.listEligible();
        expect(eligible.map((b) => b.id)).toEqual(["b"]);
    });

    // listEligible excludes backends missing required capability
    it("listEligible excludes backends lacking required capability", () => {
        const router = createModelRouter({
            backends: [
                { id: "vision-backend", provider: "ollama", model: "llava", baseUrl: "http://localhost:11434", contextWindow: 4096, tier: 1, capabilities: { vision: true } },
                { id: "no-vision", provider: "ollama", model: "llama3", baseUrl: "http://localhost:11434", contextWindow: 4096, tier: 1 },
            ],
            default: "no-vision",
        });
        const eligible = router.listEligible({ vision: true });
        expect(eligible.map((b) => b.id)).toEqual(["vision-backend"]);
    });

    // Text-only requests pass qualification unchanged (AC2.5 prerequisite)
    it("listEligible with no requirements returns all non-rate-limited backends", () => {
        const router = createModelRouter({
            backends: [
                { id: "a", provider: "ollama", model: "llama3", baseUrl: "http://localhost:11434", contextWindow: 4096, tier: 1 },
                { id: "b", provider: "ollama", model: "llama3", baseUrl: "http://localhost:11434", contextWindow: 4096, tier: 1 },
            ],
            default: "a",
        });
        const eligible = router.listEligible();
        expect(eligible).toHaveLength(2);
    });
});
```

**Verification:**
```bash
bun test packages/llm
```
Expected: all existing + new tests pass, 0 fail

**Commit:** `test(llm): add model-router tests for capability management and rate-limit methods`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_B -->

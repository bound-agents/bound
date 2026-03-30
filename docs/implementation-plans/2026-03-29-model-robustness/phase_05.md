# Model Robustness Implementation Plan — Phase 5

**Goal:** `resolveModel()` gains a three-phase pipeline (identify → qualify → dispatch). Context assembly degrades gracefully for vision-unsupported backends. Agent-loop marks rate-limited backends and derives capability requirements from input blocks.

**Architecture:** Four files changed:
1. `model-resolution.ts` — extend `resolveModel()` with optional `requirements` and the qualify phase; extend `ModelResolution` error variant; add `getEarliestCapableRecovery()` to `ModelRouter` (in phase_04 file but used here first in tests)
2. `context-assembly.ts` — add `targetCapabilities` to `ContextParams`; post-process `annotated[]` in Stage 5 to replace image/document blocks
3. `agent-loop.ts` — 429/529 rate-limit marking; derive `CapabilityRequirements` from input; pass `targetCapabilities`
4. `commands/model-hint.ts` — derive requirements from thread history; pass to `resolveModel()`

**Content block handling in assembly:** `m.content` in the DB is stored as a string. For messages with ContentBlock[] content (e.g., tool_call messages), it's a JSON-encoded string like `[{"type":"tool_use",...}]`. Context assembly currently passes this as-is to `LLMMessage.content`. For image/document substitution, we parse the string, perform in-place replacement, and set `LLMMessage.content` to the resulting `ContentBlock[]`. The DB row is never modified.

**Tech Stack:** TypeScript 6.x, bun:sqlite, bun:test

**Scope:** Phase 5 of 7

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### model-robustness.AC1: Image and document content blocks (partial — behavioral)
- **model-robustness.AC1.4 Failure:** A message with an `image` block dispatched to a backend with `vision: false` is rejected at resolution time (not silently stripped)
- **model-robustness.AC1.5 Edge:** An `image` block in conversation history is replaced in-place with a text annotation when assembling for a `vision: false` backend; the DB row is unchanged

### model-robustness.AC2: Three-phase model resolution
- **model-robustness.AC2.1 Success:** A request containing image blocks resolves to a vision-capable backend
- **model-robustness.AC2.2 Success:** When the primary backend lacks a required capability, resolution re-resolves to an alternative with a `reResolved: true` flag
- **model-robustness.AC2.3 Failure:** Resolution with `reason: "capability-mismatch"` is returned when no backend in the cluster declares the required capability; error includes `unmetCapabilities` list
- **model-robustness.AC2.4 Failure:** Resolution with `reason: "transient-unavailable"` is returned when capable backends exist but are all rate-limited; error includes `earliestRecovery` timestamp
- **model-robustness.AC2.5 Edge:** Text-only requests (no requirements) pass qualification unchanged — backward-compatible

### model-robustness.AC5: Rate-limit handling (agent-loop integration)
- **model-robustness.AC5.1 Success:** A 429 response causes the backend to be excluded from resolution for the `Retry-After` window (or 60 s default)
- **model-robustness.AC5.2 Success:** After the rate-limit window expires, the backend re-enters the eligible pool
- **model-robustness.AC5.3 Success:** When the primary backend is rate-limited, resolution automatically falls back to an alternative capable backend
- **model-robustness.AC5.4 Failure:** When all capable backends are rate-limited, resolution returns `transient-unavailable` with `earliestRecovery` rather than blocking

---

<!-- START_SUBCOMPONENT_A (tasks 1-1) -->

<!-- START_TASK_1 -->
### Task 1: Extend `ModelRouter` with `getEarliestCapableRecovery()`

**Verifies:** model-robustness.AC2.4, model-robustness.AC5.4

**Files:**
- Modify: `packages/llm/src/model-router.ts` (add one method to the ModelRouter class)

**Implementation:**

Add this method to `ModelRouter` (after `isRateLimited()`):

```typescript
/**
 * Returns the earliest expiry timestamp (ms) among rate-limited backends that
 * satisfy the given capability requirements. Returns null if no such backend exists.
 * Used by resolveModel() to populate `earliestRecovery` on transient-unavailable errors.
 */
getEarliestCapableRecovery(requirements?: CapabilityRequirements): number | null {
	let earliest: number | null = null;
	for (const [id, expiry] of this.rateLimits) {
		const caps = this.effectiveCaps.get(id);
		if (!caps) continue;
		if (requirements) {
			if (requirements.vision && !caps.vision) continue;
			if (requirements.tool_use && !caps.tool_use) continue;
			if (requirements.system_prompt && !caps.system_prompt) continue;
			if (requirements.prompt_caching && !caps.prompt_caching) continue;
		}
		if (earliest === null || expiry < earliest) {
			earliest = expiry;
		}
	}
	return earliest;
}
```

Also export `CapabilityRequirements` from `packages/llm/src/index.ts` if not already done in Phase 1 (check if it's already exported; add if missing).

**Verification:**
```bash
tsc -p packages/llm --noEmit
bun test packages/llm
```
Expected: exits 0

**Commit:** `feat(llm): add getEarliestCapableRecovery to ModelRouter`
<!-- END_TASK_1 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 2-3) -->

<!-- START_TASK_2 -->
### Task 2: Extend `resolveModel()` with three-phase pipeline

**Verifies:** model-robustness.AC2.1, model-robustness.AC2.2, model-robustness.AC2.3, model-robustness.AC2.4, model-robustness.AC2.5

**Files:**
- Modify: `packages/agent/src/model-resolution.ts` (full rewrite — file is only 49 lines)

**Implementation:**

Replace the entire `packages/agent/src/model-resolution.ts` with:

```typescript
import type { Database } from "bun:sqlite";
import type { BackendCapabilities, CapabilityRequirements, LLMBackend, ModelRouter } from "@bound/llm";

import { type EligibleHost, findEligibleHostsByModel } from "./relay-router";

export type ModelResolution =
	| { kind: "local"; backend: LLMBackend; modelId: string; reResolved?: boolean }
	| { kind: "remote"; hosts: EligibleHost[]; modelId: string; reResolved?: boolean }
	| {
			kind: "error";
			error: string;
			reason?: "capability-mismatch" | "transient-unavailable";
			unmetCapabilities?: string[];
			alternatives?: string[];
			earliestRecovery?: number;
	  };

/**
 * Checks whether caps satisfy all requirements. Returns an array of unmet requirement
 * field names (empty if all requirements are met).
 */
function getUnmetCapabilities(caps: BackendCapabilities, requirements: CapabilityRequirements): string[] {
	const unmet: string[] = [];
	if (requirements.vision && !caps.vision) unmet.push("vision");
	if (requirements.tool_use && !caps.tool_use) unmet.push("tool_use");
	if (requirements.system_prompt && !caps.system_prompt) unmet.push("system_prompt");
	if (requirements.prompt_caching && !caps.prompt_caching) unmet.push("prompt_caching");
	return unmet;
}

/**
 * Resolves a model ID through a three-phase pipeline: identify → qualify → dispatch.
 *
 * Phase 1 (identify): Check local backends first, then remote hosts.
 * Phase 2 (qualify): If requirements are provided, check the identified backend's effective
 *   capabilities. On mismatch, try to re-route to an eligible alternative. Distinguish
 *   capability-mismatch (no backend has the capability) from transient-unavailable (capable
 *   backends exist but are all rate-limited).
 * Phase 3 (dispatch): Return the qualified resolution.
 *
 * Backward-compatible: when requirements is undefined (text-only requests), the qualify
 * phase is a no-op and resolution behaves identically to before.
 */
export function resolveModel(
	modelId: string | undefined,
	modelRouter: ModelRouter,
	db: Database,
	localSiteId: string,
	requirements?: CapabilityRequirements,
): ModelResolution {
	const effectiveModelId = modelId ?? modelRouter.getDefaultId();

	// Phase 1: Identify — check local backends first
	const localBackend = modelRouter.tryGetBackend(effectiveModelId);

	if (localBackend) {
		// Phase 2: Qualify (local)
		if (requirements) {
			const caps = modelRouter.getEffectiveCapabilities(effectiveModelId);
			const unmet = caps ? getUnmetCapabilities(caps, requirements) : Object.keys(requirements);

			if (unmet.length > 0) {
				// Primary backend lacks required capability — try eligible alternatives
				const eligible = modelRouter.listEligible(requirements);
				if (eligible.length > 0) {
					// Re-route to first eligible alternative
					const altId = eligible[0].id;
					const altBackend = modelRouter.tryGetBackend(altId);
					if (altBackend) {
						// Phase 3: Dispatch (re-routed local)
						return { kind: "local", backend: altBackend, modelId: altId, reResolved: true };
					}
				}

				// No eligible alternative — distinguish transient vs permanent
				const earliestRecovery = modelRouter.getEarliestCapableRecovery(requirements);
				if (earliestRecovery !== null) {
					// Capable backends exist but are all rate-limited
					return {
						kind: "error",
						error: `No backends available — all capable backends are rate-limited`,
						reason: "transient-unavailable",
						unmetCapabilities: unmet,
						earliestRecovery,
					};
				}

				// No backend in cluster has the required capability
				return {
					kind: "error",
					error: `No backends support required capabilities: ${unmet.join(", ")}`,
					reason: "capability-mismatch",
					unmetCapabilities: unmet,
					alternatives: [],
				};
			}
		}

		// Phase 3: Dispatch (local, qualification passed)
		return { kind: "local", backend: localBackend, modelId: effectiveModelId };
	}

	// Phase 1 fallback: check remote hosts
	const remoteResult = findEligibleHostsByModel(db, effectiveModelId, localSiteId);
	if (remoteResult.ok) {
		// Phase 2: Qualify (remote) — remote capability filtering is Phase 6
		// For now, return all eligible remote hosts and let the caller filter
		return { kind: "remote", hosts: remoteResult.hosts, modelId: effectiveModelId };
	}

	// Phase 3: Error (not found anywhere)
	const localIds = modelRouter.listBackends().map((b) => b.id);
	return {
		kind: "error",
		error: `Unknown model "${effectiveModelId}". Local backends: [${localIds.join(", ")}]. ${remoteResult.error}`,
	};
}
```

**Verification:**
```bash
tsc -p packages/agent --noEmit
```
Expected: exits 0

**Commit:** `feat(agent): three-phase resolveModel with capability qualification`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Tests for three-phase `resolveModel()`

**Verifies:** model-robustness.AC2.1–AC2.5

**Files:**
- Modify or create: `packages/agent/src/__tests__/model-resolution.test.ts`

**Implementation:**

Search for an existing test file at `packages/agent/src/__tests__/model-resolution.test.ts`. If it doesn't exist, create it. The tests use a mock `ModelRouter` (either a real one constructed from config or a stub implementing the interface).

Test scenarios:

```typescript
describe("three-phase model resolution", () => {
    // AC2.5 — text-only requests pass unchanged
    it("text-only request with no requirements passes qualification unchanged (AC2.5)", () => {
        const resolution = resolveModel("local-backend", mockRouter, db, "site-1");
        expect(resolution.kind).toBe("local");
        expect((resolution as any).reResolved).toBeUndefined();
    });

    // AC2.1 — vision requirement routes to vision-capable backend
    it("routes to vision-capable backend when requirements.vision is set (AC2.1)", () => {
        // primary backend has vision: false; vision-backend has vision: true
        const resolution = resolveModel("primary", mockRouter, db, "site-1", { vision: true });
        expect(resolution.kind).toBe("local");
        expect((resolution as any).modelId).toBe("vision-backend"); // re-routed
        expect((resolution as any).reResolved).toBe(true);
    });

    // AC2.2 — re-resolution sets reResolved flag
    it("sets reResolved: true when alternative backend is used (AC2.2)", () => {
        // same as above
        const resolution = resolveModel("primary", mockRouter, db, "site-1", { vision: true });
        expect((resolution as any).reResolved).toBe(true);
    });

    // AC2.3 — capability-mismatch when no backend has the capability
    it("returns capability-mismatch when no backend supports required capability (AC2.3)", () => {
        // all backends have vision: false
        const resolution = resolveModel("primary", allNonVisionRouter, db, "site-1", { vision: true });
        expect(resolution.kind).toBe("error");
        expect((resolution as { kind: "error"; reason?: string; unmetCapabilities?: string[] }).reason)
            .toBe("capability-mismatch");
        expect((resolution as any).unmetCapabilities).toContain("vision");
    });

    // AC2.4 — transient-unavailable when capable backends are all rate-limited
    it("returns transient-unavailable with earliestRecovery when all capable backends are rate-limited (AC2.4)", () => {
        // vision-backend has vision: true but is rate-limited
        mockRouter.markRateLimited("vision-backend", 60_000);
        const resolution = resolveModel("primary", mockRouter, db, "site-1", { vision: true });
        expect(resolution.kind).toBe("error");
        expect((resolution as any).reason).toBe("transient-unavailable");
        expect((resolution as any).earliestRecovery).toBeGreaterThan(Date.now());
    });
});
```

**How to construct mock routers:** Use `createModelRouter()` from `@bound/llm` with test config (Ollama with `base_url: "http://localhost:11434"`, `context_window: 4096`, appropriate `capabilities` overrides). No real network calls are made — the router only provides metadata.

**Verification:**
```bash
bun test packages/agent --test-name-pattern "three-phase model resolution"
```
Expected: all tests pass

**Commit:** `test(agent): add tests for three-phase model resolution`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 4-5) -->

<!-- START_TASK_4 -->
### Task 4: Add `targetCapabilities` to `ContextParams` and image/document substitution in Stage 5

**Verifies:** model-robustness.AC1.5

**Files:**
- Modify: `packages/agent/src/context-assembly.ts:9-31` (add `targetCapabilities` to `ContextParams`)
- Modify: `packages/agent/src/context-assembly.ts:426-495` (add content substitution after Stage 5 ANNOTATION)

**Implementation:**

**1. Extend `ContextParams`** (add after `platformContext`):
```typescript
/**
 * When set, context assembly performs in-place substitution of content blocks
 * that the target backend does not support. Image blocks are replaced with text
 * annotations when vision is not supported. Document blocks are always replaced
 * with their text_representation.
 */
targetCapabilities?: BackendCapabilities;
```

Add the `BackendCapabilities` import at the top of the file (note: `Database` is already imported at line 1 of `context-assembly.ts`; just add `BackendCapabilities` to the `@bound/llm` import):
```typescript
import type { BackendCapabilities, LLMMessage } from "@bound/llm";
```

**2. Add a helper function** that substitutes unsupported content blocks in a single `LLMMessage`:

Add before `assembleContext()`:

```typescript
// Tracks per-thread+backend advisory "image stripped" notifications to avoid log noise.
// Map key: `${threadId}::${backendId}` (backendId approximated by vision flag string)
const advisoryDedup = new Set<string>();

/**
 * Substitutes content blocks that the target backend does not support.
 * Returns a new LLMMessage with substituted content, or the original if no substitution needed.
 * Never modifies the database.
 */
function substituteUnsupportedBlocks(
	msg: LLMMessage,
	targetCapabilities: BackendCapabilities,
	db: Database,
	threadId: string,
): LLMMessage {
	// Try to parse content as ContentBlock[] (may be a JSON string or already an array)
	let blocks: Array<{ type: string; [key: string]: unknown }> | null = null;
	if (Array.isArray(msg.content)) {
		blocks = msg.content as Array<{ type: string; [key: string]: unknown }>;
	} else if (typeof msg.content === "string") {
		try {
			const parsed = JSON.parse(msg.content);
			if (Array.isArray(parsed)) blocks = parsed;
		} catch {
			// Not JSON — plain text, no block substitution needed
		}
	}

	if (!blocks) return msg;

	// Check if any substitution is needed
	const hasImage = blocks.some((b) => b.type === "image");
	const hasDocument = blocks.some((b) => b.type === "document");
	if (!hasImage && !hasDocument) return msg;

	const substituted = blocks.map((block) => {
		if (block.type === "image" && !targetCapabilities.vision) {
			// Replace image block with text annotation
			const description = typeof block.description === "string" ? block.description : "image";
			return { type: "text" as const, text: `[Image: ${description}]` };
		}

		if (block.type === "document") {
			// Always replace document blocks with their text_representation
			const textRep = typeof block.text_representation === "string"
				? block.text_representation
				: "[Document: content unavailable]";
			return { type: "text" as const, text: textRep };
		}

		// Handle file_ref image sources that need DB lookup
		if (block.type === "image" && targetCapabilities.vision) {
			const source = block.source as { type?: string; file_id?: string; data?: string; media_type?: string } | undefined;
			if (source?.type === "file_ref" && source.file_id) {
				// Attempt to resolve file content from files table
				const fileRow = db
					.query(`SELECT content, is_binary FROM files WHERE id = ? AND deleted = 0`)
					.get(source.file_id) as { content: string | null; is_binary: number } | null;

				if (!fileRow || !fileRow.content) {
					// File not found or binary without content — use text placeholder
					return {
						type: "text" as const,
						text: `[Image file unavailable: ${source.file_id}]`,
					};
				}
				// Resolve to base64 inline block
				return {
					type: "image" as const,
					source: {
						type: "base64" as const,
						media_type: "image/jpeg" as const, // default; ideally stored in files table
						data: fileRow.content,
					},
					description: block.description,
				};
			}
		}

		return block;
	});

	// Only emit advisory once per thread+vision-capability combo to avoid log noise
	if (hasImage && !targetCapabilities.vision) {
		const advisoryKey = `${threadId}::vision:false`;
		if (!advisoryDedup.has(advisoryKey)) {
			advisoryDedup.add(advisoryKey);
			// Note: we don't have access to logger here — advisory is a no-op for now.
			// Agent-loop logs the substitution at the call site.
		}
	}

	return { ...msg, content: substituted as LLMMessage["content"] };
}
```

**3. In `assembleContext()`**, add a post-processing step after the Stage 5 loop that builds `annotated[]`. Find the line where `annotated` is populated (ends around line 495) and add this block right after:

```typescript
// Stage 5b: CONTENT_SUBSTITUTION
// Replace image/document blocks in assembled messages when the target backend lacks vision support.
// This modifies the LLMMessage[] only — the persisted messages.content is never changed.
const finalAnnotated =
	params.targetCapabilities
		? annotated.map((msg) =>
				substituteUnsupportedBlocks(msg, params.targetCapabilities!, params.db, params.threadId),
		  )
		: annotated;
```

Then use `finalAnnotated` in place of `annotated` in Stage 6 (ASSEMBLY) that follows.

**Notes:**
- `substituteUnsupportedBlocks` handles both string and array forms of `content` to ensure backward compatibility with the existing content duality pattern
- The `advisoryDedup` Set is module-level (in-memory, resets on process restart) — this is intentional per the design
- For `file_ref` images when vision IS supported: resolve from DB inline; if missing, fallback to text placeholder
- For `file_ref` images when vision NOT supported: the image block is already replaced by the outer `if (block.type === "image" && !targetCapabilities.vision)` check, so no DB query needed

**Verification:**
```bash
bun test packages/agent
```
Expected: all tests pass, including `context-bedrock-compat.test.ts` (which does not use `targetCapabilities`)

```bash
tsc -p packages/agent --noEmit
```
Expected: exits 0

**Commit:** `feat(agent): add targetCapabilities content substitution to context assembly`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Tests for content substitution in context assembly

**Verifies:** model-robustness.AC1.4, model-robustness.AC1.5

**Files:**
- Create or modify: `packages/agent/src/__tests__/context-assembly-substitution.test.ts`

**Implementation:**

Create a new test file focused on the content substitution behavior. The tests use an in-memory SQLite DB with the schema applied.

```typescript
describe("context assembly content substitution", () => {
    // AC1.5 — image block in history replaced with text annotation for non-vision backend
    it("replaces image blocks in assembled context when targetCapabilities.vision is false (AC1.5)", async () => {
        // Insert a user message with image content
        // Call assembleContext() with targetCapabilities = { vision: false, ... }
        // Assert: LLMMessage.content does not contain any image blocks
        // Assert: contains a text block with "[Image: ...]" annotation
    });

    it("image DB row is unchanged after substitution (AC1.5)", async () => {
        // Insert user message with image block
        // Call assembleContext()
        // Re-query the messages table
        // Assert: messages.content still contains the original image block (not modified)
    });

    it("does not replace image blocks when targetCapabilities.vision is true", async () => {
        // Insert user message with image block
        // Call assembleContext() with targetCapabilities = { vision: true, ... }
        // Assert: LLMMessage.content still contains the image block
    });

    it("document blocks are always converted to text_representation", async () => {
        // Insert a user message with document block { type: "document", text_representation: "doc text" }
        // Call assembleContext() with targetCapabilities (any)
        // Assert: LLMMessage.content contains text block with "doc text"
    });

    it("file_ref image source is resolved from files table when vision is supported", async () => {
        // Insert a files row with some content
        // Insert a user message with image block { type: "image", source: { type: "file_ref", file_id: "..." } }
        // Call assembleContext() with targetCapabilities = { vision: true, ... }
        // Assert: LLMMessage.content has base64 image block with file content
    });

    it("file_ref with missing file falls back to text placeholder", async () => {
        // Insert a user message with image block referencing a non-existent file_id
        // Call assembleContext()
        // Assert: LLMMessage.content has text block with "[Image file unavailable: ...]"
    });

    it("assembleContext without targetCapabilities passes content unchanged (backward-compat)", async () => {
        // Insert a user message with image block (stored as JSON string)
        // Call assembleContext() WITHOUT targetCapabilities
        // Assert: returned content passes through unchanged
    });
});
```

**Use the existing test database patterns** from other context-assembly tests — check `packages/agent/src/__tests__/context-assembly.test.ts` for how to set up the DB with messages. Use `createAppContext(configDir, dbPath)` or directly use the schema application functions.

**Verification:**
```bash
bun test packages/agent --test-name-pattern "context assembly content substitution"
```
Expected: all tests pass

```bash
bun test packages/agent/src/__tests__/context-bedrock-compat.test.ts
```
Expected: all existing Bedrock-compat tests still pass (these do not use `targetCapabilities`)

**Commit:** `test(agent): add content substitution tests for context assembly`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_C -->

<!-- START_SUBCOMPONENT_D (tasks 6-7) -->

<!-- START_TASK_6 -->
### Task 6: Update `agent-loop.ts` — 429/529 rate-limit marking, requirements derivation, targetCapabilities passthrough

**Verifies:** model-robustness.AC5.1, model-robustness.AC5.3

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` — three sections

**Implementation:**

**1. Derive `CapabilityRequirements` from current turn's input blocks** before calling `resolveModel()`.

Find where `resolveModel()` is called (lines 92-97). Before that call, derive requirements from `this.config`:

```typescript
// Derive capability requirements from current turn context
const requirements: CapabilityRequirements | undefined = (() => {
	const req: CapabilityRequirements = {};
	// Check if pending user message or thread history has image blocks
	// For simplicity: if tools are configured, set tool_use requirement
	if (this.config.tools && this.config.tools.length > 0) {
		req.tool_use = true;
	}
	// Vision requirement: check recent thread messages for image ContentBlocks.
	// Phase 7 stores image blocks as JSON ContentBlock[] in messages.content.
	// Query the last 5 messages of the thread and check for image type.
	try {
		const recentMsgs = this.ctx.db
			.query(
				`SELECT content FROM messages
				 WHERE thread_id = ? AND deleted = 0
				 ORDER BY created_at DESC LIMIT 5`,
			)
			.all(this.config.threadId) as Array<{ content: string }>;

		const hasImageBlock = recentMsgs.some((m) => {
			try {
				const blocks = JSON.parse(m.content);
				return (
					Array.isArray(blocks) &&
					blocks.some((b: { type?: string }) => b.type === "image")
				);
			} catch {
				return false;
			}
		});

		if (hasImageBlock) {
			req.vision = true;
		}
	} catch {
		// Non-fatal: if DB query fails, proceed without vision requirement
	}

	return Object.keys(req).length > 0 ? req : undefined;
})();

// Call resolveModel with derived requirements
this.lastModelResolution = resolveModel(
	this.config.modelId,
	this.modelRouter,
	this.ctx.db,
	this.ctx.siteId,
	requirements,
);
```

**2. Handle 429/529 HTTP errors** in the LLM call catch block (currently lines 271-300).

In the catch block at line 271, before the existing error handling, add:

```typescript
} catch (error) {
	// Rate-limit handling: if the LLM returned 429 or 529, mark the backend
	// rate-limited so subsequent resolveModel() calls skip it
	if (
		error instanceof LLMError &&
		(error.statusCode === 429 || error.statusCode === 529)
	) {
		const backendId =
			this.lastModelResolution?.kind === "local"
				? this.lastModelResolution.modelId
				: null;
		if (backendId) {
			// Use Retry-After from the error if available (added in Phase 5); default 60 s
			const retryAfterMs = (error instanceof LLMError && error.retryAfterMs)
				? error.retryAfterMs
				: 60_000;
			this.modelRouter.markRateLimited(backendId, retryAfterMs);
			this.ctx.logger.warn("[agent-loop] Backend rate-limited, marked for exclusion", {
				backendId,
				retryAfterMs,
				statusCode: error.statusCode,
			});
		}
	}
	// ... existing error handling continues
```

Make sure `LLMError` is imported at the top of `agent-loop.ts`. Check the imports — if not present, add:
```typescript
import { LLMError } from "@bound/llm";
```

**Also add `retryAfterMs` to `LLMError`** in `packages/llm/src/types.ts`. Find the `LLMError` class and add the optional field:
```typescript
export class LLMError extends Error {
	constructor(
		message: string,
		public provider: string,
		public statusCode?: number,
		public originalError?: Error,
		public retryAfterMs?: number, // Retry-After duration parsed from HTTP header
	) {
		super(message);
		this.name = "LLMError";
	}
}
```

**Also update `packages/llm/src/error-utils.ts`** (or wherever `checkHttpError` is defined) to parse the `Retry-After` header from 429/529 responses and pass it to `LLMError`:
```typescript
// Inside checkHttpError, when statusCode === 429 || statusCode === 529:
const retryAfterHeader = response.headers.get("Retry-After");
const retryAfterMs = retryAfterHeader
	? (Number.isNaN(Number(retryAfterHeader))
		? 60_000 // Non-numeric Retry-After (date format) → use default
		: Number(retryAfterHeader) * 1000) // Seconds → ms
	: 60_000;
throw new LLMError(`HTTP ${statusCode}`, provider, statusCode, undefined, retryAfterMs);
```

Read `packages/llm/src/error-utils.ts` to find the exact implementation before editing.

**3. Pass `targetCapabilities` to `assembleContext()`**.

In the `assembleContext()` call (lines 149-167), add `targetCapabilities`:

```typescript
const resolvedCaps =
	this.lastModelResolution?.kind === "local"
		? this.modelRouter.getEffectiveCapabilities(this.lastModelResolution.modelId)
		: undefined;

const contextMessages = assembleContext({
	db: this.ctx.db,
	threadId: this.config.threadId,
	taskId: this.config.taskId,
	userId: this.config.userId,
	currentModel: this.config.modelId,
	contextWindow: contextWindow,
	hostName: this.ctx.hostName,
	siteId: this.ctx.siteId,
	relayInfo,
	platformContext: /* unchanged */,
	targetCapabilities: resolvedCaps ?? undefined,
});

// Advisory: log once per thread when image blocks are stripped for a non-vision backend.
// The advisoryDedup Set in context-assembly.ts prevents repeat logs per thread+backend,
// but the actual log emission is here at the call site where the logger is available.
if (resolvedCaps && !resolvedCaps.vision) {
	// Check if thread has any image messages (same query as requirements derivation above)
	const advisoryKey = `${this.config.threadId}::vision:false`;
	if (!this._visionAdvisoryEmitted?.has(advisoryKey)) {
		// Lazy-init the Set if it doesn't exist
		if (!this._visionAdvisoryEmitted) this._visionAdvisoryEmitted = new Set();
		this._visionAdvisoryEmitted.add(advisoryKey);
		this.ctx.logger.info("[agent-loop] Image blocks in context will be replaced with text annotations (target backend lacks vision support)", {
			backendId: this.lastModelResolution?.kind === "local" ? this.lastModelResolution.modelId : undefined,
			threadId: this.config.threadId,
		});
	}
}
```

**Add `_visionAdvisoryEmitted?: Set<string>` as a private field** to the `AgentLoop` class. Find the private field declarations at the top of the class (look for `private state`, `private config`, etc.) and add:
```typescript
private _visionAdvisoryEmitted?: Set<string>; // in-memory per-process dedup for vision substitution advisories
```
Add this immediately after the existing private field declarations, before the constructor.

**Verification:**
```bash
tsc -p packages/agent --noEmit
bun test packages/agent
```
Expected: exits 0, all tests pass

**Commit:** `feat(agent): derive capability requirements, handle 429/529 rate-limits, pass targetCapabilities to assembleContext`
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Update `model-hint.ts` to derive and pass requirements

**Verifies:** model-robustness.AC2.1 (hint flow)

**Files:**
- Modify: `packages/agent/src/commands/model-hint.ts`

**Implementation:**

Read the current `model-hint.ts` file fully first (it was reported as ~97 lines).

Find where `resolveModel()` is called (around line 61-66). Before that call, derive requirements from recent thread message history:

```typescript
// Derive requirements from recent thread history for model hint validation
// Check last 5 messages for image blocks — if found, require vision capability
const recentMessages = ctx.db
	.query(
		`SELECT content FROM messages
		 WHERE thread_id = ? AND deleted = 0
		 ORDER BY created_at DESC LIMIT 5`,
	)
	.all(ctx.threadId!) as Array<{ content: string }>; // ctx.threadId from CommandContext, not args

const requiresVision = recentMessages.some((m) => {
	try {
		const blocks = JSON.parse(m.content);
		return Array.isArray(blocks) && blocks.some((b: { type?: string }) => b.type === "image");
	} catch {
		return false;
	}
});

const requirements: CapabilityRequirements | undefined = requiresVision ? { vision: true } : undefined;

// Then pass requirements to resolveModel:
const resolution = resolveModel(modelId, modelRouter, ctx.db, ctx.siteId, requirements);
```

If `resolveModel` returns `kind: "error"` with `reason: "capability-mismatch"`, log a warning instead of hard-failing (per design: "accept hint with logged warning when resolution infrastructure unavailable"). The hint is still accepted:

```typescript
if (resolution.kind === "error") {
	if (resolution.reason === "capability-mismatch") {
		ctx.logger.warn(
			"[model-hint] Requested model lacks required capabilities for this thread's content, but hint was accepted",
			{ modelId, unmetCapabilities: resolution.unmetCapabilities },
		);
		// Fall through to accept the hint anyway
	} else {
		return {
			output: `Model "${modelId}" not found in cluster.`,
			// ...
		};
	}
}
```

Import `CapabilityRequirements` at the top of the file:
```typescript
import type { CapabilityRequirements } from "@bound/llm";
```

**Verification:**
```bash
tsc -p packages/agent --noEmit
bun test packages/agent
```
Expected: exits 0, all tests pass

**Commit:** `feat(agent/model-hint): derive vision requirements from thread history`
<!-- END_TASK_7 -->

<!-- END_SUBCOMPONENT_D -->

<!-- START_TASK_8 -->
### Task 8: Full Phase 5 verification

**Verifies:** All Phase 5 ACs end-to-end

**Step 1: Run the Bedrock-compat test** (must not regress):
```bash
bun test packages/agent/src/__tests__/context-bedrock-compat.test.ts
```
Expected: all tests pass

**Step 2: Run all agent tests:**
```bash
bun test packages/agent
```
Expected: all tests pass, 0 fail

**Step 3: Full typecheck:**
```bash
bun run typecheck
```
Expected: exits 0

**Commit:** (only if fixups needed) `fix(phase5): address typecheck issues`
<!-- END_TASK_8 -->

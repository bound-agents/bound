# Model Robustness Implementation Plan — Phase 1

**Goal:** Introduce `image` and `document` as first-class `ContentBlock` variants, add `ImageSource` and `CapabilityRequirements` types, and extend the config schema and shared types with capability overrides and structured attachment/host-model types.

**Architecture:** Pure TypeScript type additions — no behavioral changes. Widens the `ContentBlock` discriminated union in `packages/llm/src/types.ts`, introduces `CapabilityRequirements` (used by the resolution pipeline in Phase 5), and adds `capabilities` override field to `modelBackendSchema` and structured `AttachmentPayload` / `HostModelEntry` types to `packages/shared`. Existing driver code uses `if/else if` chains that silently ignore new variants; TypeScript 6.x's automatic filter-type-predicate inference means `extractTextFromBlocks` in `stream-utils.ts` continues to narrow correctly.

**Tech Stack:** TypeScript 6.x, Zod v4, bun:test

**Scope:** Phase 1 of 7 (phases 1–7)

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

This phase establishes the type foundation. It does not introduce behavior, so it verifies no ACs directly — subsequent phases implement and test the ACs that rely on these types.

**Verification method:** `bun run typecheck` exits 0; `bun test packages/llm` and `bun test packages/shared` exit 0 with no regressions.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Extend `packages/llm/src/types.ts` with ImageSource, image/document ContentBlock variants, and CapabilityRequirements

**Verifies:** None (type-only phase)

**Files:**
- Modify: `packages/llm/src/types.ts:26-28`

**Implementation:**

Replace the two-variant `ContentBlock` definition (currently lines 26–28) with the four-variant version, and add `ImageSource` and `CapabilityRequirements` as new exports. Insert after line 25 (after `LLMMessage`) as follows:

The new `ContentBlock` section replaces lines 26–28:

```typescript
export type ImageSource =
	| { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string }
	| { type: "file_ref"; file_id: string };

export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	| { type: "image"; source: ImageSource; description?: string }
	| { type: "document"; source: ImageSource; text_representation: string; title?: string };

export interface CapabilityRequirements {
	vision?: boolean;
	tool_use?: boolean;
	system_prompt?: boolean;
	prompt_caching?: boolean;
}
```

**Notes:**
- `ImageSource.file_ref` carries a `file_id` referencing a row in the `files` table (used for attachments ≥ 1 MB; introduced in Phase 7).
- `document.text_representation` is pre-extracted plain text stored at ingestion time (Phase 7), enabling text-fallback in context assembly (Phase 5) without on-the-fly extraction.
- `CapabilityRequirements` will be consumed by `resolveModel()` in Phase 5; placing it here keeps all capability-related interfaces co-located with `BackendCapabilities`.
- The existing `BackendCapabilities` interface (lines 38–45) is **unchanged** — it already has the `vision` field.

**Verification:**

```bash
tsc -p packages/llm --noEmit
```
Expected: exits 0

```bash
bun test packages/llm
```
Expected: all tests pass, 0 fail

**Commit:** `feat(llm): add ImageSource, image/document ContentBlock variants, CapabilityRequirements`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add capabilities override to `config-schemas.ts`, and add `AttachmentPayload` / `HostModelEntry` to `shared/types.ts`

**Verifies:** None (type-only phase)

**Files:**
- Modify: `packages/shared/src/config-schemas.ts:30–45` (add `backendCapabilitiesOverrideSchema` before `modelBackendSchema` and add `capabilities` field)
- Modify: `packages/shared/src/types.ts:329–337` (update `IntakePayload.attachments`, add `AttachmentPayload` and `HostModelEntry`)

**Implementation:**

**`packages/shared/src/config-schemas.ts`:**

`shared` cannot import from `@bound/llm` (the dependency graph flows `shared` ← `llm`, not the other way). Define the capabilities override schema inline — its inferred TypeScript type is structurally identical to `Partial<BackendCapabilities>`, which TypeScript's structural type system accepts.

Before the `modelBackendSchema` definition (currently line 31), add:

```typescript
const backendCapabilitiesOverrideSchema = z
	.object({
		streaming: z.boolean(),
		tool_use: z.boolean(),
		system_prompt: z.boolean(),
		prompt_caching: z.boolean(),
		vision: z.boolean(),
		max_context: z.number().int().positive(),
	})
	.partial();
```

Then add `capabilities: backendCapabilitiesOverrideSchema.optional()` as the last field in `modelBackendSchema`:

```typescript
const modelBackendSchema = z.object({
	id: z.string().min(1),
	provider: z.enum(["ollama", "bedrock", "anthropic", "openai-compatible"]),
	model: z.string().min(1),
	base_url: z.string().url().optional(),
	api_key: z.string().optional(),
	region: z.string().optional(),
	profile: z.string().optional(),
	context_window: z.number().int().positive(),
	tier: z.number().int().min(1).max(5),
	price_per_m_input: z.number().min(0).default(0),
	price_per_m_output: z.number().min(0).default(0),
	price_per_m_cache_write: z.number().min(0).optional(),
	price_per_m_cache_read: z.number().min(0).optional(),
	capabilities: backendCapabilitiesOverrideSchema.optional(),
});
```

The exported `ModelBackendsConfig` type (via `z.infer`) automatically picks up the new field.

---

**`packages/shared/src/types.ts`:**

Add `AttachmentPayload` before `IntakePayload`, and `HostModelEntry` near the `Host` interface. Update `IntakePayload.attachments` to use the new type.

Add before `IntakePayload` (currently line 329):

```typescript
export interface AttachmentPayload {
	filename: string;
	content_type: string; // MIME type, e.g. "image/jpeg"
	size: number; // bytes
	url: string; // platform CDN URL for download
	description?: string; // optional caption from the platform
}
```

Add near the `Host` interface (currently lines 128–140):

```typescript
/**
 * Object format for hosts.models entries. Carries capability metadata alongside the
 * model ID. The legacy string format (plain model ID) is parsed by relay-router.ts
 * without capability metadata (treated as "unverified").
 */
/**
 * Mirror of Partial<BackendCapabilities> from @bound/llm — defined inline here to avoid
 * a circular dependency (shared cannot import from llm). If BackendCapabilities gains new
 * fields, this inline type MUST be updated to match. TypeScript's structural typing keeps
 * them compatible at usage sites even without a shared reference.
 */
export interface HostModelEntry {
	id: string;
	tier?: number;
	capabilities?: {
		streaming?: boolean;
		tool_use?: boolean;
		system_prompt?: boolean;
		prompt_caching?: boolean;
		vision?: boolean;
		max_context?: number;
	};
}
```

Update `IntakePayload.attachments` from `unknown[]` to `AttachmentPayload[]`:

```typescript
export interface IntakePayload {
	platform: string;
	platform_event_id: string;
	thread_id: string;
	user_id: string;
	message_id: string;
	content: string;
	attachments?: AttachmentPayload[];
}
```

**Notes:**
- `HostModelEntry.capabilities` uses an inline object type (structurally identical to `Partial<BackendCapabilities>`) to avoid a circular dependency on `@bound/llm`.
- Phase 6 will update `relay-router.ts` to parse `hosts.models` as either `string` (legacy) or `HostModelEntry` object. Phase 1 only adds the type.
- The `capabilities` field in `modelBackendSchema` defaults to `undefined` (absent), preserving full backward compatibility — existing `model_backends.json` files without this field continue to parse successfully.

**Verification:**

```bash
tsc -p packages/shared --noEmit
```
Expected: exits 0

```bash
bun test packages/shared
```
Expected: all existing tests pass, 0 fail. Confirm `config-schemas.test.ts` passes — the new optional `capabilities` field does not require changes to existing test fixtures.

**Commit:** `feat(shared): add AttachmentPayload, HostModelEntry; add capabilities override field to modelBackendSchema`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Full typecheck across all packages

**Verifies:** None (infrastructure verification)

**Step 1: Run full typecheck**

```bash
bun run typecheck
```
Expected: exits 0

**Step 2: Run affected package tests**

```bash
bun test packages/llm packages/shared
```
Expected: all tests pass, 0 fail

**If typecheck fails on ContentBlock widening:**

The most likely issue is in packages that pattern-match `ContentBlock` variants. Check these files:
- `packages/llm/src/stream-utils.ts` — uses `TypeScript 6.x` auto-narrowing filter; should be fine
- `packages/llm/src/anthropic-driver.ts` — uses `if (block.type === "tool_use") ... else if (block.type === "text") ...` chains; silently ignores new variants
- `packages/llm/src/bedrock-driver.ts` — same pattern; silently ignores new variants
- `packages/llm/src/openai-driver.ts` — uses `(block): block is Extract<typeof block, { type: "tool_use" }>` filter; TypeScript compiles fine with wider union
- `packages/llm/src/ollama-driver.ts` — same as openai pattern
- `packages/agent/src/context-assembly.ts` — only checks `block.type === "tool_use"` for tool-pair tracking; safe

If TypeScript reports an error about accessing a property that doesn't exist on all `ContentBlock` members, fix by using type narrowing (e.g., `if (block.type === "image") { ... }`) rather than accessing `block.source` directly without a guard.

**Commit:** (only if fixes were needed) `fix: handle wider ContentBlock union in switch statements`
<!-- END_TASK_3 -->

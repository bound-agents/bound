# Model Robustness Implementation Plan — Phase 7

**Goal:** Discord attachments are downloaded and normalized into typed `image` ContentBlocks, persisted to the `messages` table. Large attachments (≥ 1 MB) are stored as `file_ref` entries in the `files` table. Context assembly (Phase 5) then handles these blocks end-to-end for vision-capable and non-vision backends.

**Architecture:** Primary change is in `packages/platforms/src/connectors/discord.ts` — the `onMessage()` handler gains attachment download and ContentBlock construction logic. `IntakePayload.content` and `attachments` carry the normalized data through the relay. The relay-processor intake handler is verified to pass through the `message_id` correctly (no structural change needed since the agent loop reads from DB by message_id).

**Key facts from investigation:**
- Discord.js `msg.attachments` is a `Collection<Snowflake, Attachment>` — iterate with `.values()`
- Each `Attachment` has: `url` (CDN URL), `size` (bytes), `contentType` (MIME), `description` (optional alt-text), `name` (filename)
- Download with `fetch(attachment.url).then(r => r.bytes())` → `Buffer.from(bytes).toString("base64")`
- Files table has: `id TEXT PK`, `path TEXT`, `content TEXT` (nullable), `is_binary INTEGER`, `size_bytes INTEGER`, `created_at TEXT`, `modified_at TEXT`, `deleted INTEGER`, `created_by TEXT`, `host_origin TEXT`
- `messages.content` column is `TEXT NOT NULL` — stores plain string or JSON-serialized `ContentBlock[]`
- The relay-processor intake handler creates a `process` relay with only `message_id` — content is read from DB by agent loop

**Tech Stack:** TypeScript 6.x, Discord.js, bun:sqlite, bun:test

**Scope:** Phase 7 of 7

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### model-robustness.AC7.5 (from AC7): Platform attachment normalization
- **model-robustness.AC7.5 Success:** Discord attachment is normalized to an `image` ContentBlock and persisted; large attachments (≥ 1 MB) are stored as `file_ref` in the `files` table

### model-robustness.AC1: Image and document content blocks (integration)
- **model-robustness.AC1.1 Success:** An `image` block with `base64` source round-trips through serialization/deserialization without data loss
- **model-robustness.AC1.2 Success:** An `image` block with `file_ref` source serializes to a path string and deserializes back to a `file_ref` source

> **AC1.3 de-scoped from this plan:** AC1.3 requires "A `document` block carries a non-empty `text_representation` after ingestion." This plan normalizes Discord image attachments but does NOT implement document/PDF attachment ingestion. The `document` ContentBlock type is defined (Phase 1) and context assembly handles it (Phase 5), but no connector creates document blocks in this plan. AC1.3 is deferred to a future plan that adds document attachment ingestion (e.g., PDF, text file, Word document normalization).

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Discord connector — download and normalize attachments to `image` ContentBlocks

**Verifies:** model-robustness.AC7.5, model-robustness.AC1.1, model-robustness.AC1.2

**Files:**
- Modify: `packages/platforms/src/connectors/discord.ts` — the `onMessage()` method

**Implementation:**

Read the full `discord.ts` file first to understand the complete `onMessage()` implementation and where the `insertRow` for messages is called. The method is around lines 209-246 per the investigation. You need to understand:
- Where `messageId`, `user`, `thread`, and `now` are defined
- The imports at the top (what's already imported from `@bound/shared`, `@bound/core`, etc.)

**Add imports** at the top of the file:
```typescript
import { randomUUID } from "node:crypto";
import type { ContentBlock } from "@bound/llm";
```
Check existing imports — `randomUUID` may already be imported, and `@bound/llm` may or may not be imported.

**Define the attachment threshold constant** near the top of the class or file:
```typescript
/** Attachments >= this size are stored as file_ref entries in the files table. */
const ATTACHMENT_FILE_REF_THRESHOLD = 1024 * 1024; // 1 MB

/** Discord image MIME types supported as ContentBlock image variants */
const DISCORD_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
```

**Extend `onMessage()`** to process attachments. Find the current message persistence section (where `insertRow(this.db, "messages", {...})` is called) and replace/extend it:

```typescript
// Build message content — may be string (text only) or JSON ContentBlock[] (with images)
const contentBlocks: ContentBlock[] = [];

if (msg.content) {
	contentBlocks.push({ type: "text", text: msg.content });
}

// Process image attachments
for (const attachment of msg.attachments.values()) {
	const contentType = attachment.contentType ?? "";
	if (!DISCORD_IMAGE_TYPES.has(contentType)) continue; // Skip non-image attachments

	const mediaType = contentType as "image/jpeg" | "image/png" | "image/gif" | "image/webp";

	try {
		const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) {
			this.logger.warn("[discord] Failed to download attachment", {
				url: attachment.url,
				status: response.status,
			});
			continue;
		}
		const bytes = await response.bytes();
		const base64Data = Buffer.from(bytes).toString("base64");

		if (attachment.size >= ATTACHMENT_FILE_REF_THRESHOLD) {
			// Large attachment: store in files table and use file_ref source
			const fileId = randomUUID();
			insertRow(
				this.db,
				"files",
				{
					id: fileId,
					path: `discord-attachments/${attachment.id}/${attachment.name}`,
					content: base64Data,
					is_binary: 1,
					size_bytes: attachment.size,
					created_at: now,
					modified_at: now,
					host_origin: this.siteId,
					deleted: 0,
					created_by: user.id,
				},
				this.siteId,
			);
			contentBlocks.push({
				type: "image",
				source: { type: "file_ref", file_id: fileId },
				description: attachment.description ?? attachment.name,
			});
		} else {
			// Inline: embed as base64 directly in ContentBlock
			contentBlocks.push({
				type: "image",
				source: { type: "base64", media_type: mediaType, data: base64Data },
				description: attachment.description ?? attachment.name,
			});
		}
	} catch (err) {
		this.logger.warn("[discord] Error processing attachment, skipping", {
			attachmentId: attachment.id,
			error: String(err),
		});
	}
}

// Determine the stored content format
// - If no attachments were processed: store plain text (backward-compatible)
// - If image blocks were added: store as JSON ContentBlock[]
const hasImageBlocks = contentBlocks.some((b) => b.type === "image");
const messageContent = hasImageBlocks
	? JSON.stringify(contentBlocks)
	: msg.content;

// Persist the message with normalized content
insertRow(
	this.db,
	"messages",
	{
		id: messageId,
		thread_id: thread.id,
		role: "user",
		content: messageContent,
		model_id: null,
		tool_name: null,
		created_at: now,
		modified_at: now,
		host_origin: this.siteId,
		deleted: 0,
	},
	this.siteId,
);
```

**Note:** The `files` table uses the same `insertRow()` / change-log outbox pattern as other synced tables. This ensures file entries are synced to other hosts in the cluster.

**Note on `onMessage()` async handling:** The Discord event handler currently calls `this.onMessage(msg).catch(...)`. If `onMessage()` is not already `async`, you may need to make it so. Check the current implementation.

**Note on `files.path` format:** The path `discord-attachments/{attachment.id}/{filename}` follows a namespaced convention. Phase 5's `file_ref` resolution uses `files.id` (not `path`), so the path is informational only.

**Verification:**
```bash
tsc -p packages/platforms --noEmit
bun test packages/platforms
```
Expected: exits 0, all tests pass

**Commit:** `feat(platforms/discord): download and normalize image attachments to ContentBlocks`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Update `IntakePayload` to carry typed `AttachmentPayload[]` (finalization from Phase 1)

**Verifies:** None (AC1.3 de-scoped — see note in AC Coverage section; this task types the IntakePayload correctly but does not create document blocks)

**Files:**
- Verify: `packages/shared/src/types.ts` (Phase 1 should have already updated `IntakePayload.attachments` to `AttachmentPayload[]`)

**Implementation:**

Check whether Phase 1 already updated `IntakePayload.attachments` from `unknown[]` to `AttachmentPayload[]`. If not, make that change now. The `AttachmentPayload` type should be:

```typescript
export interface AttachmentPayload {
	filename: string;
	content_type: string; // MIME type, e.g. "image/jpeg"
	size: number;         // bytes
	url: string;          // platform CDN URL for download
	description?: string; // optional caption from the platform
}

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

Also update the discord connector's `IntakePayload` construction (when writing the relay outbox entry) to include `attachments` metadata (not the binary content — just metadata for logging/diagnostics):

```typescript
// In the section where writeOutbox is called for intake:
payload: JSON.stringify({
	platform: "discord",
	platform_event_id: msg.id,
	thread_id: thread.id,
	user_id: user.id,
	message_id: messageId,
	content: msg.content, // Plain text content (image blocks are in messages table)
	attachments: Array.from(msg.attachments.values()).map((a) => ({
		filename: a.name,
		content_type: a.contentType ?? "application/octet-stream",
		size: a.size,
		url: a.url,
		description: a.description ?? undefined,
	})),
} satisfies IntakePayload),
```

**Note:** The binary image data is NOT included in the relay payload — only metadata. The actual ContentBlock data (base64 or file_ref) was already persisted to the DB by Task 1.

**Verification:**
```bash
tsc -p packages/shared --noEmit
tsc -p packages/platforms --noEmit
```
Expected: exits 0

**Commit:** `feat(shared): finalize IntakePayload.attachments as AttachmentPayload[]`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Verify relay-processor intake handler with ContentBlock[] content

**Verifies:** AC7.5 (end-to-end relay flow)

**Files:**
- Read: `packages/agent/src/relay-processor.ts` (intake handler section around lines 289-338)
- Potentially modify if the handler needs updates

**Implementation:**

**Verify the intake handler flow is correct for ContentBlock[] content:**

The current relay-processor intake handler:
1. Parses `IntakePayload` from `entry.payload`
2. Creates a `process` relay targeting the selected host
3. The `ProcessPayload` carries only `thread_id`, `message_id`, `user_id`, `platform`
4. The agent loop reads the message from DB using `message_id`

Since the discord connector persists the ContentBlock[] JSON to `messages.content` BEFORE writing the intake relay to `relay_outbox`, by the time the relay-processor picks up the intake entry, the message is already in the DB with the correct content.

**Verify no changes are needed** by confirming:
- The agent loop's run state machine reads messages by `threadId` from DB — it does NOT read from the relay payload
- The `process` relay just triggers the agent loop to run — it doesn't carry message content
- `IntakePayload.attachments` is now typed as `AttachmentPayload[]` but the relay-processor doesn't need to read it (it's informational)

**If the relay-processor handles a case where it persists messages itself** (check for any `insertRow(this.db, "messages", ...)` calls in the intake handler), verify that it uses `payload.content` correctly. If `content` could be a JSON ContentBlock[] string, the existing `insertRow` call would store it as-is (which is correct).

**If no changes are needed:** Document this with a comment explaining the flow and skip the task. Only commit if actual code changes are required.

```bash
grep -n "insertRow.*messages" packages/agent/src/relay-processor.ts
```
If this returns no results for the intake section, no changes are needed.

**Verification:**
```bash
bun test packages/agent --test-name-pattern "relay-processor"
```
Expected: all existing relay-processor tests pass

**Commit:** (only if changes needed) `fix(agent/relay-processor): handle ContentBlock[] content in intake flow`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Integration test — attachment ingestion to context assembly

**Verifies:** model-robustness.AC7.5, model-robustness.AC1.1, model-robustness.AC1.2

**Files:**
- Create: `packages/platforms/src/__tests__/discord-attachment.test.ts`

**Implementation:**

Create an integration test that verifies the full flow from Discord attachment arrival to ContentBlock storage.

The test mocks:
1. A Discord message with image attachments (using a mock Discord.js Message object)
2. `global.fetch` to return mock binary data for the CDN URL

Then verifies:
- Small attachment (< 1 MB): stored as base64 inline `image` ContentBlock in `messages.content`
- Large attachment (≥ 1 MB): stored as `file_ref` in `files` table + `image` ContentBlock with `file_ref` source in `messages.content`
- The stored JSON round-trips correctly through JSON.parse

```typescript
describe("Discord attachment ingestion", () => {
    let db: Database;
    let connector: DiscordConnector;
    // ...setup with in-memory DB...

    afterAll(() => {
        global.fetch = originalFetch; // restore
    });

    it("small image attachment stored as inline base64 ContentBlock (AC1.1, AC7.5)", async () => {
        const mockImageBytes = new Uint8Array([137, 80, 78, 71]); // PNG header
        global.fetch = async (url: string | URL | Request) => {
            if (String(url).includes("cdn.discordapp.com")) {
                return new Response(mockImageBytes, {
                    headers: { "Content-Type": "image/png" },
                });
            }
            return originalFetch(url);
        };

        const mockMessage = createMockDiscordMessage({
            content: "Here's a photo",
            attachments: [{ id: "att1", name: "photo.png", size: 1024, contentType: "image/png", url: "https://cdn.discordapp.com/photo.png", description: "my photo" }],
        });

        await connector.handleTestMessage(mockMessage); // or trigger via event

        const message = db.query("SELECT content FROM messages WHERE thread_id = ?").get(threadId) as { content: string };
        const blocks = JSON.parse(message.content);
        expect(Array.isArray(blocks)).toBe(true);
        const imageBlock = blocks.find((b: { type: string }) => b.type === "image");
        expect(imageBlock).toBeDefined();
        expect(imageBlock.source.type).toBe("base64");
        expect(imageBlock.source.media_type).toBe("image/png");
        expect(imageBlock.description).toBe("my photo");
        expect(imageBlock.source.data.length).toBeGreaterThan(0);
    });

    it("large image attachment (>= 1MB) stored as file_ref (AC1.2, AC7.5)", async () => {
        // 1.1 MB attachment
        const largeBytes = new Uint8Array(1.1 * 1024 * 1024).fill(255);
        global.fetch = async () => new Response(largeBytes, {
            headers: { "Content-Type": "image/jpeg" },
        });

        const mockMessage = createMockDiscordMessage({
            content: "Big image",
            attachments: [{ id: "att2", name: "big.jpg", size: 1.1 * 1024 * 1024, contentType: "image/jpeg", url: "https://cdn.discordapp.com/big.jpg" }],
        });

        await connector.handleTestMessage(mockMessage);

        // Check files table has entry
        const fileRow = db.query("SELECT id, content FROM files WHERE path LIKE 'discord-attachments%'").get() as { id: string; content: string } | null;
        expect(fileRow).not.toBeNull();
        expect(fileRow!.content.length).toBeGreaterThan(0); // base64 stored

        // Check message has file_ref block
        const message = db.query("SELECT content FROM messages WHERE role = 'user' ORDER BY created_at DESC LIMIT 1").get() as { content: string };
        const blocks = JSON.parse(message.content);
        const imageBlock = blocks.find((b: { type: string }) => b.type === "image");
        expect(imageBlock.source.type).toBe("file_ref");
        expect(imageBlock.source.file_id).toBe(fileRow!.id);
    });

    it("message with no image attachments stores plain text (backward-compat)", async () => {
        const mockMessage = createMockDiscordMessage({ content: "plain text", attachments: [] });
        await connector.handleTestMessage(mockMessage);

        const message = db.query("SELECT content FROM messages WHERE role = 'user' ORDER BY created_at DESC LIMIT 1").get() as { content: string };
        expect(message.content).toBe("plain text"); // Not JSON
    });
});
```

**Helper:** Create a `createMockDiscordMessage()` helper in the test file that builds a minimal Discord.js Message-like object for testing.

**Verification:**
```bash
bun test packages/platforms
```
Expected: all tests pass, 0 fail

**Commit:** `test(platforms): add Discord attachment ingestion integration test`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_5 -->
### Task 5: Full Phase 7 verification

**Verifies:** All Phase 7 ACs end-to-end

**Step 1: Run all affected packages:**
```bash
bun test packages/platforms
bun test packages/agent
bun test packages/shared
```
Expected: all pass, 0 fail

**Step 2: Full typecheck:**
```bash
bun run typecheck
```
Expected: exits 0

**Step 3: Verify Phase 5 context assembly still passes Bedrock-compat test:**
```bash
bun test packages/agent/src/__tests__/context-bedrock-compat.test.ts
```
Expected: all tests pass

**Commit:** (only if fixups needed) `fix(phase7): address issues from Phase 7 implementation`
<!-- END_TASK_5 -->

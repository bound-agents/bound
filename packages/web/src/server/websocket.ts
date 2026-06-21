import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { persistImageBlocksAsFileRefs } from "@bound/agent";
import {
	acknowledgeClientToolCall,
	enqueueToolResult,
	expireClientToolCallsForConnection,
	getPendingClientToolCalls,
	insertRow,
	softDelete,
	updateClaimedBy,
	updateRow,
} from "@bound/core";
import {
	appendToolDuration,
	capToolResultContent,
	formatFileAttachment,
	getTraceExporter,
	reExportSpans,
} from "@bound/shared";
import type {
	Message,
	SerializedSpan,
	StatusForwardPayload,
	TypedEventEmitter,
	WsStreamChunk,
} from "@bound/shared";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { storeFile } from "./routes/files";

// Zod schemas for all client→server message types
const sessionConfigureSchema = z.object({
	type: z.literal("session:configure"),
	tools: z.array(
		z.object({
			type: z.literal("function"),
			function: z.object({
				name: z.string(),
				description: z.string(),
				parameters: z.record(z.string(), z.unknown()),
			}),
		}),
	),
	systemPromptAddition: z.string().optional(),
});

// ContentBlock variants accepted from clients on the prompt + tool:result
// paths (excludes tool_use and thinking — those are agent-emitted, never
// client-sent). Shared by message:send (image/document prompt attachments)
// and tool:result (binary tool outputs).
const contentBlockSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), text: z.string() }),
	z.object({
		type: z.literal("image"),
		source: z.object({
			type: z.enum(["base64", "file_ref"]),
			media_type: z.string().optional(),
			data: z.string().optional(),
			file_id: z.string().optional(),
		}),
		description: z.string().optional(),
	}),
	z.object({
		type: z.literal("document"),
		source: z.object({
			type: z.enum(["base64", "file_ref"]),
			media_type: z.string().optional(),
			data: z.string().optional(),
			file_id: z.string().optional(),
		}),
		text_representation: z.string(),
		title: z.string().optional(),
	}),
]);

const messageSendSchema = z.object({
	type: z.literal("message:send"),
	thread_id: z.string(),
	content: z.union([z.string(), z.array(contentBlockSchema)]),
	file_ids: z.array(z.string()).optional(),
	model_id: z.string().optional(),
	trace_context: z.string().optional(),
	// Sender's UTC offset in minutes (east-of-UTC positive: EDT=-240, JST=+540),
	// captured client-side at send. Stored in messages.metadata.tz_offset and read
	// by Stage-5 annotation to render the user-message timestamp prefix in local
	// wall-clock. Optional: absent for autonomous/task-driven user messages.
	tz_offset: z.number().int().min(-840).max(840).optional(),
});

const threadSubscribeSchema = z.object({
	type: z.literal("thread:subscribe"),
	thread_id: z.string(),
});

const threadUnsubscribeSchema = z.object({
	type: z.literal("thread:unsubscribe"),
	thread_id: z.string(),
});

const toolResultSchema = z.object({
	type: z.literal("tool:result"),
	call_id: z.string(),
	thread_id: z.string(),
	content: z.union([z.string(), z.array(contentBlockSchema)]),
	is_error: z.boolean().optional(),
	trace_data: z.string().optional(), // serialized span array JSON (optional)
});

// Silent context staging — an MCP App's `ui/update-model-context` persists a
// `developer`-role message WITHOUT firing a turn. Per invariant #9 the staged
// row merges into the next user turn (wrapped in <system-context>), and an
// orphan stage with no following user turn is naturally dropped — which is
// exactly "stage for the next interaction" semantics. This is the spec-correct
// counterpart to `message:send` (which is `ui/message`: persist a user turn AND
// fire inference now).
const contextStageSchema = z.object({
	type: z.literal("context:stage"),
	thread_id: z.string(),
	content: z.union([z.string(), z.array(contentBlockSchema)]),
});

// Discriminated union for all message types
const wsClientMessageSchema = z.discriminatedUnion("type", [
	sessionConfigureSchema,
	messageSendSchema,
	threadSubscribeSchema,
	threadUnsubscribeSchema,
	toolResultSchema,
	contextStageSchema,
]);

interface ClientConnection {
	ws: ServerWebSocket<unknown>;
	connectionId: string;
	subscriptions: Set<string>;
	clientTools: Map<
		string,
		{
			type: "function";
			function: {
				name: string;
				description: string;
				parameters: Record<string, unknown>;
			};
		}
	>;
	systemPromptAddition: string | undefined;
	threadSystemPromptAdditions: Map<string, string>;
}

export interface WebSocketConfig {
	open(ws: ServerWebSocket<unknown>): void;
	message(ws: ServerWebSocket<unknown>, message: string | Buffer): void;
	close(ws: ServerWebSocket<unknown>): void;
}

export interface ConnectionRegistry {
	/** Find client tools registered by connections subscribed to a thread */
	getClientToolsForThread(threadId: string): Map<
		string,
		{
			type: "function";
			function: {
				name: string;
				description: string;
				parameters: Record<string, unknown>;
			};
		}
	>;
	/** Get the connectionId of the connection that has a specific tool for a thread */
	getConnectionForTool(threadId: string, toolName: string): string | undefined;
	/** Get systemPromptAddition for a thread from the first subscribed connection that has one */
	getSystemPromptAdditionForThread(threadId: string): string | undefined;
}

export interface WebSocketHandlerConfig {
	eventBus: TypedEventEmitter;
	db?: Database;
	siteId?: string;
	defaultUserId?: string;
	hostOrigin?: string;
	/**
	 * Span tracker for cross-handler-invocation OTel spans. When provided,
	 * `tool:result` reception closes the matching `tool.dispatch` span, and
	 * `tool:cancel` paths close it with ERROR. When absent, dispatch spans
	 * are not closed by the WS handler (the watchdog eventually closes them
	 * with `watchdog_timeout` instead).
	 *
	 * Typed as a minimal interface to avoid pulling `@bound/agent` into
	 * the web package's import graph; the concrete implementation lives in
	 * `packages/agent/src/handle-message-tracker.ts`.
	 */
	handleMessageTracker?: {
		closeDispatch(callId: string, status?: "ok" | "error", reason?: string): void;
	};
}

export function createWebSocketHandler(
	config: WebSocketHandlerConfig | TypedEventEmitter,
): WebSocketConfig & {
	cleanup: () => void;
	registry: ConnectionRegistry;
	emitToolCancel: (
		entries: Array<{ event_payload: string | null; claimed_by: string | null; message_id: string }>,
		threadId: string,
		reason: "thread_canceled" | "dispatch_expired" | "session_reset",
	) => void;
} {
	// Support both old (eventBus only) and new (config object) signatures for backwards compatibility
	let eventBus: TypedEventEmitter;
	let db: Database | undefined;
	let siteId: string | undefined;
	let defaultUserId: string | undefined;
	let hostOrigin = "localhost:3000";
	let handleMessageTracker: WebSocketHandlerConfig["handleMessageTracker"];

	if ("on" in config && "emit" in config) {
		// Old signature: eventBus parameter
		eventBus = config;
	} else {
		// New signature: config object
		eventBus = config.eventBus;
		db = config.db;
		siteId = config.siteId;
		defaultUserId = config.defaultUserId;
		hostOrigin = config.hostOrigin ?? "localhost:3000";
		handleMessageTracker = config.handleMessageTracker;
	}

	const clients = new Map<ServerWebSocket<unknown>, ClientConnection>();

	/**
	 * Helper to re-deliver pending client tool calls that match the connection's tools.
	 * Skips entries already claimed by this connection to prevent redundant re-sends.
	 */
	function redeliverPendingToolCalls(conn: ClientConnection, threadId: string): void {
		if (!db || !siteId) return;

		const pending = getPendingClientToolCalls(db, threadId);
		for (const entry of pending) {
			// Skip entries already claimed by this connection
			if (entry.claimed_by === conn.connectionId) {
				continue;
			}

			if (!entry.event_payload) continue;
			try {
				const payload = JSON.parse(entry.event_payload) as {
					call_id?: string;
					tool_name?: string;
					arguments?: Record<string, unknown>;
				};

				// Check if this tool matches one of the client's registered tools
				if (payload.tool_name && conn.clientTools.has(payload.tool_name)) {
					// Update claimed_by to new connection (AC7.2)
					updateClaimedBy(db, entry.message_id, conn.connectionId);

					// Re-deliver tool:call
					conn.ws.send(
						JSON.stringify({
							type: "tool:call",
							call_id: payload.call_id,
							thread_id: threadId,
							tool_name: payload.tool_name,
							arguments: payload.arguments,
						}),
					);
				}
			} catch {
				// Ignore parse errors and continue
			}
		}
	}

	const handleMessageCreated = (data: {
		message: unknown;
		thread_id: string;
	}): void => {
		for (const [ws, conn] of clients) {
			if (conn.subscriptions.has(data.thread_id)) {
				const message = JSON.stringify({
					type: "message:created",
					data: data.message,
				});
				if (ws.readyState === 1) {
					ws.send(message);
				}
			}
		}
	};

	const handleTaskCompleted = (data: {
		task_id: string;
		result: string | null;
	}): void => {
		const message = JSON.stringify({
			type: "task:updated",
			data: {
				taskId: data.task_id,
				status: "completed",
			},
		});

		for (const [ws] of clients) {
			if (ws.readyState === 1) {
				ws.send(message);
			}
		}
	};

	const handleFileChanged = (data: {
		path: string;
		operation: "created" | "modified" | "deleted";
	}): void => {
		const message = JSON.stringify({
			type: "file:updated",
			data: {
				path: data.path,
				operation: data.operation,
			},
		});

		for (const [ws] of clients) {
			if (ws.readyState === 1) {
				ws.send(message);
			}
		}
	};

	const handleAlertCreated = (data: {
		message: unknown;
		thread_id: string;
	}): void => {
		const message = JSON.stringify({
			type: "alert",
			data: data.message,
		});

		for (const [ws, conn] of clients) {
			if (conn.subscriptions.has(data.thread_id)) {
				if (ws.readyState === 1) {
					ws.send(message);
				}
			}
		}
	};

	const handleContextDebug = (data: {
		thread_id: string;
		turn_id: string;
		debug: unknown;
	}): void => {
		for (const [ws, conn] of clients) {
			if (conn.subscriptions.has(data.thread_id)) {
				const message = JSON.stringify({
					type: "context:debug",
					data: { turn_id: data.turn_id, debug: data.debug, thread_id: data.thread_id },
				});
				if (ws.readyState === 1) {
					ws.send(message);
				}
			}
		}
	};

	function handleSessionConfigure(
		conn: ClientConnection,
		msg: z.infer<typeof sessionConfigureSchema>,
	): void {
		conn.clientTools.clear();
		for (const tool of msg.tools) {
			conn.clientTools.set(tool.function.name, tool);
		}

		// Store or clear systemPromptAddition per connection (AC2.4, AC2.6)
		conn.systemPromptAddition = msg.systemPromptAddition;

		// Update threadSystemPromptAdditions for all subscribed threads (AC2.4)
		if (msg.systemPromptAddition !== undefined) {
			for (const threadId of conn.subscriptions) {
				conn.threadSystemPromptAdditions.set(threadId, msg.systemPromptAddition);
			}
		} else {
			// Clear all per-thread entries when systemPromptAddition is undefined (AC2.4, AC2.6)
			conn.threadSystemPromptAdditions.clear();
		}

		// Update tool-bearing client-session affinity rows for all subscribed
		// threads. A plain web UI subscribes to receive message/status events but
		// registers no client tools, so it must not pin inference to its host; a
		// boundless attach subscribes first, then configures tools, and becomes the
		// affinity target here.
		for (const threadId of conn.subscriptions) {
			if (conn.clientTools.size > 0) {
				evictOtherToolBearingSessions(conn, threadId);
				recordClientSession(conn, threadId);
			} else {
				clearClientSession(conn, threadId);
			}
		}

		// Re-deliver pending client tool calls for each subscribed thread (AC7.1-AC7.2)
		for (const threadId of conn.subscriptions) {
			redeliverPendingToolCalls(conn, threadId);
		}
	}

	function handleThreadSubscribe(
		conn: ClientConnection,
		msg: z.infer<typeof threadSubscribeSchema>,
	): void {
		conn.subscriptions.add(msg.thread_id);

		// Record client-session affinity only for tool-bearing clients. A web UI
		// subscription is just a viewport; pinning inference to that host would
		// mask the actual boundless session on another spoke.
		if (conn.clientTools.size > 0) {
			evictOtherToolBearingSessions(conn, msg.thread_id);
			recordClientSession(conn, msg.thread_id);
		}

		// Propagate systemPromptAddition to the new subscription (AC2.3)
		if (conn.systemPromptAddition !== undefined) {
			conn.threadSystemPromptAdditions.set(msg.thread_id, conn.systemPromptAddition);
		}

		// Re-deliver pending client tool calls on this thread (AC7.1-AC7.2)
		// In case session:configure happened before thread:subscribe
		redeliverPendingToolCalls(conn, msg.thread_id);
	}

	function handleThreadUnsubscribe(
		conn: ClientConnection,
		msg: z.infer<typeof threadUnsubscribeSchema>,
	): void {
		conn.subscriptions.delete(msg.thread_id);

		// Drop client-session affinity for this (connection, thread) pair.
		clearClientSession(conn, msg.thread_id);

		// Clean up systemPromptAddition for this thread (AC2.5)
		conn.threadSystemPromptAdditions.delete(msg.thread_id);
	}

	/**
	 * Enforce single-tool-bearing-session-per-thread (issue #189).
	 *
	 * The affinity + dispatch model assumes one tool provider per thread:
	 * `recordClientSession` writes one `client_sessions` row per
	 * (connection, thread), and `getConnectionForTool` first-matches by
	 * `clients` insertion order. Two tool-bearing connections on the same
	 * thread make both indeterminate — two affinity rows compete for
	 * cross-spoke routing, and a duplicate tool name resolves to whichever
	 * connection was inserted first. (The old `clientTools.size > 0` guard
	 * assumed a plain web UI never registers tools; that is not a durable
	 * invariant.)
	 *
	 * Most-recent-wins: when `keep` becomes a tool provider on `threadId`,
	 * evict every *other* tool-bearing connection from that thread. Eviction
	 * drops the older connection's subscription to this thread (which also
	 * stops its tools merging via `getClientToolsForThread`, since that gates
	 * on `subscriptions`), clears its affinity row and per-thread system
	 * prompt addition, and sends a `session:evicted` notice so the client can
	 * resubscribe read-only or surface the takeover. The older connection
	 * keeps its tools and any other thread subscriptions untouched.
	 *
	 * In-flight client tool calls the evicted connection had claimed are
	 * re-delivered to `keep` by the `redeliverPendingToolCalls` pass that
	 * follows configure/subscribe (it re-sends entries not claimed by the
	 * receiving connection), so no call is stranded.
	 */
	function evictOtherToolBearingSessions(keep: ClientConnection, threadId: string): void {
		for (const [ws, other] of clients) {
			if (other === keep) continue;
			if (!other.subscriptions.has(threadId)) continue;
			if (other.clientTools.size === 0) continue;

			other.subscriptions.delete(threadId);
			other.threadSystemPromptAdditions.delete(threadId);
			clearClientSession(other, threadId);

			if (ws.readyState === 1) {
				ws.send(
					JSON.stringify({
						type: "session:evicted",
						thread_id: threadId,
						reason: "superseded_by_new_tool_session",
					}),
				);
			}
		}
	}

	/**
	 * Upsert a client_sessions row for (connection, thread) on this host.
	 * Idempotent across re-subscribes: a re-subscribe on the same connection
	 * re-undeletes/bumps the existing row rather than failing on the PK.
	 */
	function recordClientSession(conn: ClientConnection, threadId: string): void {
		if (!db || !siteId) return;
		const id = `${conn.connectionId}::${threadId}`;
		const now = new Date().toISOString();
		const existing = db.query("SELECT id FROM client_sessions WHERE id = ?").get(id) as {
			id: string;
		} | null;
		if (existing) {
			updateRow(db, "client_sessions", id, { site_id: siteId, deleted: 0 }, siteId);
			return;
		}
		insertRow(
			db,
			"client_sessions",
			{
				id,
				connection_id: conn.connectionId,
				thread_id: threadId,
				site_id: siteId,
				created_at: now,
				deleted: 0,
				modified_at: now,
			},
			siteId,
		);
	}

	/** Soft-delete the client_sessions row for one (connection, thread) pair. */
	function clearClientSession(conn: ClientConnection, threadId: string): void {
		if (!db || !siteId) return;
		const id = `${conn.connectionId}::${threadId}`;
		const existing = db
			.query("SELECT id FROM client_sessions WHERE id = ? AND deleted = 0")
			.get(id) as { id: string } | null;
		if (existing) {
			softDelete(db, "client_sessions", id, siteId);
		}
	}

	/** Soft-delete all client_sessions rows held by a connection (on disconnect). */
	function clearAllClientSessions(conn: ClientConnection): void {
		if (!db || !siteId) return;
		const rows = db
			.query("SELECT id FROM client_sessions WHERE connection_id = ? AND deleted = 0")
			.all(conn.connectionId) as Array<{ id: string }>;
		for (const { id } of rows) {
			softDelete(db, "client_sessions", id, siteId);
		}
	}

	async function handleMessageSend(
		conn: ClientConnection,
		msg: z.infer<typeof messageSendSchema>,
	): Promise<void> {
		if (!db || !siteId || !defaultUserId) {
			conn.ws.send(
				JSON.stringify({
					type: "error",
					code: "handler_not_configured",
					message: "Message handler not configured with required dependencies",
				}),
			);
			return;
		}

		try {
			const MAX_CONTENT_LENGTH = 512 * 1024; // 512KB
			// Per-attachment decoded byte cap for inline image/document prompts.
			// Generous enough for editor screenshots; bounds a single malicious
			// or accidental megablob before it hits the files table.
			const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB

			// Validate content is non-empty
			if (typeof msg.content !== "string") {
				if (msg.content.length === 0) {
					conn.ws.send(
						JSON.stringify({
							type: "error",
							code: "invalid_content",
							message: "Content must not be empty",
						}),
					);
					return;
				}
			} else {
				if (!msg.content.trim()) {
					conn.ws.send(
						JSON.stringify({
							type: "error",
							code: "invalid_content",
							message: "Content must not be empty",
						}),
					);
					return;
				}

				// Validate content length
				if (msg.content.length > MAX_CONTENT_LENGTH) {
					conn.ws.send(
						JSON.stringify({
							type: "error",
							code: "content_too_large",
							message: `Maximum content length is ${MAX_CONTENT_LENGTH / 1024}KB`,
						}),
					);
					return;
				}
			}

			// Verify thread exists
			const thread = db
				.query("SELECT * FROM threads WHERE id = ? AND deleted = 0")
				.get(msg.thread_id);
			if (!thread) {
				conn.ws.send(
					JSON.stringify({
						type: "error",
						code: "thread_not_found",
						message: "Thread not found",
					}),
				);
				return;
			}

			// Resolve file_ids (text attachments) — shared by both content forms.
			const MAX_FILE_IDS = 20;
			const fileIds: string[] = (Array.isArray(msg.file_ids) ? msg.file_ids : [])
				.filter((id): id is string => typeof id === "string")
				.slice(0, MAX_FILE_IDS);
			const fileAttachmentText = (): string[] => {
				const lines: string[] = [];
				for (const fileId of fileIds) {
					const file = db.query("SELECT * FROM files WHERE id = ? AND deleted = 0").get(fileId) as {
						path: string;
						size_bytes: number;
					} | null;
					if (!file) continue;
					const name = file.path.split("/").pop() ?? file.path;
					lines.push(formatFileAttachment(name, file.path, file.size_bytes));
				}
				return lines;
			};

			let persistedContent: string;
			if (typeof msg.content === "string") {
				// Text prompt: append any file_ids as formatted text attachments.
				let content = msg.content;
				for (const line of fileAttachmentText()) {
					content += `\n\n${line}`;
				}
				persistedContent = content;
			} else {
				// Block prompt (image/document attachments). Rewrite any inline
				// base64 image/document source to a file_ref by writing the bytes
				// to the files table via storeFile — keeps messages.content light
				// and lets the blob sync + dedupe through the files table. The
				// readback seam (parseContentBlocks in agent-loop-utils) resolves
				// file_ref back to bytes at driver time via createFileRefResolver.
				const blocks: Array<Record<string, unknown>> = [];
				for (const block of msg.content) {
					if (
						(block.type === "image" || block.type === "document") &&
						block.source.type === "base64" &&
						block.source.data
					) {
						const bytes = Buffer.from(block.source.data, "base64");
						if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
							conn.ws.send(
								JSON.stringify({
									type: "error",
									code: "content_too_large",
									message: `Maximum attachment size is ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB`,
								}),
							);
							return;
						}
						const mimeType = block.source.media_type ?? "application/octet-stream";
						const subtype = mimeType.split("/")[1]?.replace(/[^a-zA-Z0-9]/g, "") || "bin";
						const fileId = await storeFile(db, siteId, {
							name: `prompt-attachment.${subtype}`,
							mimeType,
							data: bytes.buffer.slice(
								bytes.byteOffset,
								bytes.byteOffset + bytes.byteLength,
							) as ArrayBuffer,
							createdBy: defaultUserId,
							hostOrigin,
						});
						blocks.push({
							...block,
							source: { type: "file_ref", media_type: mimeType, file_id: fileId },
						});
					} else {
						blocks.push(block as Record<string, unknown>);
					}
				}
				// file_ids ride along as trailing text blocks (parity with the
				// text path — the agent loop renders text blocks identically).
				for (const line of fileAttachmentText()) {
					blocks.push({ type: "text", text: line });
				}
				// Only persist as a JSON ContentBlock[] when a non-text block is
				// present — that is the exact condition parseContentBlocks parses
				// back on readback. A text-only array flattens to a plain string
				// (identical delivery) so the readback always round-trips.
				const hasNonText = blocks.some((b) => b.type === "image" || b.type === "document");
				persistedContent = hasNonText
					? JSON.stringify(blocks)
					: blocks
							.map((b) => (b.type === "text" ? ((b.text as string) ?? "") : ""))
							.filter((t) => t.length > 0)
							.join("\n\n");
			}

			// Persist the message
			const messageId = randomUUID();
			const now = new Date().toISOString();

			// Stamp the sender's UTC offset (minutes) onto the message metadata bag
			// when the client supplied one, so Stage-5 annotation can render the
			// timestamp prefix in the sender's local wall-clock. Written once at
			// insert and never mutated — keeps the annotation byte-stable.
			const tzMetadata =
				typeof msg.tz_offset === "number" ? JSON.stringify({ tz_offset: msg.tz_offset }) : null;

			insertRow(
				db,
				"messages",
				{
					id: messageId,
					thread_id: msg.thread_id,
					role: "user",
					content: persistedContent,
					model_id: null,
					tool_name: null,
					created_at: now,
					modified_at: now,
					host_origin: hostOrigin,
					deleted: 0,
					exit_code: null,
					metadata: tzMetadata,
				},
				siteId,
			);

			// Update thread model_hint if model_id is provided
			if (msg.model_id) {
				updateRow(
					db,
					"threads",
					msg.thread_id,
					{
						model_hint: msg.model_id,
						modified_at: now,
					},
					siteId,
				);
			}

			// Retrieve the persisted message
			const message = db.query("SELECT * FROM messages WHERE id = ?").get(messageId) as Message;

			// Emit message:created event to trigger agent loop
			eventBus.emit("message:created", {
				message,
				thread_id: msg.thread_id,
				trace_context: msg.trace_context,
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : "Unknown error";
			conn.ws.send(
				JSON.stringify({
					type: "error",
					code: "message_send_failed",
					message: errorMsg,
				}),
			);
		}
	}

	// Silently stage a `developer`-role context message WITHOUT firing a turn.
	// This is the spec-correct `ui/update-model-context` path: the row sits in
	// the thread and is merged into the NEXT user turn by context assembly
	// (invariant #9, wrapped in <system-context>). No `message:created` emit, so
	// no inference is triggered now — the staged context is seen on the next
	// interaction, and an orphan stage with no following user turn is naturally
	// dropped, which is exactly the intended "stage for next time" semantics.
	function handleContextStage(
		conn: ClientConnection,
		msg: z.infer<typeof contextStageSchema>,
	): void {
		if (!db || !siteId) {
			conn.ws.send(
				JSON.stringify({
					type: "error",
					code: "handler_not_configured",
					message: "Context stage handler not configured with required dependencies",
				}),
			);
			return;
		}

		try {
			// Developer context is text-only — flatten any block form to its text
			// blocks (update-model-context carries no attachments).
			const text =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.map((b) => (b.type === "text" ? b.text : ""))
							.filter((t) => t.length > 0)
							.join("\n\n");

			if (!text.trim()) {
				conn.ws.send(
					JSON.stringify({
						type: "error",
						code: "invalid_content",
						message: "Content must not be empty",
					}),
				);
				return;
			}

			const thread = db
				.query("SELECT id FROM threads WHERE id = ? AND deleted = 0")
				.get(msg.thread_id);
			if (!thread) {
				conn.ws.send(
					JSON.stringify({
						type: "error",
						code: "thread_not_found",
						message: "Thread not found",
					}),
				);
				return;
			}

			const messageId = randomUUID();
			const now = new Date().toISOString();
			insertRow(
				db,
				"messages",
				{
					id: messageId,
					thread_id: msg.thread_id,
					role: "developer",
					content: text,
					model_id: null,
					tool_name: null,
					created_at: now,
					modified_at: now,
					host_origin: hostOrigin,
					deleted: 0,
					exit_code: null,
					metadata: null,
				},
				siteId,
			);
			// Deliberately NO eventBus.emit("message:created") — staging must not
			// drive a turn.
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : "Unknown error";
			conn.ws.send(
				JSON.stringify({
					type: "error",
					code: "context_stage_failed",
					message: errorMsg,
				}),
			);
		}
	}

	function reExportClientTraceData(traceData: string): void {
		try {
			const spans = JSON.parse(traceData) as SerializedSpan[];
			const exporter = getTraceExporter();
			reExportSpans(spans, exporter);
		} catch {
			// Invalid trace_data — silently ignore, observability never blocks tool flow
		}
	}

	function handleToolResult(conn: ClientConnection, msg: z.infer<typeof toolResultSchema>): void {
		if (!db || !siteId || !defaultUserId) {
			conn.ws.send(
				JSON.stringify({
					type: "error",
					code: "handler_not_configured",
					message: "Tool result handler not configured with required dependencies",
				}),
			);
			return;
		}

		try {
			const now = new Date().toISOString();
			const TTL_MS = 5 * 60 * 1000; // 5 minutes
			const cutoff = new Date(Date.now() - TTL_MS).toISOString();

			// First check for expired entries with this call_id (AC3.4)
			const expiredEntry = db
				.prepare(
					`SELECT * FROM dispatch_queue
					 WHERE thread_id = ? AND event_type = 'client_tool_call' AND status = 'expired'`,
				)
				.all(msg.thread_id) as Array<{
				message_id: string;
				event_payload: string | null;
			}>;

			for (const entry of expiredEntry) {
				if (!entry.event_payload) continue;
				try {
					const payload = JSON.parse(entry.event_payload) as { call_id?: string };
					if (payload.call_id === msg.call_id) {
						// AC3.4: Late tool:result for canceled call is silently discarded
						// (accepted but not persisted, no error response)
						return;
					}
				} catch {
					// Ignore parse errors
				}
			}

			// Look up the pending client tool call entry
			const pendingCalls = getPendingClientToolCalls(db, msg.thread_id);
			let matchingEntry = null;

			for (const entry of pendingCalls) {
				if (!entry.event_payload) continue;
				try {
					const payload = JSON.parse(entry.event_payload) as { call_id?: string };
					if (payload.call_id === msg.call_id) {
						matchingEntry = entry;
						break;
					}
				} catch {
					// Ignore parse errors and continue searching
				}
			}

			if (!matchingEntry) {
				conn.ws.send(
					JSON.stringify({
						type: "error",
						code: "unknown_call_id",
						message: "No pending tool call with this call_id",
						call_id: msg.call_id,
					}),
				);
				return;
			}

			// Check if entry has expired based on TTL (AC3.4)
			if (matchingEntry.created_at < cutoff) {
				// Late tool:result for expired call is silently discarded
				// (accepted but not persisted, no error response)
				return;
			}

			// Persist the tool_result message
			const messageId = randomUUID();

			// Handle content: normalize string to ContentBlock[], or persist array as-is
			let persistedContent: string;
			if (typeof msg.content === "string") {
				// AC10.1: Normalize string to ContentBlock array
				const contentBlocks = [{ type: "text" as const, text: msg.content }];
				persistedContent = msg.is_error
					? JSON.stringify([{ type: "text", text: `Error: ${msg.content}` }])
					: JSON.stringify(contentBlocks);
			} else {
				// AC10.2: Persist ContentBlock array verbatim — but rewrite any
				// inline-base64 image block to a file_ref first (same as the
				// native agent-loop dispatch return), so a screenshot-sized
				// payload from a client tool (boundless_read) never hits the cap.
				const lightened =
					db && siteId
						? persistImageBlocksAsFileRefs(
								msg.content as Parameters<typeof persistImageBlocksAsFileRefs>[0],
								db,
								siteId,
							)
						: msg.content;
				persistedContent = JSON.stringify(lightened);
			}

			// Universal tool-result cap. Backstop for client-side tools that don't
			// enforce their own byte caps (or for misbehaving clients writing
			// arbitrary content). Per-tool caps in well-behaved client tools
			// (e.g., boundless_bash's 50KB/half) run first; this catches the gap.
			// The truncation marker embedded in the content is itself observable
			// in the persisted messages row, so no separate log is emitted here.
			//
			// The duration suffix (#77) is appended BEFORE the cap so middle-cut
			// preserves it in the tail. Elapsed is computed from the dispatch
			// entry's created_at — for client-deferred tools this is the
			// end-to-end roundtrip the agent observed (dispatch issued → result
			// landed), which is what the agent should reason about.
			const dispatchStartMs = new Date(matchingEntry.created_at).getTime();
			const elapsedMs = Date.now() - dispatchStartMs;
			persistedContent = appendToolDuration(persistedContent, elapsedMs);
			persistedContent = capToolResultContent(persistedContent);

			insertRow(
				db,
				"messages",
				{
					id: messageId,
					thread_id: msg.thread_id,
					role: "tool_result",
					content: persistedContent,
					model_id: null,
					tool_name: msg.call_id,
					created_at: now,
					modified_at: now,
					host_origin: hostOrigin,
					deleted: 0,
					exit_code: msg.is_error ? 1 : 0,
					metadata: null,
				},
				siteId,
			);

			// Acknowledge the dispatch entry
			acknowledgeClientToolCall(db, matchingEntry.message_id);

			// Enqueue tool result trigger to resume agent loop
			enqueueToolResult(db, msg.thread_id, msg.call_id);

			// Re-export client trace_data spans if present (AC6.3)
			if (msg.trace_data) {
				reExportClientTraceData(msg.trace_data);
			}

			// Close the matching `tool.dispatch` span. Status mirrors the
			// tool result. The re-exported `client-tool.execute` span shows
			// up under this dispatch via the carrier we injected at dispatch
			// time, so closing here ends the round-trip wall-clock cleanly.
			handleMessageTracker?.closeDispatch(
				msg.call_id,
				msg.is_error ? "error" : "ok",
				msg.is_error ? "tool_error" : undefined,
			);

			// Emit an event to trigger handleThread (re-emit the message so subscribed clients see it)
			const message = db.query("SELECT * FROM messages WHERE id = ?").get(messageId) as Message;
			eventBus.emit("message:created", {
				message,
				thread_id: msg.thread_id,
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : "Unknown error";
			conn.ws.send(
				JSON.stringify({
					type: "error",
					code: "tool_result_failed",
					message: errorMsg,
				}),
			);
		}
	}

	const handleClientToolCallCreated = (data: {
		threadId: string;
		callId: string;
		entryId: string;
		toolName: string;
		arguments: Record<string, unknown>;
		traceContext?: Record<string, string> | null;
	}): void => {
		// Find the first connection subscribed to this thread that has the matching tool.
		// data.traceContext is captured by the agent loop while its tool-execute span is
		// active. We can't call injectTraceContext() here — this listener runs outside the
		// emitter's OTel context and would observe no active span.
		for (const [, conn] of clients) {
			if (conn.subscriptions.has(data.threadId) && conn.clientTools.has(data.toolName)) {
				const toolCallMessage = JSON.stringify({
					type: "tool:call",
					call_id: data.callId,
					thread_id: data.threadId,
					tool_name: data.toolName,
					arguments: data.arguments,
					...(data.traceContext ? { trace_context: JSON.stringify(data.traceContext) } : {}),
				});
				if (conn.ws.readyState === 1) {
					conn.ws.send(toolCallMessage);
				}
				// Update dispatch_queue entry status to 'processing' and claimed_by to connectionId
				if (db) {
					try {
						updateClaimedBy(db, data.entryId, conn.connectionId);
					} catch {
						// Ignore errors from updating dispatch queue
					}
				}
				break; // Deliver to first matching connection
			}
		}
	};

	const handleThreadStatus = (data: {
		threadId: string;
		active: boolean;
		state: string | null;
		tokens: number;
		model: string | null;
	}): void => {
		for (const [, conn] of clients) {
			if (conn.subscriptions.has(data.threadId)) {
				const statusMessage = JSON.stringify({
					type: "thread:status",
					thread_id: data.threadId,
					active: data.active,
					state: data.state,
					tokens: data.tokens,
					model: data.model,
				});
				if (conn.ws.readyState === 1) {
					conn.ws.send(statusMessage);
				}
			}
		}
	};

	const handleStatusForward = (data: StatusForwardPayload): void => {
		// Only push thread:status if the payload is for a thread (not a task)
		if (data.thread_id) {
			handleThreadStatus({
				threadId: data.thread_id,
				active: data.status !== "idle",
				state: data.status,
				tokens: data.tokens,
				model: data.detail,
			});
		}
	};

	const handleStreamChunk = (data: { thread_id: string; chunk: WsStreamChunk }): void => {
		for (const [, conn] of clients) {
			if (conn.subscriptions.has(data.thread_id)) {
				if (conn.ws.readyState === 1) {
					conn.ws.send(
						JSON.stringify({
							type: "stream:chunk",
							thread_id: data.thread_id,
							chunk: data.chunk,
						}),
					);
				}
			}
		}
	};

	/**
	 * Helper to emit tool:cancel for pending client tool calls.
	 * Takes pre-fetched dispatch entries, threadId, and reason.
	 * For TTL expiry and connection close, synthesizes error messages.
	 */
	function emitToolCancel(
		entries: Array<{ event_payload: string | null; claimed_by: string | null; message_id: string }>,
		threadId: string,
		reason: "thread_canceled" | "dispatch_expired" | "session_reset",
		claimedByConnectionId?: string,
	): void {
		for (const entry of entries) {
			if (!entry.event_payload) continue;
			try {
				const payload = JSON.parse(entry.event_payload) as { call_id?: string; tool_name?: string };
				if (!payload.call_id) continue;

				// Find the connection that claimed this entry
				let targetConnection: ClientConnection | undefined;
				if (claimedByConnectionId) {
					// For connection close: find by claimed_by
					for (const [, conn] of clients) {
						if (conn.connectionId === claimedByConnectionId) {
							targetConnection = conn;
							break;
						}
					}
				} else if (entry.claimed_by) {
					// General case: find by claimed_by
					for (const [, conn] of clients) {
						if (conn.connectionId === entry.claimed_by) {
							targetConnection = conn;
							break;
						}
					}
				} else {
					// Fallback: find any subscribed connection
					for (const [, conn] of clients) {
						if (conn.subscriptions.has(threadId)) {
							targetConnection = conn;
							break;
						}
					}
				}

				if (targetConnection && targetConnection.ws.readyState === 1) {
					targetConnection.ws.send(
						JSON.stringify({
							type: "tool:cancel",
							call_id: payload.call_id,
							thread_id: threadId,
							reason,
						}),
					);
				}

				// Close the dispatch span with ERROR status. The reason is
				// the same string we send over the wire so traces and logs
				// agree on the cancellation cause.
				handleMessageTracker?.closeDispatch(payload.call_id, "error", reason);

				// For TTL expiry and connection close, synthesize error messages
				if ((reason === "dispatch_expired" || reason === "session_reset") && db && siteId) {
					const now = new Date().toISOString();
					const errorContent =
						reason === "dispatch_expired"
							? "Error: Tool call expired (dispatch_expired)"
							: "Error: Client tool call cancelled: client disconnected (session_reset)";

					insertRow(
						db,
						"messages",
						{
							id: randomUUID(),
							thread_id: threadId,
							role: "tool_result",
							content: errorContent,
							model_id: null,
							tool_name: payload.call_id,
							created_at: now,
							modified_at: now,
							host_origin: hostOrigin,
							deleted: 0,
							exit_code: null,
							metadata: null,
						},
						siteId,
					);

					// Enqueue tool result to wake the agent loop
					enqueueToolResult(db, threadId, payload.call_id);
				}
			} catch {
				// Ignore parse errors and continue
			}
		}
	}

	// Connection registry implementation
	const registry: ConnectionRegistry = {
		getClientToolsForThread(threadId: string) {
			const merged = new Map<
				string,
				{
					type: "function";
					function: {
						name: string;
						description: string;
						parameters: Record<string, unknown>;
					};
				}
			>();
			for (const [, conn] of clients) {
				if (conn.subscriptions.has(threadId)) {
					for (const [name, def] of conn.clientTools) {
						merged.set(name, def);
					}
				}
			}
			return merged;
		},

		getConnectionForTool(threadId: string, toolName: string): string | undefined {
			for (const [, conn] of clients) {
				if (conn.subscriptions.has(threadId) && conn.clientTools.has(toolName)) {
					return conn.connectionId;
				}
			}
			return undefined;
		},

		getSystemPromptAdditionForThread(threadId: string): string | undefined {
			for (const [, conn] of clients) {
				if (conn.subscriptions.has(threadId)) {
					const addition = conn.threadSystemPromptAdditions.get(threadId);
					if (addition !== undefined) {
						return addition;
					}
				}
			}
			return undefined;
		},
	};

	eventBus.on("message:created", handleMessageCreated);
	// message:broadcast is used for assistant-response re-emit so it reaches
	// WebSocket clients without re-triggering the agent loop handler.
	eventBus.on("message:broadcast", handleMessageCreated);
	eventBus.on("task:completed", handleTaskCompleted);
	eventBus.on("file:changed", handleFileChanged);
	eventBus.on("alert:created", handleAlertCreated);
	eventBus.on("context:debug", handleContextDebug);
	eventBus.on("client_tool_call:created", handleClientToolCallCreated);
	eventBus.on("status:forward", handleStatusForward);
	eventBus.on("stream:chunk", handleStreamChunk);

	return {
		open(ws: ServerWebSocket<unknown>): void {
			const conn: ClientConnection = {
				ws,
				connectionId: crypto.randomUUID(),
				subscriptions: new Set(),
				clientTools: new Map(),
				systemPromptAddition: undefined,
				threadSystemPromptAdditions: new Map(),
			};
			clients.set(ws, conn);
		},

		message(ws: ServerWebSocket<unknown>, rawMessage: string | Buffer): void {
			if (typeof rawMessage !== "string") {
				return;
			}

			const conn = clients.get(ws);
			if (!conn) return;

			try {
				const parsed = wsClientMessageSchema.safeParse(JSON.parse(rawMessage));
				if (!parsed.success) {
					// Invalid message schema, send error response
					ws.send(
						JSON.stringify({
							type: "error",
							code: "invalid_message",
							message: parsed.error.message,
						}),
					);
					return;
				}

				const message = parsed.data;

				switch (message.type) {
					case "session:configure": {
						handleSessionConfigure(conn, message);
						break;
					}
					case "thread:subscribe": {
						handleThreadSubscribe(conn, message);
						break;
					}
					case "thread:unsubscribe": {
						handleThreadUnsubscribe(conn, message);
						break;
					}
					case "context:stage": {
						handleContextStage(conn, message);
						break;
					}
					case "message:send": {
						handleMessageSend(conn, message);
						break;
					}
					case "tool:result": {
						handleToolResult(conn, message);
						break;
					}
				}
			} catch {
				// Invalid JSON, send error response
				ws.send(
					JSON.stringify({
						type: "error",
						code: "invalid_json",
						message: "Invalid JSON",
					}),
				);
			}
		},

		close(ws: ServerWebSocket<unknown>): void {
			const conn = clients.get(ws);
			if (conn && db && siteId) {
				// A closing connection can never return results for the client tool
				// calls it was handling. Resolve them to a terminal 'expired' state
				// (both 'pending' and delivered-but-unanswered 'processing'), synthesize
				// paired error tool_results, and clear the resume barrier so the thread
				// isn't wedged at one-message-per-turn on the next bump.
				//
				// Previously this scanned `status = 'pending'` only, so a call that had
				// been delivered (→ 'processing') was missed entirely; and even for the
				// rows it found, `emitToolCancel` writes the paired result but never
				// flips the dispatch_queue status, so `hasPendingClientToolCalls` stayed
				// true forever and `server.ts` returned after one tool every turn. An
				// editor restart re-claims the orphan to the new connection (see
				// redeliverPendingToolCalls), defeating the TTL expiry scan's live-session
				// exclusion (1c0027f6) — so connection-close is the only seam that can
				// reliably reap a delivered-but-unanswered call. The two are complementary:
				// the TTL scan spares calls a live session may still complete; close reaps
				// calls whose session just went away.
				const expired = expireClientToolCallsForConnection(db, conn.connectionId);
				if (expired.length > 0) {
					const byThread = new Map<string, typeof expired>();
					for (const entry of expired) {
						const list = byThread.get(entry.thread_id) ?? [];
						list.push(entry);
						byThread.set(entry.thread_id, list);
					}
					for (const [threadId, entries] of byThread) {
						emitToolCancel(entries, threadId, "session_reset", conn.connectionId);
					}
				}

				// Drop client-session affinity rows held by this connection so
				// notify/introspect wakeups stop being routed to a host whose
				// session just went away (issue #91).
				clearAllClientSessions(conn);
			}
			clients.delete(ws);
		},

		cleanup(): void {
			eventBus.off("message:created", handleMessageCreated);
			eventBus.off("message:broadcast", handleMessageCreated);
			eventBus.off("task:completed", handleTaskCompleted);
			eventBus.off("file:changed", handleFileChanged);
			eventBus.off("alert:created", handleAlertCreated);
			eventBus.off("context:debug", handleContextDebug);
			eventBus.off("client_tool_call:created", handleClientToolCallCreated);
			eventBus.off("status:forward", handleStatusForward);
			eventBus.off("stream:chunk", handleStreamChunk);
			clients.clear();
		},

		registry,
		emitToolCancel,
	};
}

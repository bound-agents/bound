/**
 * Per-ACP-session state and the prompt-turn lifecycle.
 *
 * One {@link AcpSession} maps 1:1 to a bound thread (the ACP `sessionId` IS the
 * bound `threadId`). The owning server (see `server.ts`) holds the single shared
 * `BoundClient` and routes WebSocket events to the right session by `thread_id`,
 * calling the `handle*` methods here.
 *
 * Responsibilities:
 * - Translate bound stream chunks into ACP `session/update` notifications.
 * - Gate client-side tool calls behind `session/request_permission` and execute
 *   the approved ones via the existing boundless tool handlers.
 * - Resolve a `session/prompt` request with a `StopReason` when the bound turn
 *   completes (`thread:status` active:false) or is cancelled.
 */

import { randomUUID } from "node:crypto";
import {
	type AgentSideConnection,
	type PermissionOptionId,
	type PromptResponse,
	RequestError,
	type ToolCallStatus,
} from "@agentclientprotocol/sdk";
import type { BoundClient, ToolCallRequest, ToolCallResult } from "@bound/client";
import type { ContentBlock } from "@bound/llm";
import type { WsStreamChunk } from "@bound/shared";
import type { AppLogger } from "../logging";
import type { ResolvedShell } from "../tools/shell";
import type { ToolHandler } from "../tools/types";
import {
	PERMISSION_OPTIONS,
	isShellToolName,
	streamChunkToSessionUpdate,
	toolCallContent,
	toolCallLocations,
	toolCallMeta,
	toolCallTitle,
	toolNameToKind,
	toolResultToAcpContent,
} from "./mapping";
import { DEFAULT_MODE_ID, type SessionModeId, modePermissionDecision } from "./modes";

/** Whether a remembered permission decision allows or rejects a tool. */
type PermissionDecision = "allow" | "reject";

/** State for a single in-flight prompt turn. */
interface TurnState {
	/** Resolves the pending `prompt()` call. Invoked exactly once. */
	resolve: (response: PromptResponse) => void;
	/** Rejects the pending `prompt()` call with a JSON-RPC error. Invoked exactly once. */
	reject: (err: unknown) => void;
	/** Set when the client sent `session/cancel` during this turn. */
	cancelled: boolean;
	/** True once we've observed the daemon enter the active ("thinking") state. */
	seenActive: boolean;
	/** Whether the turn has already been resolved (idempotency guard). */
	resolved: boolean;
	/**
	 * Most recent alert (`role: "alert"`) message text seen this turn, or null.
	 * The daemon surfaces inference timeouts and non-retryable LLM errors via
	 * `emitAlert` (a broadcast `alert` message), NOT the response stream. When
	 * the turn goes idle having produced no assistant text, a recorded alert is
	 * treated as turn-fatal and rejects the prompt.
	 */
	alert: string | null;
	/** True once an `agent_message_chunk` (real response text) has been sent. */
	sawAgentText: boolean;
	/**
	 * Daemon-side (native) tool calls surfaced this turn, holding the
	 * session-unique ACP toolCallId (see {@link AcpSession.acpToolCallId}) so the
	 * turn-end completion cleanup addresses the same id the lifecycle used.
	 */
	openDaemonToolCalls: Set<string>;
	/**
	 * Maps a model-supplied tool-call id to the session-unique ACP toolCallId
	 * minted for it this turn. Reset per turn (fresh map) so a per-request id the
	 * Responses API reuses across turns (call_1, call_2, …) gets a distinct ACP
	 * id each turn, while pending/in_progress/completed for one call share an id.
	 */
	acpToolCallIds: Map<string, string>;
	/**
	 * ACP message id for the in-progress agent_message_chunk run, or null when
	 * no run is open. Generated lazily on the first text chunk of a run and
	 * stable across every chunk of that message; cleared when a thought run or a
	 * tool call breaks the run so the next text starts a fresh message. Required
	 * on streamed chunks in ACP v2; optional (but forward-compatible) in v1.
	 */
	agentMessageId: string | null;
	/** Same as {@link agentMessageId} for the agent_thought_chunk run. */
	thoughtMessageId: string | null;
}

export interface AcpSessionDeps {
	/** ACP sessionId, equal to the bound threadId. */
	sessionId: string;
	/** Absolute working directory negotiated at session/new. */
	cwd: string;
	hostname: string;
	shell: ResolvedShell;
	/** Connection used to push session/update and request permissions. */
	conn: Pick<AgentSideConnection, "sessionUpdate" | "requestPermission">;
	/** Shared bound client (only the methods this session needs). */
	client: Pick<BoundClient, "sendMessage" | "cancelThread">;
	/** Tool handlers built for this session's cwd (from buildToolSet). */
	toolHandlers: Map<string, ToolHandler>;
	/** Names of tools that execute on the boundless host (client tools). */
	clientToolNames: Set<string>;
	/** Model alias to send with prompts, or null for the cluster default. */
	modelId: string | null;
	logger: AppLogger;
}

function shellDisplayName(toolName: string): string {
	if (toolName.includes("pwsh") || toolName.includes("powershell")) return "PowerShell";
	if (toolName.includes("cmd")) return "Command";
	return "Bash";
}

function shellTerminalOutput(
	toolName: string,
	toolCallId: string,
	content: ToolCallResult["content"],
): {
	meta: Record<string, unknown>;
	rawOutput: Record<string, unknown>;
} {
	const textBlocks =
		typeof content === "string"
			? [content]
			: content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.filter((text) => !text.startsWith("[boundless] "));
	const text = textBlocks.join("\n");
	const parsed = text.match(/^Exit code: (\d+)\nstdout:\n([\s\S]*)\nstderr:\n([\s\S]*)$/);
	const exitCode = parsed ? Number(parsed[1]) : null;
	const stdout = parsed?.[2] ?? text;
	const stderr = parsed?.[3] ?? "";
	let output = [stdout, stderr].filter((part) => part.length > 0).join("\n");
	if (output.length === 0) {
		output =
			exitCode && exitCode !== 0
				? `(${shellDisplayName(toolName)} exited with code ${exitCode})\n`
				: `(${shellDisplayName(toolName)} completed with no output)\n`;
	}

	return {
		meta: {
			terminal_output: {
				terminal_id: toolCallId,
				data: output,
			},
			terminal_exit: {
				terminal_id: toolCallId,
				...(exitCode !== null ? { exit_code: exitCode } : {}),
			},
		},
		rawOutput: {
			output: text,
			...(exitCode !== null ? { exitCode } : {}),
		},
	};
}

export class AcpSession {
	private readonly deps: AcpSessionDeps;
	private turn: TurnState | null = null;
	/**
	 * Session-monotonic counter feeding {@link acpToolCallId}. Never reset, so a
	 * raw id reused across turns (Responses-API call_1) maps to a distinct ACP id
	 * each turn. Suffix only — the raw id stays the human-readable prefix.
	 */
	private toolCallIdSeq = 0;
	private modelId: string | null;
	private mode: SessionModeId = DEFAULT_MODE_ID;
	private readonly permissionMemory = new Map<string, PermissionDecision>();
	/** Accumulated argument JSON for in-flight daemon-side tool_use streams. */
	private readonly daemonToolArgs = new Map<string, string>();
	/** AbortControllers for in-flight client tool executions (for cancel). */
	private readonly inFlightTools = new Set<AbortController>();
	/**
	 * call_ids of client tool calls dispatched during the current turn whose
	 * results have not yet been handed back to the daemon. Non-empty means the
	 * daemon has exited its loop to await a boundless-host tool result and is
	 * reporting the thread idle in the meantime — so a `thread:status` idle must
	 * NOT be treated as turn completion (see `handleThreadStatus`).
	 */
	private readonly pendingClientToolCalls = new Set<string>();

	constructor(deps: AcpSessionDeps) {
		this.deps = deps;
		this.modelId = deps.modelId;
	}

	get sessionId(): string {
		return this.deps.sessionId;
	}

	/**
	 * Runs one prompt turn: sends the user text to bound and returns a promise
	 * that resolves with the StopReason once the daemon goes idle (or the turn
	 * is cancelled). The promise is resolved by `handleThreadStatus`.
	 */
	runPrompt(content: string | ContentBlock[]): Promise<PromptResponse> {
		return new Promise<PromptResponse>((resolve, reject) => {
			this.turn = {
				resolve,
				reject,
				cancelled: false,
				seenActive: false,
				resolved: false,
				alert: null,
				sawAgentText: false,
				openDaemonToolCalls: new Set(),
				acpToolCallIds: new Map(),
				agentMessageId: null,
				thoughtMessageId: null,
			};
			this.deps.client.sendMessage(this.deps.sessionId, content, {
				modelId: this.modelId ?? undefined,
			});
		});
	}

	setModelId(modelId: string | null): void {
		this.modelId = modelId;
	}

	setMode(mode: SessionModeId): void {
		this.mode = mode;
	}

	/** Marks the current turn cancelled and asks the daemon to abort it. */
	async cancel(): Promise<void> {
		if (this.turn) {
			this.turn.cancelled = true;
		}
		for (const controller of this.inFlightTools) {
			controller.abort();
		}
		try {
			await this.deps.client.cancelThread(this.deps.sessionId);
		} catch (error) {
			this.deps.logger.error("acp_cancel_failed", {
				sessionId: this.deps.sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Cancels work and resolves any active prompt before the session is discarded. */
	async close(): Promise<void> {
		await this.cancel();
		this.resolveTurn("cancelled");
	}

	/**
	 * Translates a bound stream chunk into ACP notifications. Text and thinking
	 * become message/thought chunks; daemon-side tool_use streams become
	 * tool_call lifecycle updates; errors are recorded on the turn.
	 */
	async handleStreamChunk(chunk: WsStreamChunk): Promise<void> {
		const simple = streamChunkToSessionUpdate(chunk);
		if (simple) {
			if (simple.sessionUpdate === "agent_message_chunk" && this.turn) {
				this.turn.sawAgentText = true;
			}
			await this.send(simple);
			return;
		}
		switch (chunk.type) {
			case "tool_use_start":
				// Client tools arrive via the authoritative tool:call dispatch
				// (handleToolCall); skip them here to avoid double-reporting.
				if (this.deps.clientToolNames.has(chunk.name)) return;
				this.daemonToolArgs.set(chunk.id, "");
				{
					const acpId = this.acpToolCallId(chunk.id);
					this.turn?.openDaemonToolCalls.add(acpId);
					await this.send({
						sessionUpdate: "tool_call",
						toolCallId: acpId,
						title: chunk.name,
						kind: toolNameToKind(chunk.name),
						status: "pending",
					});
				}
				break;
			case "tool_use_args": {
				const prev = this.daemonToolArgs.get(chunk.id);
				if (prev !== undefined) {
					this.daemonToolArgs.set(chunk.id, prev + chunk.partial_json);
				}
				break;
			}
			case "tool_use_end": {
				if (!this.daemonToolArgs.has(chunk.id)) return;
				const rawInput = this.parseDaemonArgs(chunk.id);
				this.daemonToolArgs.delete(chunk.id);
				await this.send({
					sessionUpdate: "tool_call_update",
					toolCallId: this.acpToolCallId(chunk.id),
					status: "in_progress",
					...(rawInput !== undefined ? { rawInput } : {}),
				});
				break;
			}
			case "error":
				this.deps.logger.error("acp_stream_error", {
					sessionId: this.deps.sessionId,
					error: chunk.error,
				});
				// Surface the error to the editor as assistant text; the turn still
				// resolves end_turn on the subsequent idle status so the client does
				// not see a raw JSON-RPC error frame.
				await this.send({
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: `\n\n[error] ${chunk.error}` },
				});
				break;
			default:
				// "done" is a per-inference marker, not the turn boundary; ignore.
				break;
		}
	}

	/**
	 * Resolves the pending prompt when the daemon reports the thread idle.
	 * `active:true` ("thinking") must be seen first so a stale idle status from
	 * before the turn started cannot resolve it prematurely.
	 */
	handleThreadStatus(active: boolean): void {
		const turn = this.turn;
		if (!turn || turn.resolved) return;
		if (active) {
			turn.seenActive = true;
			return;
		}
		if (!turn.seenActive) return;
		if (turn.cancelled) {
			this.resolveTurn("cancelled");
			return;
		}
		// A turn-fatal alert (inference timeout, non-retryable LLM error) arrives
		// via `emitAlert` — NOT the response stream — and the daemon still reports
		// the thread idle afterward. If the turn produced no assistant text, treat
		// the alert as fatal and reject the prompt with a JSON-RPC error so the
		// editor surfaces a real failure instead of a silent empty turn. An alert
		// followed by assistant text (e.g. a model-fallback notice) is informational
		// and resolves normally.
		if (turn.alert && !turn.sawAgentText) {
			this.rejectTurn(RequestError.internalError(undefined, turn.alert));
			return;
		}
		// A client tool (boundless_*) runs on the boundless host, so the daemon
		// EXITS its loop to await the result and reports the thread idle in the
		// meantime (it dispatches the call, then transitions to IDLE →
		// `thread:status active:false`). That idle is NOT turn completion: the
		// loop resumes — going active again — once `handleToolCall` hands the
		// result back. Resolving here would end the prompt mid-turn and strand
		// the tool result, forcing the user to re-prompt to continue. Wait for
		// the genuine idle that follows the resumed turn instead.
		if (this.pendingClientToolCalls.size > 0) return;
		this.resolveTurn("end_turn");
	}

	/**
	 * Records a daemon alert (`role: "alert"` broadcast message) for the active
	 * turn and surfaces it to the editor as assistant text. Whether it is treated
	 * as turn-fatal is decided at idle (see `handleThreadStatus`): an alert with
	 * no subsequent assistant text rejects the prompt; otherwise it is shown as an
	 * informational notice and the turn completes normally.
	 */
	handleAlert(content: string): void {
		if (this.turn && !this.turn.resolved) {
			this.turn.alert = content;
		}
		void this.send({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: `\n\n${content}` },
		});
	}

	/**
	 * Executes a client-side tool call dispatched by the daemon, gated behind an
	 * ACP permission request. Surfaces the tool_call lifecycle as notifications
	 * and returns the result for the daemon to feed back to the model.
	 */
	async handleToolCall(call: ToolCallRequest): Promise<ToolCallResult> {
		// Mark this client tool call outstanding for the current turn from the
		// moment of dispatch — crucially BEFORE the permission round-trip, because
		// the daemon emits `thread:status` idle the instant it suspends the loop
		// to await this result, and that frame races ahead of (and outlives) the
		// permission prompt. `handleThreadStatus` consults this set so the idle is
		// not mistaken for turn completion. Cleared once the result is returned to
		// the daemon, which then resumes the loop.
		this.pendingClientToolCalls.add(call.call_id);
		try {
			return await this.dispatchToolCall(call);
		} finally {
			this.pendingClientToolCalls.delete(call.call_id);
		}
	}

	private async dispatchToolCall(call: ToolCallRequest): Promise<ToolCallResult> {
		const { call_id: callId, tool_name: toolName, arguments: args } = call;
		// Zed-facing id: session-unique even when the model reuses a per-request id
		// across turns (Responses API call_1). The daemon-facing call_id below
		// stays raw so the daemon pairs the result to its dispatch.
		const acpId = this.acpToolCallId(callId);
		const kind = toolNameToKind(toolName);
		const title = toolCallTitle(toolName, args);
		const content = toolCallContent(toolName, args, this.deps.cwd, acpId);
		const locations = toolCallLocations(toolName, args, this.deps.cwd);
		const meta = toolCallMeta(toolName, this.deps.cwd, acpId, args);

		await this.send({
			sessionUpdate: "tool_call",
			toolCallId: acpId,
			...(meta ? { _meta: meta } : {}),
			title,
			kind,
			status: "pending",
			rawInput: args,
			...(locations.length > 0 ? { locations } : {}),
			...(content.length > 0 ? { content } : {}),
		});

		const decision = await this.resolvePermission(
			acpId,
			toolName,
			title,
			kind,
			args,
			content,
			locations,
			meta,
		);
		if (decision === "reject") {
			await this.send({
				sessionUpdate: "tool_call_update",
				toolCallId: acpId,
				status: "failed",
				content: [
					{ type: "content", content: { type: "text", text: "Tool call rejected by user" } },
				],
			});
			return {
				call_id: callId,
				thread_id: call.thread_id,
				content: [{ type: "text", text: "Tool call rejected by user" }],
				is_error: true,
			};
		}

		const handler = this.deps.toolHandlers.get(toolName);
		if (!handler) {
			await this.updateToolCall(acpId, "failed", `Error: Tool '${toolName}' not found`);
			return {
				call_id: callId,
				thread_id: call.thread_id,
				content: [{ type: "text", text: `Error: Tool '${toolName}' not found` }],
				is_error: true,
			};
		}

		await this.send({
			sessionUpdate: "tool_call_update",
			toolCallId: acpId,
			status: "in_progress",
		});

		const controller = new AbortController();
		this.inFlightTools.add(controller);
		try {
			const result = await handler(args, controller.signal, this.deps.cwd);
			const status: ToolCallStatus = result.isError ? "failed" : "completed";
			const shellOutput = isShellToolName(toolName)
				? shellTerminalOutput(toolName, acpId, result.content)
				: null;
			// A diff sent in the pending frame is the editor's rendered
			// representation of the change. ACP tool_call_update content
			// *replaces* the collection, so sending the tool's text result on a
			// successful completion would clobber the diff (and edits finish in
			// milliseconds, so the diff never stays on screen). On success, omit
			// content entirely — delta semantics leave the diff in place. On
			// failure, the edit did not apply, so surface the error text instead.
			// Matches the reference ACP shim (Edit/Write return `{}` on completion).
			const preservesDiff = !result.isError && content.some((c) => c.type === "diff");
			await this.send({
				sessionUpdate: "tool_call_update",
				toolCallId: acpId,
				status,
				...(shellOutput
					? { _meta: shellOutput.meta, rawOutput: shellOutput.rawOutput }
					: preservesDiff
						? {}
						: { content: toolResultToAcpContent(result.content) }),
			});
			return {
				call_id: callId,
				thread_id: call.thread_id,
				content: result.content,
				is_error: result.isError,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.updateToolCall(acpId, "failed", `Error: ${message}`);
			return {
				call_id: callId,
				thread_id: call.thread_id,
				content: [{ type: "text", text: `Error: ${message}` }],
				is_error: true,
			};
		} finally {
			this.inFlightTools.delete(controller);
		}
	}

	// ---- internals ----

	/**
	 * Resolves the permission decision for a tool call: a remembered decision
	 * short-circuits the prompt; otherwise the user is asked. `*_always`
	 * outcomes are remembered per tool name for the session lifetime.
	 */
	private async resolvePermission(
		callId: string,
		toolName: string,
		title: string,
		kind: ReturnType<typeof toolNameToKind>,
		args: Record<string, unknown>,
		content: ReturnType<typeof toolCallContent>,
		locations: ReturnType<typeof toolCallLocations>,
		meta: ReturnType<typeof toolCallMeta>,
	): Promise<PermissionDecision> {
		// A non-default mode can auto-approve before we consult remembered
		// decisions or prompt the editor. `default` always returns null here, so
		// the ask flow below is byte-identical to pre-mode behavior.
		const modeDecision = modePermissionDecision(this.mode, kind);
		if (modeDecision) return modeDecision;

		const remembered = this.permissionMemory.get(toolName);
		if (remembered) return remembered;

		let response: Awaited<ReturnType<typeof this.deps.conn.requestPermission>>;
		try {
			response = await this.deps.conn.requestPermission({
				sessionId: this.deps.sessionId,
				toolCall: {
					toolCallId: callId,
					...(meta ? { _meta: meta } : {}),
					title,
					kind,
					status: "pending",
					rawInput: args,
					...(locations.length > 0 ? { locations } : {}),
					...(content.length > 0 ? { content } : {}),
				},
				options: PERMISSION_OPTIONS,
			});
		} catch (error) {
			// A failed permission round-trip (e.g. connection closing) is treated
			// as a rejection rather than silently executing the tool.
			this.deps.logger.error("acp_request_permission_failed", {
				sessionId: this.deps.sessionId,
				toolName,
				error: error instanceof Error ? error.message : String(error),
			});
			return "reject";
		}

		if (response.outcome.outcome === "cancelled") {
			if (this.turn) this.turn.cancelled = true;
			return "reject";
		}
		return this.decisionFromOptionId(toolName, response.outcome.optionId);
	}

	/** Maps a selected permission optionId to a decision, remembering `*_always`. */
	private decisionFromOptionId(toolName: string, optionId: PermissionOptionId): PermissionDecision {
		switch (optionId) {
			case "allow_always":
				this.permissionMemory.set(toolName, "allow");
				return "allow";
			case "reject_always":
				this.permissionMemory.set(toolName, "reject");
				return "reject";
			case "allow_once":
				return "allow";
			case "reject_once":
				return "reject";
			default:
				// Unknown option id — fail closed.
				return "reject";
		}
	}

	/**
	 * Mints (or returns the already-minted) session-unique ACP toolCallId for a
	 * model-supplied tool-call id, scoped to the current turn.
	 *
	 * The Responses API (bedrock-mantle / GPT-5.x) numbers tool calls per request
	 * (`call_1`, `call_2`, …) and resets the counter every turn, so the raw id
	 * collides across turns within one ACP session. The editor keys tool calls by
	 * `toolCallId` for the session lifetime, so an un-namespaced `call_1` in turn
	 * N reads as an update to turn N-1's completed `call_1` — the new call never
	 * renders, and (for shell tools) its terminal id collides too. Anthropic ids
	 * (`toolu_<random>`) are globally unique and never collided, which is why this
	 * only surfaced on GPT-5.x.
	 *
	 * The per-turn map keeps every lifecycle update for one call (pending →
	 * in_progress → completed) sharing an id, while the session-monotonic suffix
	 * makes the same raw id distinct across turns. The daemon-facing `call_id`
	 * stays raw — this remap is Zed-facing only. Outside a turn (no collision
	 * surface) the raw id passes through unchanged.
	 */
	private acpToolCallId(rawId: string): string {
		const turn = this.turn;
		if (!turn) return rawId;
		const existing = turn.acpToolCallIds.get(rawId);
		if (existing) return existing;
		const acpId = `${rawId}-t${this.toolCallIdSeq++}`;
		turn.acpToolCallIds.set(rawId, acpId);
		return acpId;
	}

	private parseDaemonArgs(id: string): Record<string, unknown> | undefined {
		const raw = this.daemonToolArgs.get(id);
		if (!raw) return undefined;
		try {
			const parsed = JSON.parse(raw) as unknown;
			return typeof parsed === "object" && parsed !== null
				? (parsed as Record<string, unknown>)
				: undefined;
		} catch {
			return undefined;
		}
	}

	private async updateToolCall(
		toolCallId: string,
		status: ToolCallStatus,
		text: string,
	): Promise<void> {
		await this.send({
			sessionUpdate: "tool_call_update",
			toolCallId,
			status,
			content: [{ type: "content", content: { type: "text", text } }],
		});
	}

	private resolveTurn(stopReason: PromptResponse["stopReason"]): void {
		const turn = this.turn;
		if (!turn || turn.resolved) return;
		turn.resolved = true;
		// Close any daemon-side tool calls left open at turn end (no per-tool
		// completion signal arrives over the stream for native tools).
		for (const id of turn.openDaemonToolCalls) {
			void this.send({
				sessionUpdate: "tool_call_update",
				toolCallId: id,
				status: "completed",
			});
		}
		this.turn = null;
		turn.resolve({ stopReason });
	}

	/**
	 * Fails the pending prompt with a JSON-RPC error. Used when a turn-fatal
	 * alert (inference timeout, non-retryable LLM error) ends the turn without a
	 * response, so the editor surfaces a real failure rather than a silent
	 * `end_turn`. Mirrors `resolveTurn`'s open-tool-call cleanup.
	 */
	private rejectTurn(err: unknown): void {
		const turn = this.turn;
		if (!turn || turn.resolved) return;
		turn.resolved = true;
		for (const id of turn.openDaemonToolCalls) {
			void this.send({
				sessionUpdate: "tool_call_update",
				toolCallId: id,
				status: "failed",
			});
		}
		this.turn = null;
		turn.reject(err);
	}

	/**
	 * Attaches the ACP message id to a streamed chunk and maintains the per-run
	 * message boundary. A contiguous run of agent_message_chunk shares one id; a
	 * run of agent_thought_chunk shares another; a tool_call (or a switch between
	 * text and thought) ends the open run so the next chunk starts a fresh
	 * message. Required on streamed chunks in ACP v2 and forward-compatible in v1
	 * (the field is optional there). No-op when no turn is active (e.g. replay,
	 * which stamps the persisted row id directly in messageToSessionUpdate).
	 */
	private stampMessageId(
		update: Parameters<AgentSideConnection["sessionUpdate"]>[0]["update"],
	): void {
		const turn = this.turn;
		if (!turn) return;
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				turn.thoughtMessageId = null;
				turn.agentMessageId ??= randomUUID();
				update.messageId = turn.agentMessageId;
				break;
			case "agent_thought_chunk":
				turn.agentMessageId = null;
				turn.thoughtMessageId ??= randomUUID();
				update.messageId = turn.thoughtMessageId;
				break;
			case "tool_call":
				// A tool call breaks any open text / thought run; the next chunk of
				// either kind starts a new message.
				turn.agentMessageId = null;
				turn.thoughtMessageId = null;
				break;
		}
	}

	private async send(
		update: Parameters<AgentSideConnection["sessionUpdate"]>[0]["update"],
	): Promise<void> {
		this.stampMessageId(update);
		try {
			await this.deps.conn.sessionUpdate({ sessionId: this.deps.sessionId, update });
		} catch (error) {
			this.deps.logger.error("acp_session_update_failed", {
				sessionId: this.deps.sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

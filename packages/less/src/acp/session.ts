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

import {
	type AgentSideConnection,
	type PermissionOptionId,
	type PromptResponse,
	RequestError,
	type ToolCallStatus,
} from "@agentclientprotocol/sdk";
import type { BoundClient, ToolCallRequest, ToolCallResult } from "@bound/client";
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
	/** Daemon-side (native) tool calls surfaced this turn, keyed by tool_use id. */
	openDaemonToolCalls: Set<string>;
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
	private modelId: string | null;
	private mode: SessionModeId = DEFAULT_MODE_ID;
	private readonly permissionMemory = new Map<string, PermissionDecision>();
	/** Accumulated argument JSON for in-flight daemon-side tool_use streams. */
	private readonly daemonToolArgs = new Map<string, string>();
	/** AbortControllers for in-flight client tool executions (for cancel). */
	private readonly inFlightTools = new Set<AbortController>();

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
	runPrompt(text: string): Promise<PromptResponse> {
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
			};
			this.deps.client.sendMessage(this.deps.sessionId, text, {
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
				this.turn?.openDaemonToolCalls.add(chunk.id);
				await this.send({
					sessionUpdate: "tool_call",
					toolCallId: chunk.id,
					title: chunk.name,
					kind: toolNameToKind(chunk.name),
					status: "pending",
				});
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
					toolCallId: chunk.id,
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
		const { call_id: callId, tool_name: toolName, arguments: args } = call;
		const kind = toolNameToKind(toolName);
		const title = toolCallTitle(toolName, args);
		const content = toolCallContent(toolName, args, this.deps.cwd, callId);
		const locations = toolCallLocations(toolName, args, this.deps.cwd);
		const meta = toolCallMeta(toolName, this.deps.cwd, callId, args);

		await this.send({
			sessionUpdate: "tool_call",
			toolCallId: callId,
			...(meta ? { _meta: meta } : {}),
			title,
			kind,
			status: "pending",
			rawInput: args,
			...(locations.length > 0 ? { locations } : {}),
			...(content.length > 0 ? { content } : {}),
		});

		const decision = await this.resolvePermission(
			callId,
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
				toolCallId: callId,
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
			await this.updateToolCall(callId, "failed", `Error: Tool '${toolName}' not found`);
			return {
				call_id: callId,
				thread_id: call.thread_id,
				content: [{ type: "text", text: `Error: Tool '${toolName}' not found` }],
				is_error: true,
			};
		}

		await this.send({
			sessionUpdate: "tool_call_update",
			toolCallId: callId,
			status: "in_progress",
		});

		const controller = new AbortController();
		this.inFlightTools.add(controller);
		try {
			const result = await handler(args, controller.signal, this.deps.cwd);
			const status: ToolCallStatus = result.isError ? "failed" : "completed";
			const shellOutput = isShellToolName(toolName)
				? shellTerminalOutput(toolName, callId, result.content)
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
				toolCallId: callId,
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
			await this.updateToolCall(callId, "failed", `Error: ${message}`);
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

	private async send(
		update: Parameters<AgentSideConnection["sessionUpdate"]>[0]["update"],
	): Promise<void> {
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

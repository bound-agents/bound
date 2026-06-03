/**
 * ACP agent server for boundless (`boundless --acp`).
 *
 * Runs boundless as an Agent Client Protocol *agent* over stdio: an editor
 * (Zed, etc.) spawns `boundless --acp` as a subprocess and drives bound as its
 * backend agent. The bound daemon (reached over the shared {@link BoundClient}
 * WebSocket) provides inference, memory, and model routing; the existing
 * boundless file/shell/MCP tools execute locally on the editor's host, which is
 * exactly where ACP expects tool side effects to land.
 *
 * stdout is the JSON-RPC channel — the caller MUST ensure nothing else writes
 * to stdout once this server is running. All diagnostics go through the file
 * {@link AppLogger}.
 */

import { Readable, Writable } from "node:stream";
import {
	type Agent,
	AgentSideConnection,
	type AuthenticateResponse,
	type CancelNotification,
	type CloseSessionRequest,
	type CloseSessionResponse,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type NewSessionRequest,
	type NewSessionResponse,
	PROTOCOL_VERSION,
	type PromptRequest,
	type PromptResponse,
	RequestError,
	type SessionConfigOption,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	ndJsonStream,
} from "@agentclientprotocol/sdk";
import { BoundClient } from "@bound/client";
import { getBuildInfo } from "@bound/shared";
import type { McpServerConfig } from "../config";
import { acquireLock, releaseLock } from "../lockfile";
import type { AppLogger } from "../logging";
import { McpServerManager } from "../mcp/manager";
import { performAttach } from "../session/attach";
import { buildToolSet } from "../tools/registry";
import type { ResolvedShell } from "../tools/shell";
import { messageToSessionUpdate, promptToText } from "./mapping";
import { AcpSession } from "./session";
import { listRememberedAcpSessions, rememberAcpSession } from "./session-registry";

export interface BoundAcpAgentOptions {
	client: BoundClient;
	conn: AgentSideConnection;
	mcpManager: McpServerManager;
	mcpConfigs: McpServerConfig[];
	configDir: string;
	hostname: string;
	shell: ResolvedShell;
	logger: AppLogger;
	/** Model alias to send with prompts, or null for the cluster default. */
	modelId: string | null;
	/** Context files to inject into the per-session system prompt. */
	contextFiles?: string[];
	/** Thread IDs this server has acquired locks for (released on close). */
	lockedThreads?: Set<string>;
}

/** Internal per-session bookkeeping held by the agent. */
interface SessionEntry {
	session: AcpSession;
	clientToolNames: Set<string>;
	modelId: string | null;
}

const MODEL_CONFIG_ID = "model";

/**
 * Implements the ACP {@link Agent} interface, bridging to a bound daemon. One
 * instance owns the shared {@link BoundClient} and a map of live sessions, and
 * routes WebSocket events to the right session by thread id.
 */
export class BoundAcpAgent implements Agent {
	private readonly opts: BoundAcpAgentOptions;
	private readonly sessions = new Map<string, SessionEntry>();
	private readonly lockedThreads: Set<string>;
	private routingInstalled = false;

	constructor(opts: BoundAcpAgentOptions) {
		this.opts = opts;
		this.lockedThreads = opts.lockedThreads ?? new Set();
		this.installEventRouting();
	}

	async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
		const { commitHash } = getBuildInfo();
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentInfo: { name: "boundless", version: commitHash },
			agentCapabilities: {
				loadSession: true,
				sessionCapabilities: {
					close: {},
					list: {},
				},
				promptCapabilities: {
					image: false,
					audio: false,
					embeddedContext: true,
				},
			},
			authMethods: [],
		};
	}

	async authenticate(_params: unknown): Promise<AuthenticateResponse> {
		// boundless trusts the local bound daemon; no auth methods are advertised.
		return {};
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		const thread = await this.opts.client.createThread({ interface: "boundless" });
		const threadId = thread.id;
		const entry = await this.attachAndRegister(threadId, params.cwd);
		return {
			sessionId: threadId,
			configOptions: await this.modelConfigOptions(entry.modelId),
		};
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		const threadId = params.sessionId;
		// Validate the thread exists before attaching; a missing thread is a
		// client error, surfaced as a JSON-RPC resource-not-found.
		try {
			await this.opts.client.getThread(threadId);
		} catch (error) {
			this.opts.logger.warn("acp_load_session_unknown_thread", {
				threadId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw RequestError.resourceNotFound(threadId);
		}
		const entry = await this.attachAndRegister(threadId, params.cwd);
		// Replay history so the editor can render the prior conversation.
		const messages = await this.opts.client.listMessages(threadId, { limit: 200 });
		for (const message of messages) {
			const update = messageToSessionUpdate(message);
			if (update) {
				await this.opts.conn.sessionUpdate({ sessionId: threadId, update });
			}
		}
		return { configOptions: await this.modelConfigOptions(entry.modelId) };
	}

	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		const remembered = listRememberedAcpSessions(this.opts.configDir);
		const rememberedById = new Map(
			remembered
				.filter((record) => !params.cwd || record.cwd === params.cwd)
				.map((record) => [record.sessionId, record]),
		);
		if (rememberedById.size === 0) return { sessions: [] };

		const threads = await this.opts.client.listThreads({ includeEmpty: true });
		const sessions = threads
			.filter((thread) => rememberedById.has(thread.id))
			.map((thread) => {
				const record = rememberedById.get(thread.id);
				if (!record) throw new Error("missing remembered ACP session");
				return {
					sessionId: thread.id,
					cwd: record.cwd,
					title: thread.title,
					updatedAt: thread.last_message_at ?? thread.modified_at ?? record.updatedAt,
				};
			});

		const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0;
		const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
		const pageSize = 100;
		const page = sessions.slice(start, start + pageSize);
		const nextOffset = start + pageSize;
		return {
			sessions: page,
			...(nextOffset < sessions.length ? { nextCursor: String(nextOffset) } : {}),
		};
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const entry = this.sessions.get(params.sessionId);
		if (!entry) {
			throw RequestError.invalidParams(undefined, `Unknown session: ${params.sessionId}`);
		}
		const text = promptToText(params.prompt);
		return entry.session.runPrompt(text);
	}

	async cancel(params: CancelNotification): Promise<void> {
		const entry = this.sessions.get(params.sessionId);
		if (entry) {
			await entry.session.cancel();
		}
	}

	async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
		await this.closeAndReleaseSession(params.sessionId);
		return {};
	}

	async setSessionConfigOption(
		params: SetSessionConfigOptionRequest,
	): Promise<SetSessionConfigOptionResponse> {
		const entry = this.sessions.get(params.sessionId);
		if (!entry) {
			throw RequestError.invalidParams(undefined, `Unknown session: ${params.sessionId}`);
		}
		if (params.configId !== MODEL_CONFIG_ID || typeof params.value !== "string") {
			throw RequestError.invalidParams(undefined, `Unknown config option: ${params.configId}`);
		}

		const models = await this.opts.client.listModels();
		const allowed = new Set(models.models.map((model) => model.id));
		if (!allowed.has(params.value)) {
			throw RequestError.invalidParams(undefined, `Unknown model: ${params.value}`);
		}

		entry.modelId = params.value;
		entry.session.setModelId(params.value);
		return { configOptions: this.modelConfigOptionsFromResponse(models, entry.modelId) };
	}

	/** Releases all session resources. Called on connection close. */
	async dispose(): Promise<void> {
		for (const threadId of this.lockedThreads) {
			releaseLock(this.opts.configDir, threadId);
		}
		this.lockedThreads.clear();
		await this.opts.mcpManager.terminateAll();
		this.opts.client.disconnect();
	}

	// ---- internals ----

	/**
	 * Brings up MCP servers for the session cwd, builds the boundless tool set,
	 * configures it on the shared client, acquires the per-thread lock, and
	 * registers the AcpSession. Shared by newSession and loadSession.
	 */
	private async attachAndRegister(threadId: string, cwd: string): Promise<SessionEntry> {
		this.opts.client.subscribe(threadId);
		await performAttach({
			client: this.opts.client,
			threadId,
			mcpManager: this.opts.mcpManager,
			mcpConfigs: this.opts.mcpConfigs,
			cwd,
			hostname: this.opts.hostname,
			logger: this.opts.logger,
			injectContextFiles: this.opts.contextFiles,
			shell: this.opts.shell,
		});

		// Rebuild the tool set/handlers against THIS session's cwd. performAttach
		// configures tools on the wire; we additionally need the local handler
		// map and the client-tool name set for permission gating + execution.
		const mcpTools = this.opts.mcpManager.getRunningTools();
		const toolSet = buildToolSet(
			cwd,
			this.opts.hostname,
			mcpTools,
			undefined,
			this.opts.client.getBaseUrl(),
			this.opts.shell,
		);
		const clientToolNames = new Set(toolSet.tools.map((t) => t.function.name));

		try {
			acquireLock(this.opts.configDir, threadId, cwd);
			this.lockedThreads.add(threadId);
		} catch (error) {
			// A lock conflict is non-fatal: the session still works, but we log it
			// so concurrent attaches from the same cwd are diagnosable.
			this.opts.logger.warn("acp_lock_conflict", {
				threadId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		rememberAcpSession(this.opts.configDir, threadId, cwd);

		const session = new AcpSession({
			sessionId: threadId,
			cwd,
			hostname: this.opts.hostname,
			shell: this.opts.shell,
			conn: this.opts.conn,
			client: this.opts.client,
			toolHandlers: toolSet.handlers,
			clientToolNames,
			modelId: this.opts.modelId,
			logger: this.opts.logger,
		});
		const entry: SessionEntry = { session, clientToolNames, modelId: this.opts.modelId };
		this.sessions.set(threadId, entry);
		return entry;
	}

	private async modelConfigOptions(currentModelId: string | null): Promise<SessionConfigOption[]> {
		try {
			return this.modelConfigOptionsFromResponse(
				await this.opts.client.listModels(),
				currentModelId,
			);
		} catch (error) {
			this.opts.logger.warn("acp_list_models_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	}

	private modelConfigOptionsFromResponse(
		models: Awaited<ReturnType<BoundClient["listModels"]>>,
		currentModelId: string | null,
	): SessionConfigOption[] {
		if (models.models.length === 0) return [];
		const currentValue =
			currentModelId && models.models.some((model) => model.id === currentModelId)
				? currentModelId
				: models.default;
		return [
			{
				id: MODEL_CONFIG_ID,
				name: "Model",
				description: "Model to use for new turns in this session.",
				category: "model",
				type: "select",
				currentValue,
				options: models.models.map((model) => ({
					value: model.id,
					name: model.id,
					description: `${model.provider} via ${model.host}`,
				})),
			},
		];
	}

	private async closeAndReleaseSession(threadId: string): Promise<void> {
		const entry = this.sessions.get(threadId);
		if (entry) {
			await entry.session.close();
			this.sessions.delete(threadId);
		}
		if (this.lockedThreads.delete(threadId)) {
			releaseLock(this.opts.configDir, threadId);
		}
		this.opts.client.unsubscribe(threadId);
	}

	/**
	 * Wires the shared client's events to the right session by thread id. The
	 * client tool handler is registered once and dispatches to the owning
	 * session; unknown threads are ignored (no active session).
	 */
	private installEventRouting(): void {
		if (this.routingInstalled) return;
		this.routingInstalled = true;

		this.opts.client.on("stream:chunk", (data) => {
			const entry = this.sessions.get(data.thread_id);
			if (entry) void entry.session.handleStreamChunk(data.chunk);
		});

		this.opts.client.on("thread:status", (data) => {
			const entry = this.sessions.get(data.thread_id);
			if (entry) entry.session.handleThreadStatus(data.active);
		});

		this.opts.client.onToolCall(async (call) => {
			const entry = this.sessions.get(call.thread_id);
			if (!entry) {
				return {
					call_id: call.call_id,
					thread_id: call.thread_id,
					content: [{ type: "text", text: "No active ACP session for this thread" }],
					is_error: true,
				};
			}
			return entry.session.handleToolCall(call);
		});
	}
}

export interface RunAcpServerOptions {
	url: string;
	configDir: string;
	mcpConfigs: McpServerConfig[];
	hostname: string;
	shell: ResolvedShell;
	logger: AppLogger;
	modelId: string | null;
	contextFiles?: string[];
}

/**
 * Entry point for `boundless --acp`. Connects the shared BoundClient, wires
 * stdio into an AgentSideConnection, and resolves once the connection closes.
 *
 * stdout is the JSON-RPC channel: this function must run before any other code
 * writes to stdout, and the caller must not render a TUI in this mode.
 */
export async function runAcpServer(opts: RunAcpServerOptions): Promise<void> {
	const client = new BoundClient(opts.url);
	client.connect();

	const mcpManager = new McpServerManager(opts.logger);

	// Node stdio → Web Streams → ndJSON ACP stream. Per the SDK, ndJsonStream
	// takes (output, input): writable stdout first, readable stdin second.
	const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
	const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
	const stream = ndJsonStream(output, input);

	let agent: BoundAcpAgent | undefined;
	const connection = new AgentSideConnection((conn): BoundAcpAgent => {
		agent = new BoundAcpAgent({
			client,
			conn,
			mcpManager,
			mcpConfigs: opts.mcpConfigs,
			configDir: opts.configDir,
			hostname: opts.hostname,
			shell: opts.shell,
			logger: opts.logger,
			modelId: opts.modelId,
			contextFiles: opts.contextFiles,
		});
		return agent;
	}, stream);

	opts.logger.info("acp_server_started", { url: opts.url });
	await connection.closed;
	opts.logger.info("acp_server_closed", {});
	if (agent) {
		await agent.dispose();
	}
}

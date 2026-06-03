/**
 * In-memory ACP test harness.
 *
 * Wires a real SDK {@link ClientSideConnection} to a {@link BoundAcpAgent} over
 * a crossed pair of byte streams (no stdio, no subprocess), so tests exercise
 * the real JSON-RPC framing and serialization rather than a stub. The bound
 * daemon is replaced by a {@link MockBoundClient} whose `emit*` helpers inject
 * the WebSocket events the agent routes (stream chunks, thread status, tool
 * calls), and whose method calls are recorded for assertions.
 *
 * Topology (two byte pipes):
 *   agent → client : `a2c`   client → agent : `c2a`
 *   AgentSideConnection  reads c2a, writes a2c
 *   ClientSideConnection reads a2c, writes c2a
 * The ClientSideConnection implements the `Agent` interface, so calling
 * `initialize` / `newSession` / `prompt` on it sends those requests across the
 * wire to the BoundAcpAgent and returns its responses.
 */

import {
	type Agent,
	AgentSideConnection,
	type Client,
	ClientSideConnection,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
	ndJsonStream,
} from "@agentclientprotocol/sdk";
import type { BoundClient, ToolCallRequest, ToolCallResult } from "@bound/client";
import type { Message, Thread, WsStreamChunk } from "@bound/shared";
import { BoundAcpAgent, type BoundAcpAgentOptions } from "../server";

/** A no-op AppLogger stand-in (the real one writes to files). */
export function fakeLogger(): BoundAcpAgentOptions["logger"] {
	return {
		info: () => {},
		warn: () => {},
		error: () => {},
		close: () => {},
	} as unknown as BoundAcpAgentOptions["logger"];
}

export interface MockBoundClient {
	client: BoundClient;
	calls: {
		createThread: number;
		subscribe: string[];
		unsubscribe: string[];
		sendMessage: Array<{ threadId: string; content: string }>;
		configureTools: number;
		cancelThread: string[];
	};
	/** Drive a stream chunk to the agent's routing. */
	emitStreamChunk(threadId: string, chunk: WsStreamChunk): void;
	/** Drive a thread:status event. */
	emitThreadStatus(threadId: string, active: boolean): void;
	/** Invoke the registered tool-call handler and return its result. */
	invokeToolCall(call: ToolCallRequest): Promise<ToolCallResult>;
	/** Set the messages returned by listMessages (for load replay). */
	setMessages(messages: Message[]): void;
}

/** Builds a mock BoundClient capturing calls and exposing event injectors. */
export function mockBoundClient(): MockBoundClient {
	const listeners = new Map<string, (data: unknown) => void>();
	let toolCallHandler: ((call: ToolCallRequest) => Promise<ToolCallResult>) | null = null;
	let messages: Message[] = [];

	const calls: MockBoundClient["calls"] = {
		createThread: 0,
		subscribe: [],
		unsubscribe: [],
		sendMessage: [],
		configureTools: 0,
		cancelThread: [],
	};

	const client = {
		connect: () => {},
		disconnect: () => {},
		getBaseUrl: () => "http://localhost:3001",
		createThread: async (): Promise<Thread> => {
			calls.createThread += 1;
			return makeThread(`thread-${calls.createThread}`);
		},
		getThread: async (id: string): Promise<Thread> => makeThread(id),
		listMessages: async (): Promise<Message[]> => messages,
		subscribe: (id: string) => {
			calls.subscribe.push(id);
		},
		unsubscribe: (id: string) => {
			calls.unsubscribe.push(id);
		},
		configureTools: () => {
			calls.configureTools += 1;
		},
		sendMessage: (threadId: string, content: string) => {
			calls.sendMessage.push({ threadId, content });
		},
		cancelThread: async (threadId: string) => {
			calls.cancelThread.push(threadId);
			return { cancelled: true as const, thread_id: threadId };
		},
		on: (event: string, handler: (data: unknown) => void) => {
			listeners.set(event, handler);
		},
		off: () => {},
		onToolCall: (handler: (call: ToolCallRequest) => Promise<ToolCallResult>) => {
			toolCallHandler = handler;
		},
	} as unknown as BoundClient;

	return {
		client,
		calls,
		emitStreamChunk(threadId, chunk) {
			listeners.get("stream:chunk")?.({ thread_id: threadId, chunk });
		},
		emitThreadStatus(threadId, active) {
			listeners.get("thread:status")?.({
				thread_id: threadId,
				active,
				state: active ? "thinking" : "idle",
				tokens: 0,
				model: null,
			});
		},
		async invokeToolCall(call) {
			if (!toolCallHandler) throw new Error("no tool call handler registered");
			return toolCallHandler(call);
		},
		setMessages(next) {
			messages = next;
		},
	};
}

function makeThread(id: string): Thread {
	return {
		id,
		user_id: "u",
		interface: "boundless",
		host_origin: "",
		color: 0,
		title: null,
		summary: null,
		summary_through: null,
		summary_model_id: null,
		extracted_through: null,
		created_at: new Date(0).toISOString(),
		last_message_at: new Date(0).toISOString(),
		modified_at: new Date(0).toISOString(),
		deleted: 0,
		model_hint: null,
	} as Thread;
}

/** Records every session/update the agent pushes, and scripts permission answers. */
export interface RecordingClient {
	notifications: SessionNotification[];
	/** Resolve each permission request to this option id (FIFO queue, then default). */
	permissionQueue: string[];
	defaultPermission: string;
	permissionRequests: RequestPermissionRequest[];
}

export interface AcpHarness {
	/** Client-side proxy implementing Agent — call initialize/newSession/prompt here. */
	agentProxy: Agent;
	recording: RecordingClient;
}

/**
 * Spins up the full in-memory stack: a real ClientSideConnection driving a real
 * BoundAcpAgent (over AgentSideConnection) through crossed ndJSON byte streams,
 * backed by the given mock BoundClient. The agent's MCP manager and shell are
 * stubbed so no network or process work happens.
 */
export function makeAcpHarness(
	mock: MockBoundClient,
	overrides?: Partial<BoundAcpAgentOptions>,
): AcpHarness {
	const a2c = new TransformStream<Uint8Array, Uint8Array>();
	const c2a = new TransformStream<Uint8Array, Uint8Array>();

	const agentStream = ndJsonStream(a2c.writable, c2a.readable);
	const clientStream = ndJsonStream(c2a.writable, a2c.readable);

	const recording: RecordingClient = {
		notifications: [],
		permissionQueue: [],
		defaultPermission: "allow_once",
		permissionRequests: [],
	};

	const recordingClient: Client = {
		async sessionUpdate(params: SessionNotification): Promise<void> {
			recording.notifications.push(params);
		},
		async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
			recording.permissionRequests.push(params);
			const optionId = recording.permissionQueue.shift() ?? recording.defaultPermission;
			return { outcome: { outcome: "selected", optionId } };
		},
	};

	// Agent side: BoundAcpAgent under test.
	new AgentSideConnection(
		(conn): Agent =>
			new BoundAcpAgent({
				client: mock.client,
				conn,
				mcpManager: fakeMcpManager(),
				mcpConfigs: [],
				configDir: "/tmp/acp-test-config",
				hostname: "testhost",
				shell: fakeShell(),
				logger: fakeLogger(),
				modelId: null,
				...overrides,
			}),
		agentStream,
	);

	// Client side: a ClientSideConnection implements Agent and proxies calls
	// across the wire to the BoundAcpAgent.
	const agentProxy = new ClientSideConnection(() => recordingClient, clientStream);

	return { agentProxy, recording };
}

function fakeShell(): BoundAcpAgentOptions["shell"] {
	return {
		toolName: "boundless_bash",
		label: "bash",
		command: "/bin/sh",
		args: ["-c"],
	} as unknown as BoundAcpAgentOptions["shell"];
}

function fakeMcpManager(): BoundAcpAgentOptions["mcpManager"] {
	return {
		ensureAllEnabled: async () => {},
		getRunningTools: () => new Map(),
		getServerStates: () => new Map(),
		terminateAll: async () => {},
	} as unknown as BoundAcpAgentOptions["mcpManager"];
}

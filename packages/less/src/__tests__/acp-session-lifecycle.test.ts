import { describe, expect, it } from "bun:test";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { BoundClient, ToolCallRequest } from "@bound/client";
import type { WsStreamChunk } from "@bound/shared";
import { AcpSession, type AcpSessionDeps } from "../acp/session";
import type { AppLogger } from "../logging";
import type { ToolHandler } from "../tools/types";

/** Records every session/update the session pushes, plus permission requests. */
function makeConn() {
	const updates: Array<Record<string, unknown>> = [];
	const permissionRequests: Array<Record<string, unknown>> = [];
	let permissionOutcome: Record<string, unknown> = {
		outcome: { outcome: "selected", optionId: "allow_once" },
	};
	let sessionUpdateError: Error | null = null;
	const conn = {
		async sessionUpdate(params: { sessionId: string; update: Record<string, unknown> }) {
			if (sessionUpdateError) throw sessionUpdateError;
			updates.push(params.update);
		},
		async requestPermission(params: Record<string, unknown>) {
			permissionRequests.push(params);
			return permissionOutcome;
		},
	} as unknown as Pick<AgentSideConnection, "sessionUpdate" | "requestPermission">;
	return {
		conn,
		updates,
		permissionRequests,
		setPermissionOutcome: (o: Record<string, unknown>) => {
			permissionOutcome = o;
		},
		failSessionUpdate: (e: Error | null) => {
			sessionUpdateError = e;
		},
	};
}

function makeClient() {
	const sent: Array<{ sessionId: string; content: unknown; opts: unknown }> = [];
	const cancelled: string[] = [];
	let cancelError: Error | null = null;
	const client = {
		sendMessage(sessionId: string, content: unknown, opts: unknown) {
			sent.push({ sessionId, content, opts });
		},
		async cancelThread(sessionId: string) {
			if (cancelError) throw cancelError;
			cancelled.push(sessionId);
		},
	} as unknown as Pick<BoundClient, "sendMessage" | "cancelThread">;
	return {
		client,
		sent,
		cancelled,
		failCancel: (e: Error | null) => {
			cancelError = e;
		},
	};
}

function makeLogger() {
	const errors: Array<[string, Record<string, unknown>]> = [];
	const logger = {
		info: () => {},
		warn: () => {},
		error: (event: string, fields?: Record<string, unknown>) => {
			errors.push([event, fields ?? {}]);
		},
		debug: () => {},
	} as unknown as AppLogger;
	return { logger, errors };
}

function makeSession(overrides: Partial<AcpSessionDeps> = {}): {
	session: AcpSession;
	conn: ReturnType<typeof makeConn>;
	client: ReturnType<typeof makeClient>;
	logger: ReturnType<typeof makeLogger>;
} {
	const conn = makeConn();
	const client = makeClient();
	const logger = makeLogger();
	const deps: AcpSessionDeps = {
		sessionId: "thread-abc",
		cwd: "/work/repo",
		hostname: "host-x",
		shell: { command: "sh", execFlag: "-c", toolName: "boundless_bash", label: "sh" },
		conn: conn.conn,
		client: client.client,
		toolHandlers: new Map<string, ToolHandler>(),
		clientToolNames: new Set<string>(),
		modelId: null,
		logger: logger.logger,
		...overrides,
	};
	return { session: new AcpSession(deps), conn, client, logger };
}

describe("AcpSession — lifecycle", () => {
	it("exposes the sessionId from deps", () => {
		const { session } = makeSession();
		expect(session.sessionId).toBe("thread-abc");
	});

	it("runPrompt sends the message to the client with the model id", () => {
		const { session, client } = makeSession({ modelId: "gpt-5.6-sol" });
		// Do not await — the promise only resolves at idle; we assert the dispatch.
		void session.runPrompt("hello");
		expect(client.sent).toHaveLength(1);
		expect(client.sent[0]).toMatchObject({ sessionId: "thread-abc" });
		expect((client.sent[0].opts as { modelId?: string }).modelId).toBe("gpt-5.6-sol");
	});

	it("setModelId changes the id used on the next prompt", () => {
		const { session, client } = makeSession();
		session.setModelId("kimi-k3.1");
		void session.runPrompt("hi");
		expect((client.sent[0].opts as { modelId?: string }).modelId).toBe("kimi-k3.1");
	});

	it("setMode is accepted without error", () => {
		const { session } = makeSession();
		expect(() => session.setMode("acceptEdits")).not.toThrow();
	});

	it("cancel marks the turn cancelled and calls cancelThread", async () => {
		const { session, client } = makeSession();
		void session.runPrompt("hi");
		await session.cancel();
		expect(client.cancelled).toEqual(["thread-abc"]);
	});

	it("cancel logs acp_cancel_failed when cancelThread throws", async () => {
		const { session, client, logger } = makeSession();
		client.failCancel(new Error("socket closed"));
		await session.cancel();
		expect(logger.errors.some(([e]) => e === "acp_cancel_failed")).toBe(true);
	});

	it("close cancels and resolves the pending prompt as cancelled", async () => {
		const { session } = makeSession();
		const promise = session.runPrompt("hi");
		await session.close();
		const res = await promise;
		expect(res.stopReason).toBe("cancelled");
	});
});

describe("AcpSession — thread status and alerts", () => {
	it("resolves end_turn only after an active status was seen, then idle", async () => {
		const { session } = makeSession();
		const promise = session.runPrompt("hi");
		// A bare idle before any active must NOT resolve the turn.
		session.handleThreadStatus(false);
		session.handleThreadStatus(true); // seenActive
		session.handleThreadStatus(false); // genuine idle
		const res = await promise;
		expect(res.stopReason).toBe("end_turn");
	});

	it("a cancelled turn going idle resolves as cancelled", async () => {
		const { session } = makeSession();
		const promise = session.runPrompt("hi");
		session.handleThreadStatus(true);
		await session.cancel();
		session.handleThreadStatus(false);
		const res = await promise;
		expect(res.stopReason).toBe("cancelled");
	});

	it("an alert with no assistant text rejects the prompt at idle", async () => {
		const { session, conn } = makeSession();
		const promise = session.runPrompt("hi");
		session.handleThreadStatus(true);
		session.handleAlert("inference timed out");
		// The alert is surfaced as an assistant message chunk.
		expect(conn.updates.some((u) => u.sessionUpdate === "agent_message_chunk")).toBe(true);
		session.handleThreadStatus(false);
		await expect(promise).rejects.toThrow(/inference timed out/);
	});

	it("an alert followed by assistant text resolves end_turn (informational)", async () => {
		const { session } = makeSession();
		const promise = session.runPrompt("hi");
		session.handleThreadStatus(true);
		session.handleAlert("model fell back to secondary");
		// Real assistant text arrives after the alert.
		await session.handleStreamChunk({ type: "text", content: "here is the answer" });
		session.handleThreadStatus(false);
		const res = await promise;
		expect(res.stopReason).toBe("end_turn");
	});
});

describe("AcpSession — stream chunk mapping", () => {
	it("maps a text chunk to an agent_message_chunk and marks sawAgentText", async () => {
		const { session, conn } = makeSession();
		void session.runPrompt("hi");
		session.handleThreadStatus(true);
		await session.handleStreamChunk({ type: "text", content: "hi there" });
		const update = conn.updates.find((u) => u.sessionUpdate === "agent_message_chunk");
		expect(update).toBeDefined();
		expect((update?.content as { text: string }).text).toBe("hi there");
	});

	it("maps a thinking chunk to an agent_thought_chunk", async () => {
		const { session, conn } = makeSession();
		void session.runPrompt("hi");
		await session.handleStreamChunk({ type: "thinking", content: "let me reason" });
		expect(conn.updates.some((u) => u.sessionUpdate === "agent_thought_chunk")).toBe(true);
	});

	it("surfaces a stream error as assistant text and logs acp_stream_error", async () => {
		const { session, conn, logger } = makeSession();
		void session.runPrompt("hi");
		await session.handleStreamChunk({ type: "error", error: "backend exploded" } as WsStreamChunk);
		expect(logger.errors.some(([e]) => e === "acp_stream_error")).toBe(true);
		expect(conn.updates.some((u) => u.sessionUpdate === "agent_message_chunk")).toBe(true);
	});

	it("opens and accumulates a daemon tool_use stream into a tool_call lifecycle", async () => {
		const { session, conn } = makeSession();
		void session.runPrompt("hi");
		session.handleThreadStatus(true);
		await session.handleStreamChunk({ type: "tool_use_start", id: "call_1", name: "query" });
		await session.handleStreamChunk({
			type: "tool_use_args",
			id: "call_1",
			partial_json: '{"sql":',
		});
		await session.handleStreamChunk({
			type: "tool_use_args",
			id: "call_1",
			partial_json: '"SELECT 1"}',
		});
		await session.handleStreamChunk({ type: "tool_use_end", id: "call_1" });
		// A pending tool_call was opened, then an in_progress update with rawInput.
		expect(conn.updates.some((u) => u.sessionUpdate === "tool_call")).toBe(true);
		const inProgress = conn.updates.find(
			(u) => u.sessionUpdate === "tool_call_update" && u.status === "in_progress",
		);
		expect(inProgress).toBeDefined();
		expect((inProgress?.rawInput as { sql: string }).sql).toBe("SELECT 1");
	});

	it("logs acp_session_update_failed when the connection rejects an update", async () => {
		const { session, conn, logger } = makeSession();
		void session.runPrompt("hi");
		conn.failSessionUpdate(new Error("conn closed"));
		await session.handleStreamChunk({ type: "text", content: "x" });
		expect(logger.errors.some(([e]) => e === "acp_session_update_failed")).toBe(true);
	});
});

describe("AcpSession — client tool calls and permission", () => {
	it("executes an allowed client tool and returns its result", async () => {
		const handler: ToolHandler = async () => ({
			content: [{ type: "text", text: "tool output" }],
		});
		const { session, conn } = makeSession({
			toolHandlers: new Map([["boundless_read", handler]]),
			clientToolNames: new Set(["boundless_read"]),
		});
		void session.runPrompt("hi");
		session.handleThreadStatus(true);
		const call: ToolCallRequest = {
			call_id: "c1",
			thread_id: "thread-abc",
			tool_name: "boundless_read",
			arguments: { path: "README.md" },
		};
		const result = await session.handleToolCall(call);
		expect(result.is_error).toBeFalsy();
		expect(result.content).toEqual([{ type: "text", text: "tool output" }]);
		// Lifecycle: pending → in_progress → completed.
		expect(conn.updates.some((u) => u.sessionUpdate === "tool_call")).toBe(true);
	});

	it("rejects a client tool when the permission outcome is a reject option", async () => {
		const handler: ToolHandler = async () => ({ content: [{ type: "text", text: "nope" }] });
		const { session, conn } = makeSession({
			toolHandlers: new Map([["boundless_bash", handler]]),
			clientToolNames: new Set(["boundless_bash"]),
		});
		conn.setPermissionOutcome({ outcome: { outcome: "selected", optionId: "reject_once" } });
		void session.runPrompt("hi");
		session.handleThreadStatus(true);
		const result = await session.handleToolCall({
			call_id: "c2",
			thread_id: "thread-abc",
			tool_name: "boundless_bash",
			arguments: { command: "rm -rf /" },
		});
		expect(result.is_error).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "Tool call rejected by user" }]);
	});

	it("returns a not-found error when no handler exists for the tool", async () => {
		const { session } = makeSession({ clientToolNames: new Set(["boundless_ghost"]) });
		void session.runPrompt("hi");
		session.handleThreadStatus(true);
		const result = await session.handleToolCall({
			call_id: "c3",
			thread_id: "thread-abc",
			tool_name: "boundless_ghost",
			arguments: {},
		});
		expect(result.is_error).toBe(true);
		expect(JSON.stringify(result.content)).toContain("not found");
	});
});

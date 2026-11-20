import { describe, expect, it } from "bun:test";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { BoundClient } from "@bound/client";
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

describe("AcpSession — stream chunk mapping", () => {
	it("surfaces a stream error as assistant text and logs acp_stream_error", async () => {
		const { session, conn, logger } = makeSession();
		void session.runPrompt("hi");
		await session.handleStreamChunk({ type: "error", error: "backend exploded" } as WsStreamChunk);
		expect(logger.errors.some(([e]) => e === "acp_stream_error")).toBe(true);
		expect(conn.updates.some((u) => u.sessionUpdate === "agent_message_chunk")).toBe(true);
	});

	it("logs acp_session_update_failed when the connection rejects an update", async () => {
		const { session, conn, logger } = makeSession();
		void session.runPrompt("hi");
		conn.failSessionUpdate(new Error("conn closed"));
		await session.handleStreamChunk({ type: "text", content: "x" });
		expect(logger.errors.some(([e]) => e === "acp_session_update_failed")).toBe(true);
	});
});

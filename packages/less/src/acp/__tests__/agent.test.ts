/**
 * Integration tests for BoundAcpAgent over a real in-memory ACP connection.
 *
 * These drive the agent through a real ClientSideConnection (real JSON-RPC
 * framing) backed by a mock BoundClient, asserting on the recorded
 * session/update notifications and resolved responses. See harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, WsStreamChunk } from "@bound/shared";
import { type MockBoundClient, makeAcpHarness, makeThread, mockBoundClient } from "./harness";

/** Resolves after pending microtasks + a macrotask so wire RPCs settle. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

const PROTOCOL_VERSION = 1;

async function newSession(mock: MockBoundClient) {
	const { agentProxy, recording } = makeAcpHarness(mock);
	await agentProxy.initialize({ protocolVersion: PROTOCOL_VERSION });
	const session = await agentProxy.newSession({ cwd: "/work", mcpServers: [] });
	return { agentProxy, recording, sessionId: session.sessionId };
}

describe("BoundAcpAgent.initialize", () => {
	it("advertises loadSession and prompt capabilities", async () => {
		const mock = mockBoundClient();
		const { agentProxy } = makeAcpHarness(mock);
		const res = await agentProxy.initialize({ protocolVersion: PROTOCOL_VERSION });
		expect(res.protocolVersion).toBe(PROTOCOL_VERSION);
		expect(res.agentCapabilities?.loadSession).toBe(true);
		expect(res.agentCapabilities?.sessionCapabilities?.close).toEqual({});
		expect(res.agentCapabilities?.sessionCapabilities?.list).toEqual({});
		expect(res.agentCapabilities?.promptCapabilities?.image).toBe(false);
		expect(res.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true);
		expect(res.agentInfo?.name).toBe("boundless");
	});
});

describe("BoundAcpAgent.newSession", () => {
	it("creates a thread, subscribes, configures tools, and returns model options", async () => {
		const mock = mockBoundClient();
		const { agentProxy } = makeAcpHarness(mock);
		await agentProxy.initialize({ protocolVersion: PROTOCOL_VERSION });
		const session = await agentProxy.newSession({ cwd: "/work", mcpServers: [] });
		const sessionId = session.sessionId;
		expect(sessionId).toBe("thread-1");
		expect(mock.calls.createThread).toBe(1);
		expect(mock.calls.subscribe).toContain("thread-1");
		expect(mock.calls.configureTools).toBeGreaterThanOrEqual(1);
		expect(session.configOptions).toMatchObject([
			{
				id: "model",
				name: "Model",
				category: "model",
				type: "select",
				currentValue: "model-default",
			},
		]);
	});
});

describe("BoundAcpAgent.listSessions", () => {
	it("lists locally remembered ACP sessions with their cwd", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "bound-acp-list-"));
		try {
			const mock = mockBoundClient();
			const { agentProxy } = makeAcpHarness(mock, { configDir });
			await agentProxy.initialize({ protocolVersion: PROTOCOL_VERSION });
			const session = await agentProxy.newSession({ cwd: "/work", mcpServers: [] });
			if (!agentProxy.listSessions) throw new Error("listSessions not implemented");

			const response = await agentProxy.listSessions({});

			expect(mock.calls.listThreads).toBe(1);
			expect(response.sessions).toEqual([
				{
					sessionId: session.sessionId,
					cwd: "/work",
					title: null,
					updatedAt: new Date(0).toISOString(),
				},
			]);
		} finally {
			rmSync(configDir, { recursive: true, force: true });
		}
	});

	it("records loaded sessions and filters by cwd", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "bound-acp-list-"));
		try {
			const mock = mockBoundClient();
			const loadedThread = makeThread("loaded-thread");
			mock.setThreads([loadedThread, makeThread("other-thread")]);
			const { agentProxy } = makeAcpHarness(mock, { configDir });
			await agentProxy.initialize({ protocolVersion: PROTOCOL_VERSION });
			await agentProxy.loadSession?.({ sessionId: "loaded-thread", cwd: "/repo", mcpServers: [] });
			if (!agentProxy.listSessions) throw new Error("listSessions not implemented");

			expect((await agentProxy.listSessions({ cwd: "/repo" })).sessions).toEqual([
				{
					sessionId: "loaded-thread",
					cwd: "/repo",
					title: null,
					updatedAt: new Date(0).toISOString(),
				},
			]);
			expect((await agentProxy.listSessions({ cwd: "/elsewhere" })).sessions).toEqual([]);
		} finally {
			rmSync(configDir, { recursive: true, force: true });
		}
	});
});

describe("BoundAcpAgent.prompt", () => {
	it("streams text/thinking in order and resolves end_turn on idle", async () => {
		const mock = mockBoundClient();
		const { agentProxy, recording, sessionId } = await newSession(mock);

		const promptP = agentProxy.prompt({
			sessionId,
			prompt: [{ type: "text", text: "hello" }],
		});
		await flush();

		// The user message reached bound.
		expect(mock.calls.sendMessage).toEqual([{ threadId: sessionId, content: "hello" }]);

		mock.emitThreadStatus(sessionId, true);
		mock.emitStreamChunk(sessionId, { type: "thinking", content: "hmm" });
		mock.emitStreamChunk(sessionId, { type: "text", content: "hi " });
		mock.emitStreamChunk(sessionId, { type: "text", content: "there" });
		await flush();
		mock.emitThreadStatus(sessionId, false);

		const res = await promptP;
		expect(res.stopReason).toBe("end_turn");

		const kinds = recording.notifications.map((n) => n.update.sessionUpdate);
		expect(kinds).toEqual(["agent_thought_chunk", "agent_message_chunk", "agent_message_chunk"]);
		const texts = recording.notifications
			.filter((n) => n.update.sessionUpdate === "agent_message_chunk")
			.map((n) => (n.update as { content: { text: string } }).content.text);
		expect(texts.join("")).toBe("hi there");
	});

	it("rejects the prompt when a turn-fatal alert ends the turn with no output", async () => {
		const mock = mockBoundClient();
		const { agentProxy, recording, sessionId } = await newSession(mock);

		const promptP = agentProxy.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
		await flush();

		mock.emitThreadStatus(sessionId, true);
		mock.emitMessageCreated({
			thread_id: sessionId,
			role: "alert",
			content: "Error: inference timed out after 300s",
		});
		await flush();
		mock.emitThreadStatus(sessionId, false);

		// The failed turn surfaces as a JSON-RPC error, not a silent end_turn.
		await expect(promptP).rejects.toThrow(/inference timed out/);

		// And the alert text reached the editor as assistant content.
		const texts = recording.notifications
			.filter((n) => n.update.sessionUpdate === "agent_message_chunk")
			.map((n) => (n.update as { content: { text: string } }).content.text);
		expect(texts.some((t) => t.includes("inference timed out"))).toBe(true);
	});

	it("does not resolve on a stale idle status before the turn goes active", async () => {
		const mock = mockBoundClient();
		const { agentProxy, sessionId } = await newSession(mock);

		const promptP = agentProxy.prompt({ sessionId, prompt: [{ type: "text", text: "x" }] });
		await flush();

		// Idle BEFORE active must be ignored.
		mock.emitThreadStatus(sessionId, false);
		await flush();
		let resolved = false;
		void promptP.then(() => {
			resolved = true;
		});
		await flush();
		expect(resolved).toBe(false);

		mock.emitThreadStatus(sessionId, true);
		mock.emitThreadStatus(sessionId, false);
		const res = await promptP;
		expect(res.stopReason).toBe("end_turn");
	});
});

describe("BoundAcpAgent.cancel", () => {
	it("cancels the thread and resolves the turn with cancelled", async () => {
		const mock = mockBoundClient();
		const { agentProxy, sessionId } = await newSession(mock);

		const promptP = agentProxy.prompt({ sessionId, prompt: [{ type: "text", text: "long task" }] });
		await flush();
		mock.emitThreadStatus(sessionId, true);

		await agentProxy.cancel({ sessionId });
		expect(mock.calls.cancelThread).toContain(sessionId);

		mock.emitThreadStatus(sessionId, false);
		const res = await promptP;
		expect(res.stopReason).toBe("cancelled");
	});
});

describe("BoundAcpAgent.setSessionConfigOption", () => {
	it("switches the model used for later prompts", async () => {
		const mock = mockBoundClient();
		const { agentProxy, sessionId } = await newSession(mock);
		if (!agentProxy.setSessionConfigOption) {
			throw new Error("setSessionConfigOption not implemented");
		}

		const response = await agentProxy.setSessionConfigOption({
			sessionId,
			configId: "model",
			value: "model-alt",
		});

		expect(response.configOptions[0]).toMatchObject({
			id: "model",
			currentValue: "model-alt",
		});

		const promptP = agentProxy.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });
		await flush();
		expect(mock.calls.sendMessage).toEqual([
			{ threadId: sessionId, content: "hello", modelId: "model-alt" },
		]);
		mock.emitThreadStatus(sessionId, true);
		mock.emitThreadStatus(sessionId, false);
		await promptP;
	});
});

describe("BoundAcpAgent.closeSession", () => {
	it("cancels active work and releases the thread subscription", async () => {
		const mock = mockBoundClient();
		const { agentProxy, sessionId } = await newSession(mock);
		if (!agentProxy.closeSession) throw new Error("closeSession not implemented");

		const promptP = agentProxy.prompt({ sessionId, prompt: [{ type: "text", text: "long task" }] });
		await flush();
		mock.emitThreadStatus(sessionId, true);

		await agentProxy.closeSession({ sessionId });

		expect(mock.calls.cancelThread).toContain(sessionId);
		expect(mock.calls.unsubscribe).toContain(sessionId);
		await expect(
			agentProxy.prompt({ sessionId, prompt: [{ type: "text", text: "after close" }] }),
		).rejects.toThrow("Unknown session");

		mock.emitThreadStatus(sessionId, false);
		expect((await promptP).stopReason).toBe("cancelled");
	});
});

describe("BoundAcpAgent daemon-side tool calls", () => {
	it("surfaces native tool_use as tool_call/update and closes at turn end", async () => {
		const mock = mockBoundClient();
		const { agentProxy, recording, sessionId } = await newSession(mock);

		const promptP = agentProxy.prompt({
			sessionId,
			prompt: [{ type: "text", text: "use a tool" }],
		});
		await flush();
		mock.emitThreadStatus(sessionId, true);

		const chunks: WsStreamChunk[] = [
			{ type: "tool_use_start", id: "tu-1", name: "memory" },
			{ type: "tool_use_args", id: "tu-1", partial_json: '{"action":' },
			{ type: "tool_use_args", id: "tu-1", partial_json: '"store"}' },
			{ type: "tool_use_end", id: "tu-1" },
		];
		for (const c of chunks) mock.emitStreamChunk(sessionId, c);
		await flush();
		mock.emitThreadStatus(sessionId, false);
		await promptP;

		const toolCallUpdates = recording.notifications.filter(
			(n) =>
				n.update.sessionUpdate === "tool_call" || n.update.sessionUpdate === "tool_call_update",
		);
		const created = toolCallUpdates.find((n) => n.update.sessionUpdate === "tool_call");
		expect(created).toBeDefined();
		expect((created?.update as { toolCallId: string }).toolCallId).toBe("tu-1");
		// No permission prompt for daemon-side tools.
		expect(recording.permissionRequests.length).toBe(0);
		// Closed completed by turn end.
		const completed = toolCallUpdates.some(
			(n) =>
				n.update.sessionUpdate === "tool_call_update" &&
				(n.update as { toolCallId: string; status?: string }).toolCallId === "tu-1" &&
				(n.update as { status?: string }).status === "completed",
		);
		expect(completed).toBe(true);
	});
});

describe("BoundAcpAgent.loadSession", () => {
	it("replays history as session/update notifications", async () => {
		const mock = mockBoundClient();
		const history: Message[] = [msg("1", "user", "hi"), msg("2", "assistant", "hello")];
		mock.setMessages(history);

		const { agentProxy, recording } = makeAcpHarness(mock);
		await agentProxy.initialize({ protocolVersion: PROTOCOL_VERSION });
		if (!agentProxy.loadSession) throw new Error("loadSession not implemented");
		await agentProxy.loadSession({ sessionId: "existing-thread", cwd: "/work", mcpServers: [] });

		const kinds = recording.notifications.map((n) => n.update.sessionUpdate);
		expect(kinds).toEqual(["user_message_chunk", "agent_message_chunk"]);
	});
});

// ---- helpers ----

function msg(id: string, role: Message["role"], content: string): Message {
	return {
		id,
		thread_id: "existing-thread",
		role,
		content,
		model_id: null,
		tool_name: null,
		created_at: new Date(0).toISOString(),
		modified_at: null,
		host_origin: "",
		deleted: 0,
		exit_code: null,
		metadata: null,
	};
}

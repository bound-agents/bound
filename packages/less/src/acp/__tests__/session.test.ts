/**
 * Unit tests for AcpSession's permission gating and tool execution, driven
 * directly (no wire) so we can inject deterministic tool handlers and assert
 * on the exact sequence of session/update notifications and permission round
 * trips. The wire-level Agent surface is covered in agent.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import type {
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import type { ToolCallRequest } from "@bound/client";
import { AcpSession, type AcpSessionDeps } from "../session";

interface Recorder {
	updates: SessionNotification["update"][];
	permissionRequests: RequestPermissionRequest[];
	sentMessages: Array<{ threadId: string; content: string }>;
	cancelled: string[];
}

function setup(opts?: {
	permissionAnswers?: string[];
	defaultPermission?: string;
	toolHandlers?: Map<
		string,
		AcpSessionDeps["toolHandlers"] extends Map<string, infer H> ? H : never
	>;
}): { session: AcpSession; rec: Recorder } {
	const rec: Recorder = {
		updates: [],
		permissionRequests: [],
		sentMessages: [],
		cancelled: [],
	};
	const answers = [...(opts?.permissionAnswers ?? [])];

	const conn: AcpSessionDeps["conn"] = {
		async sessionUpdate(params: SessionNotification): Promise<void> {
			rec.updates.push(params.update);
		},
		async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
			rec.permissionRequests.push(params);
			const optionId = answers.shift() ?? opts?.defaultPermission ?? "allow_once";
			return { outcome: { outcome: "selected", optionId } };
		},
	};

	const client: AcpSessionDeps["client"] = {
		sendMessage: (threadId: string, content: string) => {
			rec.sentMessages.push({ threadId, content });
		},
		cancelThread: async (threadId: string) => {
			rec.cancelled.push(threadId);
			return { cancelled: true as const, thread_id: threadId };
		},
	};

	const session = new AcpSession({
		sessionId: "t1",
		cwd: "/work",
		hostname: "h",
		shell: { toolName: "boundless_bash" } as AcpSessionDeps["shell"],
		conn,
		client,
		toolHandlers: (opts?.toolHandlers ?? new Map()) as AcpSessionDeps["toolHandlers"],
		clientToolNames: new Set(["boundless_read", "boundless_bash"]),
		modelId: null,
		logger: {
			info: () => {},
			warn: () => {},
			error: () => {},
		} as unknown as AcpSessionDeps["logger"],
	});
	return { session, rec };
}

const call = (overrides?: Partial<ToolCallRequest>): ToolCallRequest => ({
	call_id: "c1",
	thread_id: "t1",
	tool_name: "boundless_read",
	arguments: { file_path: "a.txt" },
	...overrides,
});

describe("AcpSession permission gating", () => {
	it("requests permission and executes the handler on allow_once", async () => {
		const ran: Array<{ args: Record<string, unknown>; cwd: string }> = [];
		const handlers = new Map([
			[
				"boundless_read",
				async (args: Record<string, unknown>, _signal: AbortSignal, cwd: string) => {
					ran.push({ args, cwd });
					return { content: [{ type: "text" as const, text: "contents" }] };
				},
			],
		]);
		const { session, rec } = setup({ permissionAnswers: ["allow_once"], toolHandlers: handlers });

		const result = await session.handleToolCall(call());

		expect(rec.permissionRequests.length).toBe(1);
		const permissionToolCallId = rec.permissionRequests[0]?.toolCall.toolCallId;
		expect(permissionToolCallId?.startsWith("c1-t")).toBe(true);
		expect(rec.permissionRequests[0]?.toolCall).toMatchObject({
			title: "Read a.txt",
			kind: "read",
			status: "pending",
			rawInput: { file_path: "a.txt" },
			locations: [{ path: resolve("/work", "a.txt") }],
		});
		expect(ran).toEqual([{ args: { file_path: "a.txt" }, cwd: "/work" }]);
		expect(result.is_error).toBeFalsy();
		const statuses = rec.updates
			.filter((u) => u.sessionUpdate === "tool_call_update")
			.map((u) => (u as { status: string }).status);
		expect(statuses).toEqual(["in_progress", "completed"]);
	});

	it("surfaces shell command and cwd in the tool card and permission request", async () => {
		const handlers = new Map([
			[
				"boundless_bash",
				async () => ({
					content: [{ type: "text" as const, text: "Exit code: 0\nstdout:\ndone\nstderr:\n" }],
				}),
			],
		]);
		const { session, rec } = setup({ permissionAnswers: ["allow_once"], toolHandlers: handlers });

		const result = await session.handleToolCall(
			call({
				call_id: "c-bash",
				tool_name: "boundless_bash",
				arguments: { command: "sleep 10" },
			}),
		);

		expect(result.is_error).toBeFalsy();
		const created = rec.updates.find((u) => u.sessionUpdate === "tool_call");
		expect(created).toBeDefined();
		const toolCallId = (created as { toolCallId: string }).toolCallId;
		expect(toolCallId.startsWith("c-bash-t")).toBe(true);
		expect(created).toMatchObject({
			toolCallId,
			_meta: { terminal_info: { terminal_id: toolCallId, cwd: "/work" } },
			title: "sleep 10",
			kind: "execute",
			status: "pending",
			rawInput: { command: "sleep 10" },
			content: [{ type: "terminal", terminalId: toolCallId }],
		});
		expect(rec.permissionRequests[0]?.toolCall).toMatchObject({
			toolCallId,
			_meta: { terminal_info: { terminal_id: toolCallId, cwd: "/work" } },
			title: "sleep 10",
			kind: "execute",
			status: "pending",
			rawInput: { command: "sleep 10" },
			content: [{ type: "terminal", terminalId: toolCallId }],
		});
		expect(
			rec.updates.find(
				(u) =>
					u.sessionUpdate === "tool_call_update" &&
					(u as { toolCallId?: string; status?: string }).toolCallId === toolCallId &&
					(u as { status?: string }).status === "completed",
			),
		).toMatchObject({
			_meta: {
				terminal_output: { terminal_id: toolCallId, data: "done" },
				terminal_exit: { terminal_id: toolCallId, exit_code: 0 },
			},
			rawOutput: {
				output: "Exit code: 0\nstdout:\ndone\nstderr:\n",
				exitCode: 0,
			},
		});
	});

	it("surfaces Zed sandbox authorization metadata for write approvals", async () => {
		const handlers = new Map([
			[
				"boundless_write",
				async () => ({
					content: [{ type: "text" as const, text: "wrote" }],
				}),
			],
		]);
		const { session, rec } = setup({ permissionAnswers: ["allow_once"], toolHandlers: handlers });

		const result = await session.handleToolCall(
			call({
				call_id: "c-write",
				tool_name: "boundless_write",
				arguments: { file_path: "src/generated.ts", content: "export {};" },
			}),
		);

		expect(result.is_error).toBeFalsy();
		const expectedMeta = {
			tool_name: "boundless_write",
			sandbox_authorization: { write_paths: [resolve("/work", "src/generated.ts")] },
		};
		const created = rec.updates.find((u) => u.sessionUpdate === "tool_call");
		expect(created).toBeDefined();
		const toolCallId = (created as { toolCallId: string }).toolCallId;
		expect(toolCallId.startsWith("c-write-t")).toBe(true);
		expect(created).toMatchObject({
			toolCallId,
			_meta: expectedMeta,
			title: "Write src/generated.ts",
			kind: "edit",
			status: "pending",
			locations: [{ path: resolve("/work", "src/generated.ts") }],
		});
		expect(rec.permissionRequests[0]?.toolCall).toMatchObject({
			toolCallId,
			_meta: expectedMeta,
			title: "Write src/generated.ts",
			kind: "edit",
			status: "pending",
			locations: [{ path: resolve("/work", "src/generated.ts") }],
		});
	});

	it("preserves the edit diff on completion (no content overwrite on success)", async () => {
		const handlers = new Map([
			[
				"boundless_edit",
				async () => ({
					content: [{ type: "text" as const, text: "Edited a.txt" }],
				}),
			],
		]);
		const { session, rec } = setup({ permissionAnswers: ["allow_once"], toolHandlers: handlers });

		const result = await session.handleToolCall(
			call({
				call_id: "c-edit",
				tool_name: "boundless_edit",
				arguments: { file_path: "src/x.ts", old_string: "a", new_string: "b" },
			}),
		);

		expect(result.is_error).toBeFalsy();
		// The pending frame carried a diff; ACP tool_call_update content replaces
		// the collection, so the completion frame must NOT send content on success
		// or the diff is clobbered. It should leave the diff in place (delta).
		const pending = rec.updates.find((u) => u.sessionUpdate === "tool_call") as
			| { toolCallId: string; content?: Array<{ type: string }> }
			| undefined;
		expect(pending).toBeDefined();
		const toolCallId = pending?.toolCallId;
		expect(toolCallId?.startsWith("c-edit-t")).toBe(true);
		const completed = rec.updates.find(
			(u) =>
				u.sessionUpdate === "tool_call_update" &&
				(u as { status?: string }).status === "completed" &&
				(u as { toolCallId?: string }).toolCallId === toolCallId,
		) as Record<string, unknown> | undefined;
		expect(completed).toBeDefined();
		expect(completed).not.toHaveProperty("content");
		// And the pending frame did carry the diff.
		expect(pending?.content?.some((c) => c.type === "diff")).toBe(true);
	});

	it("surfaces the error text on a failed edit (diff not preserved)", async () => {
		const handlers = new Map([
			[
				"boundless_edit",
				async () => ({
					content: [{ type: "text" as const, text: "Error: old_string not found" }],
					isError: true,
				}),
			],
		]);
		const { session, rec } = setup({ permissionAnswers: ["allow_once"], toolHandlers: handlers });

		const result = await session.handleToolCall(
			call({
				call_id: "c-edit-fail",
				tool_name: "boundless_edit",
				arguments: { file_path: "src/x.ts", old_string: "a", new_string: "b" },
			}),
		);

		expect(result.is_error).toBe(true);
		const pending = rec.updates.find((u) => u.sessionUpdate === "tool_call") as
			| { toolCallId: string }
			| undefined;
		expect(pending?.toolCallId.startsWith("c-edit-fail-t")).toBe(true);
		const failed = rec.updates.find(
			(u) =>
				u.sessionUpdate === "tool_call_update" &&
				(u as { status?: string }).status === "failed" &&
				(u as { toolCallId?: string }).toolCallId === pending?.toolCallId,
		) as { content?: Array<{ type: string }> } | undefined;
		expect(failed).toBeDefined();
		expect(failed?.content?.length).toBeGreaterThan(0);
	});

	it("does not execute the handler on reject_once", async () => {
		let ran = false;
		const handlers = new Map([
			[
				"boundless_read",
				async () => {
					ran = true;
					return { content: [{ type: "text" as const, text: "x" }] };
				},
			],
		]);
		const { session, rec } = setup({ permissionAnswers: ["reject_once"], toolHandlers: handlers });

		const result = await session.handleToolCall(call());

		expect(ran).toBe(false);
		expect(result.is_error).toBe(true);
		const failed = rec.updates.some(
			(u) =>
				u.sessionUpdate === "tool_call_update" && (u as { status: string }).status === "failed",
		);
		expect(failed).toBe(true);
	});

	it("remembers allow_always and skips the prompt on the next call", async () => {
		const handlers = new Map([
			["boundless_read", async () => ({ content: [{ type: "text" as const, text: "ok" }] })],
		]);
		const { session, rec } = setup({ permissionAnswers: ["allow_always"], toolHandlers: handlers });

		await session.handleToolCall(call({ call_id: "c1" }));
		await session.handleToolCall(call({ call_id: "c2" }));

		expect(rec.permissionRequests.length).toBe(1);
	});

	it("remembers reject_always", async () => {
		let runs = 0;
		const handlers = new Map([
			[
				"boundless_read",
				async () => {
					runs += 1;
					return { content: [{ type: "text" as const, text: "ok" }] };
				},
			],
		]);
		const { session, rec } = setup({
			permissionAnswers: ["reject_always"],
			toolHandlers: handlers,
		});

		await session.handleToolCall(call({ call_id: "c1" }));
		await session.handleToolCall(call({ call_id: "c2" }));

		expect(rec.permissionRequests.length).toBe(1);
		expect(runs).toBe(0);
	});

	it("treats a missing handler as a failed tool call", async () => {
		const { session } = setup({ permissionAnswers: ["allow_once"], toolHandlers: new Map() });
		const result = await session.handleToolCall(call({ tool_name: "boundless_read" }));
		expect(result.is_error).toBe(true);
	});

	it("reports a thrown handler as a failed tool call", async () => {
		const handlers = new Map([
			[
				"boundless_read",
				async () => {
					throw new Error("disk on fire");
				},
			],
		]);
		const { session, rec } = setup({ permissionAnswers: ["allow_once"], toolHandlers: handlers });
		const result = await session.handleToolCall(call());
		expect(result.is_error).toBe(true);
		expect(JSON.stringify(rec.updates)).toContain("disk on fire");
	});
});

describe("AcpSession tool call id namespacing", () => {
	it("namespaces client tool ids per turn so per-request ids (call_1) don't collide across turns", async () => {
		// The Responses API (bedrock-mantle / GPT-5.x) numbers tool calls per
		// request (call_1, call_2, ...), resetting every turn. ACP keys tool
		// calls by toolCallId for the whole session, so an un-namespaced call_1
		// in turn 2 reads as an update to turn 1's completed call_1 and never
		// renders as a new call. The session must hand the editor a distinct id.
		const handlers = new Map([
			["boundless_read", async () => ({ content: [{ type: "text" as const, text: "ok" }] })],
		]);
		const { session, rec } = setup({ defaultPermission: "allow_once", toolHandlers: handlers });

		const p1 = session.runPrompt("one");
		session.handleThreadStatus(true);
		await session.handleToolCall(call({ call_id: "call_1" }));
		session.handleThreadStatus(false);
		await p1;

		const p2 = session.runPrompt("two");
		session.handleThreadStatus(true);
		await session.handleToolCall(call({ call_id: "call_1" }));
		session.handleThreadStatus(false);
		await p2;

		const pendingIds = rec.updates
			.filter((u) => u.sessionUpdate === "tool_call")
			.map((u) => (u as { toolCallId: string }).toolCallId);
		expect(pendingIds.length).toBe(2);
		expect(pendingIds[0]).not.toBe(pendingIds[1]);
	});

	it("keeps one call's lifecycle updates sharing a single namespaced id within a turn", async () => {
		const handlers = new Map([
			["boundless_read", async () => ({ content: [{ type: "text" as const, text: "ok" }] })],
		]);
		const { session, rec } = setup({ defaultPermission: "allow_once", toolHandlers: handlers });

		const p = session.runPrompt("go");
		session.handleThreadStatus(true);
		await session.handleToolCall(call({ call_id: "call_1" }));
		session.handleThreadStatus(false);
		await p;

		const ids = rec.updates
			.filter((u) => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update")
			.map((u) => (u as { toolCallId: string }).toolCallId);
		expect(ids.length).toBeGreaterThanOrEqual(2);
		expect(new Set(ids).size).toBe(1);
	});

	it("returns the raw call_id to the daemon even when the ACP id is namespaced", async () => {
		const handlers = new Map([
			["boundless_read", async () => ({ content: [{ type: "text" as const, text: "ok" }] })],
		]);
		const { session } = setup({ defaultPermission: "allow_once", toolHandlers: handlers });

		session.runPrompt("go");
		session.handleThreadStatus(true);
		const result = await session.handleToolCall(call({ call_id: "call_1" }));
		// The daemon pairs the result to its dispatch by the raw id; namespacing
		// is Zed-facing only and must not leak into the tool result.
		expect(result.call_id).toBe("call_1");
	});

	it("namespaces client tool ids even when dispatch arrives after the turn state cleared", async () => {
		// The daemon can ask the ACP client for a local tool after the prompt turn
		// has already resolved/cleared in the ACP shim. GPT-5.x still supplies
		// per-request ids like call_1, so falling back to the raw id outside a turn
		// recreates the exact Zed collision: the second call_1 updates the old card.
		const handlers = new Map([
			["boundless_read", async () => ({ content: [{ type: "text" as const, text: "ok" }] })],
		]);
		const { session, rec } = setup({ defaultPermission: "allow_once", toolHandlers: handlers });

		const r1 = await session.handleToolCall(call({ call_id: "call_1" }));
		const r2 = await session.handleToolCall(call({ call_id: "call_1" }));

		expect(r1.call_id).toBe("call_1");
		expect(r2.call_id).toBe("call_1");
		const pendingIds = rec.updates
			.filter((u) => u.sessionUpdate === "tool_call")
			.map((u) => (u as { toolCallId: string }).toolCallId);
		expect(pendingIds.length).toBe(2);
		expect(pendingIds[0]).not.toBe(pendingIds[1]);
	});

	it("namespaces daemon-side tool ids per turn (start/in_progress/completed share one id)", async () => {
		const { session, rec } = setup();

		const p1 = session.runPrompt("one");
		session.handleThreadStatus(true);
		await session.handleStreamChunk({ type: "tool_use_start", id: "call_1", name: "memory" });
		await session.handleStreamChunk({ type: "tool_use_end", id: "call_1" });
		session.handleThreadStatus(false);
		await p1;

		const p2 = session.runPrompt("two");
		session.handleThreadStatus(true);
		await session.handleStreamChunk({ type: "tool_use_start", id: "call_1", name: "memory" });
		await session.handleStreamChunk({ type: "tool_use_end", id: "call_1" });
		session.handleThreadStatus(false);
		await p2;

		const pendingIds = rec.updates
			.filter((u) => u.sessionUpdate === "tool_call")
			.map((u) => (u as { toolCallId: string }).toolCallId);
		expect(pendingIds.length).toBe(2);
		expect(pendingIds[0]).not.toBe(pendingIds[1]);
		// And every update for turn 1's call shares the turn-1 id (start +
		// in_progress + the completed cleanup at turn end).
		const turn1Id = pendingIds[0];
		const turn1Updates = rec.updates.filter(
			(u) =>
				(u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") &&
				(u as { toolCallId: string }).toolCallId === turn1Id,
		);
		expect(turn1Updates.length).toBeGreaterThanOrEqual(2);
	});
});

describe("AcpSession turn lifecycle", () => {
	it("resolves end_turn after active→idle", async () => {
		const { session, rec } = setup();
		const p = session.runPrompt("hello");
		expect(rec.sentMessages).toEqual([{ threadId: "t1", content: "hello" }]);
		session.handleThreadStatus(true);
		session.handleThreadStatus(false);
		expect((await p).stopReason).toBe("end_turn");
	});

	it("ignores idle before active (no premature resolve)", async () => {
		const { session } = setup();
		const p = session.runPrompt("x");
		let resolved = false;
		void p.then(() => {
			resolved = true;
		});
		session.handleThreadStatus(false);
		await Promise.resolve();
		expect(resolved).toBe(false);
		session.handleThreadStatus(true);
		session.handleThreadStatus(false);
		expect((await p).stopReason).toBe("end_turn");
	});

	it("does not resolve end_turn while a client tool dispatched this turn is in flight", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const handlers = new Map([
			[
				"boundless_read",
				async () => {
					await gate;
					return { content: [{ type: "text" as const, text: "ok" }] };
				},
			],
		]);
		const { session } = setup({ permissionAnswers: ["allow_once"], toolHandlers: handlers });
		const p = session.runPrompt("go");
		let resolved = false;
		void p.then(() => {
			resolved = true;
		});
		session.handleThreadStatus(true);
		// Daemon dispatches a client tool, then EXITS its loop to await the
		// result — reporting the thread idle in the meantime. That idle must NOT
		// be mistaken for turn completion or the prompt resolves mid-turn and the
		// tool result is stranded (user has to re-prompt to continue).
		const toolPromise = session.handleToolCall(call());
		session.handleThreadStatus(false);
		await new Promise((r) => setTimeout(r, 10));
		expect(resolved).toBe(false);
		// Tool completes; daemon resumes (active) and then goes idle for real.
		release?.();
		await toolPromise;
		session.handleThreadStatus(true);
		session.handleThreadStatus(false);
		expect((await p).stopReason).toBe("end_turn");
	});

	it("resolves cancelled after cancel()", async () => {
		const { session, rec } = setup();
		const p = session.runPrompt("long");
		session.handleThreadStatus(true);
		await session.cancel();
		expect(rec.cancelled).toContain("t1");
		session.handleThreadStatus(false);
		expect((await p).stopReason).toBe("cancelled");
	});
});

describe("AcpSession daemon-side tool stream", () => {
	it("emits tool_call + in_progress and closes completed at turn end", async () => {
		const { session, rec } = setup();
		const p = session.runPrompt("go");
		session.handleThreadStatus(true);
		await session.handleStreamChunk({ type: "tool_use_start", id: "tu1", name: "memory" });
		await session.handleStreamChunk({ type: "tool_use_args", id: "tu1", partial_json: '{"a":1}' });
		await session.handleStreamChunk({ type: "tool_use_end", id: "tu1" });
		session.handleThreadStatus(false);
		await p;

		const created = rec.updates.find((u) => u.sessionUpdate === "tool_call");
		expect(created).toBeDefined();
		expect((created as { kind: string }).kind).toBe("other");
		// The ACP id is namespaced per turn (see "id namespacing" suite); the raw
		// stream id "tu1" is the prefix. Resolve the minted id and assert the
		// lifecycle updates all share it.
		const toolCallId = (created as { toolCallId: string }).toolCallId;
		const forTu1 = rec.updates.filter(
			(u) =>
				(u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") &&
				(u as { toolCallId: string }).toolCallId === toolCallId,
		);
		const inProgress = forTu1.find(
			(u) =>
				u.sessionUpdate === "tool_call_update" &&
				(u as { status: string }).status === "in_progress",
		);
		expect((inProgress as { rawInput: unknown }).rawInput).toEqual({ a: 1 });
		const completed = forTu1.some(
			(u) =>
				u.sessionUpdate === "tool_call_update" && (u as { status: string }).status === "completed",
		);
		expect(completed).toBe(true);
	});

	it("skips client-tool tool_use chunks (handled via tool:call)", async () => {
		const { session, rec } = setup();
		session.runPrompt("go");
		session.handleThreadStatus(true);
		await session.handleStreamChunk({ type: "tool_use_start", id: "x", name: "boundless_read" });
		const created = rec.updates.filter((u) => u.sessionUpdate === "tool_call");
		expect(created.length).toBe(0);
	});
});

describe("AcpSession streaming text", () => {
	it("maps text and thinking chunks to ordered notifications", async () => {
		const { session, rec } = setup();
		session.runPrompt("go");
		session.handleThreadStatus(true);
		await session.handleStreamChunk({ type: "thinking", content: "hmm" });
		await session.handleStreamChunk({ type: "text", content: "ans" });
		expect(rec.updates.map((u) => u.sessionUpdate)).toEqual([
			"agent_thought_chunk",
			"agent_message_chunk",
		]);
	});
});

describe("AcpSession streamed message ids", () => {
	const idOf = (u: SessionNotification["update"]): string | null | undefined =>
		(u as { messageId?: string | null }).messageId;

	it("shares one messageId across a contiguous agent_message_chunk run", async () => {
		const { session, rec } = setup();
		session.runPrompt("go");
		session.handleThreadStatus(true);
		await session.handleStreamChunk({ type: "text", content: "one " });
		await session.handleStreamChunk({ type: "text", content: "two " });
		await session.handleStreamChunk({ type: "text", content: "three" });
		const ids = rec.updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map(idOf);
		expect(ids.length).toBe(3);
		expect(typeof ids[0]).toBe("string");
		expect(new Set(ids).size).toBe(1);
	});

	it("starts a fresh messageId after a tool call breaks the run", async () => {
		const { session, rec } = setup();
		session.runPrompt("go");
		session.handleThreadStatus(true);
		await session.handleStreamChunk({ type: "text", content: "before" });
		await session.handleStreamChunk({ type: "tool_use_start", id: "tu1", name: "memory" });
		await session.handleStreamChunk({ type: "text", content: "after" });
		const ids = rec.updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map(idOf);
		expect(ids.length).toBe(2);
		expect(ids[0]).not.toBe(ids[1]);
	});

	it("uses distinct messageIds for text vs thought, and a switch breaks each run", async () => {
		const { session, rec } = setup();
		session.runPrompt("go");
		session.handleThreadStatus(true);
		await session.handleStreamChunk({ type: "thinking", content: "ponder" });
		await session.handleStreamChunk({ type: "text", content: "answer" });
		await session.handleStreamChunk({ type: "thinking", content: "reconsider" });
		const thoughtIds = rec.updates
			.filter((u) => u.sessionUpdate === "agent_thought_chunk")
			.map(idOf);
		const textIds = rec.updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map(idOf);
		expect(textIds.length).toBe(1);
		expect(thoughtIds.length).toBe(2);
		// thought → text → thought: every id distinct (text break + thought break)
		const all = [thoughtIds[0], textIds[0], thoughtIds[1]];
		expect(new Set(all).size).toBe(3);
	});

	it("stamps a messageId on the alert agent_message_chunk surface", async () => {
		const { session, rec } = setup();
		const p = session.runPrompt("hi");
		session.handleThreadStatus(true);
		session.handleAlert("Error: boom");
		session.handleThreadStatus(false);
		await p.catch(() => {});
		const alertChunk = rec.updates.find(
			(u) =>
				u.sessionUpdate === "agent_message_chunk" &&
				(u as { content: { text: string } }).content.text.includes("boom"),
		);
		expect(typeof idOf(alertChunk as SessionNotification["update"])).toBe("string");
	});
});

describe("AcpSession turn-fatal alert propagation", () => {
	it("rejects the prompt with an error when a fatal alert arrives and no assistant text was produced", async () => {
		const { session } = setup();
		const promise = session.runPrompt("hi");
		session.handleThreadStatus(true); // daemon went active
		session.handleAlert("Error: inference timed out after 300s");
		session.handleThreadStatus(false); // idle → fatal turn, reject
		await expect(promise).rejects.toThrow(/inference timed out/);
	});

	it("surfaces the alert to the editor as agent_message_chunk text", async () => {
		const { session, rec } = setup();
		const promise = session.runPrompt("hi");
		session.handleThreadStatus(true);
		session.handleAlert("Error: boom");
		session.handleThreadStatus(false);
		await promise.catch(() => {}); // rejection asserted in the test above
		const texts = rec.updates
			.filter((u) => u.sessionUpdate === "agent_message_chunk")
			.map((u) => (u as { content: { text: string } }).content.text);
		expect(texts.some((t) => t.includes("boom"))).toBe(true);
	});

	it("resolves end_turn when an alert precedes assistant text (informational, e.g. model fallback)", async () => {
		const { session } = setup();
		const promise = session.runPrompt("hi");
		session.handleThreadStatus(true);
		// Non-fatal alert: model unavailable, falling back to a same-tier model.
		session.handleAlert('Model "x" unavailable. Using same-tier alternative "y".');
		// The turn then produces a real assistant response and completes normally.
		await session.handleStreamChunk({ type: "text", content: "hello" });
		session.handleThreadStatus(false);
		const res = await promise;
		expect(res.stopReason).toBe("end_turn");
	});

	it("prefers cancelled over a fatal alert when the turn was cancelled", async () => {
		const { session } = setup();
		const promise = session.runPrompt("hi");
		session.handleThreadStatus(true);
		await session.cancel();
		session.handleAlert("Error: aborted mid-flight");
		session.handleThreadStatus(false);
		const res = await promise;
		expect(res.stopReason).toBe("cancelled");
	});
});

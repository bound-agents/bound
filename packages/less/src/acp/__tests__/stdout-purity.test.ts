/**
 * Guards the load-bearing invariant of ACP mode: stdout is the JSON-RPC channel,
 * so every byte the agent writes to its output stream MUST be a valid newline-
 * delimited JSON-RPC frame. A stray console.log / banner / progress line would
 * corrupt the protocol and break the editor connection.
 *
 * This test taps the raw bytes on the agent→client pipe (before ndJsonStream
 * decodes them) and asserts that across a full initialize → newSession →
 * prompt → idle run, every non-empty line parses as JSON-RPC 2.0.
 */

import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Agent,
	AgentSideConnection,
	type Client,
	ClientSideConnection,
	type RequestPermissionResponse,
	type SessionNotification,
	ndJsonStream,
} from "@agentclientprotocol/sdk";
import type { BoundAcpAgentOptions } from "../server";
import { BoundAcpAgent } from "../server";
import { mockBoundClient } from "./harness";

function fakeShell(): BoundAcpAgentOptions["shell"] {
	return { toolName: "boundless_bash" } as unknown as BoundAcpAgentOptions["shell"];
}
function fakeMcpManager(): BoundAcpAgentOptions["mcpManager"] {
	return {
		ensureAllEnabled: async () => {},
		getRunningTools: () => new Map(),
		getServerStates: () => new Map(),
		terminateAll: async () => {},
	} as unknown as BoundAcpAgentOptions["mcpManager"];
}
function fakeLogger(): BoundAcpAgentOptions["logger"] {
	return {
		info: () => {},
		warn: () => {},
		error: () => {},
	} as unknown as BoundAcpAgentOptions["logger"];
}

describe("ACP stdout purity", () => {
	it("emits only valid JSON-RPC frames on the agent output stream", async () => {
		const mock = mockBoundClient();

		// Tap the agent→client byte stream: the agent writes here; we record every
		// chunk, then forward it to the client side unchanged.
		const captured: Uint8Array[] = [];
		const tap = new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				captured.push(chunk);
				controller.enqueue(chunk);
			},
		});
		const c2a = new TransformStream<Uint8Array, Uint8Array>();

		const agentStream = ndJsonStream(tap.writable, c2a.readable);
		const clientStream = ndJsonStream(c2a.writable, tap.readable);

		new AgentSideConnection(
			(conn): Agent =>
				new BoundAcpAgent({
					client: mock.client,
					conn,
					mcpManager: fakeMcpManager(),
					mcpConfigs: [],
					configDir: join(tmpdir(), `acp-purity-test-${randomBytes(4).toString("hex")}`),
					hostname: "h",
					shell: fakeShell(),
					logger: fakeLogger(),
					modelId: null,
				}),
			agentStream,
		);

		const recordingClient: Client = {
			async sessionUpdate(_p: SessionNotification): Promise<void> {},
			async requestPermission(): Promise<RequestPermissionResponse> {
				return { outcome: { outcome: "selected", optionId: "allow_once" } };
			},
		};
		const proxy = new ClientSideConnection(() => recordingClient, clientStream);

		await proxy.initialize({ protocolVersion: 1 });
		const session = await proxy.newSession({ cwd: "/work", mcpServers: [] });
		const promptP = proxy.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "hi" }],
		});
		await new Promise((r) => setTimeout(r, 5));
		mock.emitThreadStatus(session.sessionId, true);
		mock.emitStreamChunk(session.sessionId, { type: "text", content: "hello" });
		await new Promise((r) => setTimeout(r, 5));
		mock.emitThreadStatus(session.sessionId, false);
		await promptP;

		// Decode all captured bytes and assert every non-empty line is JSON-RPC.
		const text = Buffer.concat(captured.map((c) => Buffer.from(c))).toString("utf8");
		const lines = text.split("\n").filter((l) => l.trim().length > 0);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			let parsed: unknown;
			expect(() => {
				parsed = JSON.parse(line);
			}).not.toThrow();
			expect((parsed as { jsonrpc?: string }).jsonrpc).toBe("2.0");
		}
	});
});

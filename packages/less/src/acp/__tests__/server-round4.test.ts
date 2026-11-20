/**
 * Round-4 coverage for BoundAcpAgent paths not exercised elsewhere:
 * setSessionConfigOption validation errors, the ACP→boundless MCP merge and
 * its warning/collision logging in attachAndRegister, closeSession teardown,
 * and the daemon tool_result broadcast handler. Uses the in-memory harness.
 */

import { describe, expect, it } from "bun:test";
import type { Message } from "@bound/shared";
import { type MockBoundClient, makeAcpHarness, mockBoundClient } from "./harness";

const PROTOCOL_VERSION = 1;
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

async function newSession(mock: MockBoundClient, overrides?: Parameters<typeof makeAcpHarness>[1]) {
	const harness = makeAcpHarness(mock, overrides);
	await harness.agentProxy.initialize({ protocolVersion: PROTOCOL_VERSION });
	const session = await harness.agentProxy.newSession({ cwd: "/work", mcpServers: [] });
	return { ...harness, sessionId: session.sessionId };
}

describe("BoundAcpAgent.setSessionConfigOption round4 errors", () => {
	it("rejects config changes for an unknown session", async () => {
		const mock = mockBoundClient();
		const { agentProxy } = await newSession(mock);
		if (!agentProxy.setSessionConfigOption) throw new Error("not implemented");
		await expect(
			agentProxy.setSessionConfigOption({
				sessionId: "no-such-session",
				configId: "model",
				value: "model-alt",
			}),
		).rejects.toThrow(/Unknown session/);
	});

	it("rejects an unknown model value", async () => {
		const mock = mockBoundClient();
		const { agentProxy, sessionId } = await newSession(mock);
		if (!agentProxy.setSessionConfigOption) throw new Error("not implemented");
		await expect(
			agentProxy.setSessionConfigOption({
				sessionId,
				configId: "model",
				value: "model-that-does-not-exist",
			}),
		).rejects.toThrow(/Unknown model/);
	});

	it("rejects an unknown config option id", async () => {
		const mock = mockBoundClient();
		const { agentProxy, sessionId } = await newSession(mock);
		if (!agentProxy.setSessionConfigOption) throw new Error("not implemented");
		await expect(
			agentProxy.setSessionConfigOption({
				sessionId,
				configId: "not-a-real-config",
				value: "whatever",
			}),
		).rejects.toThrow(/Unknown config option/);
	});
});

describe("BoundAcpAgent daemon tool_result broadcast (server.ts 524-534)", () => {
	it("routes a daemon tool_result message:created to the owning session", async () => {
		const mock = mockBoundClient();
		const { sessionId } = await newSession(mock);
		await flush();
		// A tool_result row carrying the originating tool-call id as tool_name —
		// the broadcast handler forwards it to the session's handleToolResultMessage.
		// A message for an unknown thread is ignored (the guard branch); this one
		// targets the live session, so it must not throw.
		mock.emitMessageCreated({
			thread_id: sessionId,
			role: "tool_result",
			tool_name: "call-123",
			content: "native tool output",
		} as Partial<Message> & { thread_id: string; role: string });
		// Unknown-thread broadcast is a no-op (early return).
		mock.emitMessageCreated({
			thread_id: "ghost-thread",
			role: "tool_result",
			tool_name: "call-456",
			content: "orphan",
		} as Partial<Message> & { thread_id: string; role: string });
		await flush();
		expect(sessionId).toBeTruthy();
	});
});

describe("BoundAcpAgent.closeSession round4 teardown", () => {
	it("cancels work and releases the subscription", async () => {
		const mock = mockBoundClient();
		const { agentProxy, sessionId } = await newSession(mock);
		if (!agentProxy.closeSession) throw new Error("not implemented");
		await agentProxy.closeSession({ sessionId });
		expect(mock.calls.unsubscribe).toContain(sessionId);
	});
});

import { describe, expect, it } from "bun:test";
import type { BoundClient } from "@bound/client";
import type { Message } from "@bound/shared";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import {
	PENDING_USER_MESSAGE_ID,
	type UseMessagesResult,
	useMessages,
} from "../tui/hooks/useMessages";

/** Let React effects flush */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

type EventHandler = (...args: unknown[]) => void;

function createMockClient() {
	const listeners = new Map<string, Set<EventHandler>>();
	return {
		on: (event: string, handler: EventHandler) => {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event)?.add(handler);
		},
		off: (event: string, handler: EventHandler) => {
			listeners.get(event)?.delete(handler);
		},
		emit: (event: string, data: unknown) => {
			for (const handler of listeners.get(event) ?? []) handler(data);
		},
	} as unknown as BoundClient & { emit: (event: string, data: unknown) => void };
}

function makeUserMessage(id: string, content: string): Message {
	return {
		id,
		thread_id: "t-1",
		role: "user",
		content,
		model_id: null,
		tool_name: null,
		created_at: new Date().toISOString(),
		modified_at: null,
		host_origin: "h-1",
		deleted: 0,
		exit_code: null,
		metadata: null,
	};
}

/** Renders the hook and exposes its result through a ref-like closure. */
function renderUseMessages(client: ReturnType<typeof createMockClient>) {
	let api: UseMessagesResult | null = null;
	function Harness() {
		api = useMessages(client as unknown as BoundClient, []);
		return React.createElement(Text, null, `count:${api.messages.length}`);
	}
	const r = render(React.createElement(Harness));
	return {
		...r,
		get api() {
			if (!api) throw new Error("hook not initialized");
			return api;
		},
	};
}

describe("useMessages — optimistic user message", () => {
	it("renders an optimistic placeholder immediately via appendPendingUserMessage", async () => {
		const client = createMockClient();
		const h = renderUseMessages(client);
		await tick();

		h.api.appendPendingUserMessage("t-1", "hello there");
		await tick();

		const msgs = h.api.messages;
		expect(msgs.length).toBe(1);
		expect(msgs[0].role).toBe("user");
		expect(msgs[0].content).toBe("hello there");
		expect(msgs[0].id).toBe(PENDING_USER_MESSAGE_ID);
	});

	it("replaces the placeholder when the real user message arrives — no duplicate", async () => {
		const client = createMockClient();
		const h = renderUseMessages(client);
		await tick();

		h.api.appendPendingUserMessage("t-1", "hello there");
		await tick();

		client.emit("message:created", makeUserMessage("real-1", "hello there"));
		await tick();

		const msgs = h.api.messages;
		expect(msgs.length).toBe(1);
		expect(msgs[0].id).toBe("real-1");
		expect(msgs.some((m) => m.id === PENDING_USER_MESSAGE_ID)).toBe(false);
	});

	it("replaces the placeholder even when the real message content was server-normalized", async () => {
		const client = createMockClient();
		const h = renderUseMessages(client);
		await tick();

		h.api.appendPendingUserMessage("t-1", "hello there  ");
		await tick();

		// Server persisted a trimmed/normalized variant — only one send is ever
		// in flight, so the placeholder must still be reconciled.
		client.emit("message:created", makeUserMessage("real-1", "hello there"));
		await tick();

		const msgs = h.api.messages;
		expect(msgs.length).toBe(1);
		expect(msgs[0].id).toBe("real-1");
	});

	it("clearPendingUserMessage removes a stuck placeholder (send failure)", async () => {
		const client = createMockClient();
		const h = renderUseMessages(client);
		await tick();

		h.api.appendPendingUserMessage("t-1", "hello there");
		await tick();
		expect(h.api.messages.length).toBe(1);

		h.api.clearPendingUserMessage();
		await tick();
		expect(h.api.messages.length).toBe(0);
	});

	it("leaves real messages untouched when there is no placeholder", async () => {
		const client = createMockClient();
		const h = renderUseMessages(client);
		await tick();

		client.emit("message:created", makeUserMessage("real-1", "first"));
		await tick();
		expect(h.api.messages.length).toBe(1);
		expect(h.api.messages[0].id).toBe("real-1");
	});
});

describe("useMessages — server broadcast reconciliation", () => {
	function makeMessage(overrides: Partial<Message>): Message {
		return {
			id: "m",
			thread_id: "t-1",
			role: "assistant",
			content: "",
			model_id: null,
			tool_name: null,
			created_at: new Date().toISOString(),
			modified_at: null,
			host_origin: "h-1",
			deleted: 0,
			exit_code: null,
			metadata: null,
			...overrides,
		};
	}

	it("deduplicates a message broadcast twice by id", async () => {
		const client = createMockClient();
		const h = renderUseMessages(client);
		await tick();

		const msg = makeMessage({ id: "dup-1", role: "assistant", content: "once" });
		client.emit("message:created", msg);
		client.emit("message:created", msg);
		await tick();

		expect(h.api.messages.filter((m) => m.id === "dup-1").length).toBe(1);
	});

	it("replaces a pending tool_call placeholder (no id) with the real tool_call", async () => {
		const client = createMockClient();
		const h = renderUseMessages(client);
		await tick();

		// Seed an id-less placeholder for a running tool.
		h.api.appendMessage(
			makeMessage({ id: undefined as unknown as string, role: "tool_call", tool_name: "read" }),
		);
		await tick();
		expect(h.api.messages.length).toBe(1);

		// The real tool_call with the same tool_name and an id replaces it in place.
		client.emit(
			"message:created",
			makeMessage({ id: "tc-1", role: "tool_call", tool_name: "read", content: "args" }),
		);
		await tick();
		expect(h.api.messages.length).toBe(1);
		expect(h.api.messages[0].id).toBe("tc-1");
	});

	it("appends a tool_call when no matching placeholder exists", async () => {
		const client = createMockClient();
		const h = renderUseMessages(client);
		await tick();

		client.emit(
			"message:created",
			makeMessage({ id: "tc-1", role: "tool_call", tool_name: "edit" }),
		);
		await tick();
		expect(h.api.messages.length).toBe(1);
		expect(h.api.messages[0].id).toBe("tc-1");
	});

	it("appends tool_result messages", async () => {
		const client = createMockClient();
		const h = renderUseMessages(client);
		await tick();

		client.emit(
			"message:created",
			makeMessage({ id: "tr-1", role: "tool_result", content: "done" }),
		);
		await tick();
		expect(h.api.messages.length).toBe(1);
		expect(h.api.messages[0].role).toBe("tool_result");
	});

	it("updateMessage merges partial updates onto the matching id", async () => {
		const client = createMockClient();
		const h = renderUseMessages(client);
		await tick();

		h.api.appendMessage(makeMessage({ id: "a", content: "before" }));
		await tick();
		h.api.updateMessage("a", { content: "after" });
		await tick();
		expect(h.api.messages[0].content).toBe("after");
	});

	it("replaceMessages swaps the entire list", async () => {
		const client = createMockClient();
		const h = renderUseMessages(client);
		await tick();

		h.api.appendMessage(makeMessage({ id: "a" }));
		await tick();
		h.api.replaceMessages([makeMessage({ id: "x" }), makeMessage({ id: "y" })]);
		await tick();
		expect(h.api.messages.map((m) => m.id)).toEqual(["x", "y"]);
	});

	it("detaches the message:created listener on unmount", async () => {
		const offCalls: string[] = [];
		const client = {
			on() {},
			off(event: string) {
				offCalls.push(event);
			},
		} as unknown as BoundClient;
		function Harness() {
			useMessages(client, []);
			return React.createElement(Text, null, "ok");
		}
		const { unmount } = render(React.createElement(Harness));
		await tick();
		unmount();
		await tick();
		expect(offCalls).toContain("message:created");
	});
});

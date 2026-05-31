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

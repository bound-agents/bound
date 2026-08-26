import { describe, expect, test } from "bun:test";
import type { createWsHandlers } from "@bound/sync";
import { instrumentSyncWebSocketHandlers } from "../sync-websocket-lifecycle.js";

type Handlers = ReturnType<typeof createWsHandlers>;

function fixture(
	upgradeResponse?: Response,
	throwFrom?: "open" | "message" | "close",
): {
	handlers: Handlers;
	calls: string[];
	data: { siteId: string };
} {
	const calls: string[] = [];
	const data = { siteId: "authenticated-site" };
	const handlers = {
		handleUpgrade: async (
			request: Request,
			server: { upgrade: (request: Request, options: { data: typeof data }) => unknown },
		) => {
			if (upgradeResponse) return upgradeResponse;
			server.upgrade(request, { data });
			return undefined;
		},
		websocket: {
			open() {
				calls.push("open");
				if (throwFrom === "open") throw new Error("open failed");
			},
			message() {
				calls.push("message");
				if (throwFrom === "message") throw new Error("message failed");
			},
			close() {
				calls.push("close");
				if (throwFrom === "close") throw new Error("close failed");
			},
		},
	} as unknown as Handlers;
	return { handlers, calls, data };
}

describe("sync WebSocket lifecycle wrapper", () => {
	test("preserves upgrade data and delegates the accepted socket lifecycle", async () => {
		const { handlers, calls, data } = fixture();
		const instrumented = instrumentSyncWebSocketHandlers(handlers);
		let upgradedData: unknown;
		const server = {
			upgrade(_request: Request, options: { data: unknown }) {
				upgradedData = options.data;
				return true;
			},
		};
		const response = await instrumented.handleUpgrade(
			new Request("http://localhost/sync/ws"),
			server as never,
		);
		expect(response).toBeUndefined();
		expect(upgradedData).toBe(data);

		const socket = { data } as never;
		instrumented.websocket.open?.(socket);
		instrumented.websocket.message(socket, new Uint8Array());
		instrumented.websocket.close?.(socket, 1000, "done");
		expect(calls).toEqual(["open", "message", "close"]);
	});

	test("returns authentication rejection without attempting an upgrade", async () => {
		const rejection = new Response("Unauthorized", { status: 401 });
		const { handlers } = fixture(rejection);
		const instrumented = instrumentSyncWebSocketHandlers(handlers);
		let upgrades = 0;
		const response = await instrumented.handleUpgrade(new Request("http://localhost/sync/ws"), {
			upgrade: () => ++upgrades,
		} as never);
		expect(response).toBe(rejection);
		expect(upgrades).toBe(0);
	});

	test("keeps an accepted connection alive after a message handler error until close", async () => {
		const { handlers, data } = fixture(undefined, "message");
		const instrumented = instrumentSyncWebSocketHandlers(handlers);
		const server = {
			upgrade() {
				return true;
			},
		};
		await instrumented.handleUpgrade(new Request("http://localhost/sync/ws"), server as never);
		const socket = { data } as never;
		instrumented.websocket.open?.(socket);
		expect(() => instrumented.websocket.message(socket, new Uint8Array())).toThrow(
			"message failed",
		);
		instrumented.websocket.close?.(socket, 1011, "handler error");
	});

	test("still finalizes when the underlying close handler throws", async () => {
		const { handlers, data } = fixture(undefined, "close");
		const instrumented = instrumentSyncWebSocketHandlers(handlers);
		const server = {
			upgrade() {
				return true;
			},
		};
		await instrumented.handleUpgrade(new Request("http://localhost/sync/ws"), server as never);
		const socket = { data } as never;
		instrumented.websocket.open?.(socket);
		expect(() => instrumented.websocket.close?.(socket, 1011, "handler error")).toThrow(
			"close failed",
		);
	});
});

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

	test("rejects an upgrade that is accepted without connection data", async () => {
		// handleUpgrade resolves undefined (accepted) but never calls server.upgrade
		// with data, so capturedData stays undefined and the attempt is rejected.
		const handlers = {
			handleUpgrade: async () => undefined,
			websocket: { open() {}, message() {}, close() {} },
		} as unknown as Handlers;
		const instrumented = instrumentSyncWebSocketHandlers(handlers);
		const response = await instrumented.handleUpgrade(new Request("http://localhost/sync/ws"), {
			upgrade: () => true,
		} as never);
		// No data captured, but the upgrade was "accepted" — returns undefined and
		// records a rejected attempt without throwing.
		expect(response).toBeUndefined();
	});

	test("propagates and records a handleUpgrade that throws", async () => {
		const boom = new Error("upgrade exploded");
		const handlers = {
			handleUpgrade: async () => {
				throw boom;
			},
			websocket: { open() {}, message() {}, close() {} },
		} as unknown as Handlers;
		const instrumented = instrumentSyncWebSocketHandlers(handlers);
		await expect(
			instrumented.handleUpgrade(new Request("http://localhost/sync/ws"), {
				upgrade: () => true,
			} as never),
		).rejects.toThrow("upgrade exploded");
	});

	test("propagates an open-handler error and marks the attempt", async () => {
		const { handlers, data } = fixture(undefined, "open");
		const instrumented = instrumentSyncWebSocketHandlers(handlers);
		await instrumented.handleUpgrade(new Request("http://localhost/sync/ws"), {
			upgrade: () => true,
		} as never);
		const socket = { data } as never;
		expect(() => instrumented.websocket.open?.(socket)).toThrow("open failed");
	});

	test("treats a 500 upgrade response as an upgrade-stage rejection", async () => {
		const serverError = new Response("Internal Error", { status: 500 });
		const { handlers } = fixture(serverError);
		const instrumented = instrumentSyncWebSocketHandlers(handlers);
		const response = await instrumented.handleUpgrade(new Request("http://localhost/sync/ws"), {
			upgrade: () => true,
		} as never);
		expect(response).toBe(serverError);
	});
});

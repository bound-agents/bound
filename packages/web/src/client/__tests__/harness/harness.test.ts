import { afterAll, describe, expect, it } from "bun:test";
import { FakeWebSocket, installDom } from "./dom";

const dom = installDom({ url: "http://localhost/#/" });
afterAll(() => dom.teardown());

describe("render harness", () => {
	it("mounts a component that calls the API on mount and renders the result", async () => {
		dom.route("GET", "/api/advisories/count", () => ({ count: 7 }));
		const TopBar = (await import("../../components/TopBar.svelte")).default;
		const { target, unmount } = await dom.mount(TopBar, {});
		await dom.settle();
		expect(dom.requests.some((r) => r.path === "/api/advisories/count")).toBe(true);
		expect(target.textContent).toContain("System Map");
		expect(target.textContent).toContain("7");
		unmount();
		expect(target.isConnected).toBe(false);
	});

	it("answers unmatched routes with 404 and records the request", async () => {
		const res = await fetch("/api/nope", { method: "POST", body: JSON.stringify({ a: 1 }) });
		expect(res.status).toBe(404);
		expect(dom.requests.at(-1)).toEqual({ method: "POST", path: "/api/nope", body: { a: 1 } });
	});

	it("provides a drivable fake WebSocket", () => {
		const ws = new WebSocket("ws://localhost/ws") as unknown as FakeWebSocket;
		const seen: string[] = [];
		ws.onmessage = (e) => seen.push(e.data);
		ws.open();
		ws.receive({ type: "x" });
		expect(ws.readyState).toBe(FakeWebSocket.OPEN);
		expect(seen).toEqual(['{"type":"x"}']);
	});
});

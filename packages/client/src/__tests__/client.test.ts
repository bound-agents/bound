import { describe, expect, it, vi } from "bun:test";
import { BoundClient } from "../client";

describe("BoundClient connection state machine", () => {
	it("does not re-emit 'connection:state' for no-op transitions", () => {
		const client = new BoundClient("http://localhost:3001");
		const transitions: string[] = [];
		client.on("connection:state", (state) => {
			transitions.push(state);
		});

		const setState = (
			client as unknown as { setConnectionState(s: string): void }
		).setConnectionState.bind(client);

		setState("connecting");
		setState("connecting"); // duplicate — must not re-fire
		setState("connected");
		setState("connected"); // duplicate — must not re-fire

		expect(transitions).toEqual(["connecting", "connected"]);
	});
});

describe("BoundClient sendMessage", () => {
	it("sends every uploaded attachment id in one message", () => {
		const client = new BoundClient("http://localhost:3001");
		const send = vi.fn();
		(client as unknown as { sendWsMessage: typeof send }).sendWsMessage = send;
		client.sendMessage("thread-1", "hello", { fileIds: ["first", "second"] });
		expect(send).toHaveBeenCalledWith(expect.objectContaining({ file_ids: ["first", "second"] }));
	});
});

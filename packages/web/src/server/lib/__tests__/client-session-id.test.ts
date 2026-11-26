import { describe, expect, it } from "bun:test";
import { formatClientSessionId, parseClientSessionId } from "../client-session-id";

describe("client session id", () => {
	it("round-trips connection and thread ids", () => {
		const id = formatClientSessionId("conn-1", "thread-1");
		expect(id).toBe("conn-1::thread-1");
		expect(parseClientSessionId(id)).toEqual({ connectionId: "conn-1", threadId: "thread-1" });
	});

	it("treats an id without a separator as a bare connection id", () => {
		expect(parseClientSessionId("conn-1")).toEqual({ connectionId: "conn-1", threadId: "" });
	});
});

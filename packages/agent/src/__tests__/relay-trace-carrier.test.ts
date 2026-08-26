import { describe, expect, it } from "bun:test";
import { serializeRelayTraceCarrier } from "../relay-router.js";

describe("serializeRelayTraceCarrier", () => {
	it("keeps only valid bounded W3C trace headers", () => {
		const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
		const tracestate = `vendor=${"x".repeat(600)}`;

		const serialized = serializeRelayTraceCarrier({
			traceparent,
			tracestate,
			baggage: "user.id=private",
			unrelated: "do-not-relay",
		});

		expect(serialized).not.toBeNull();
		const carrier = JSON.parse(serialized ?? "{}") as Record<string, string>;
		expect(carrier).toEqual({
			traceparent,
			tracestate: tracestate.slice(0, 512),
		});
	});

	it.each([
		"00-00000000000000000000000000000000-b7ad6b7169203331-01",
		"00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01",
		"00-not-a-trace-id-b7ad6b7169203331-01",
	])("rejects malformed or zero trace IDs: %s", (traceparent) => {
		expect(serializeRelayTraceCarrier({ traceparent })).toBeNull();
	});
});

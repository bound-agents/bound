import { afterEach, describe, expect, it } from "bun:test";
import {
	recordChangeLogPostcommitEvent,
	recordChangeLogTransaction,
	recordRelayOutboxOperation,
	setCoreTelemetry,
	withCoreSpan,
} from "../telemetry";
const noop = { add() {} };
const noopSpan = {
	addEvent() {},
	recordException() {},
	setAttribute() {},
	setStatus() {},
	end() {},
};
afterEach(() =>
	setCoreTelemetry({
		changeLogTransactions: noop,
		changeLogPostcommitEvents: noop,
		relayOutboxOperations: noop,
		startSpan: () => noopSpan,
	}),
);

describe("core telemetry", () => {
	it("records bounded change-log and relay-outbox attributes", () => {
		const calls: unknown[] = [];
		setCoreTelemetry({
			changeLogTransactions: { add: (value, attributes) => calls.push({ value, attributes }) },
			changeLogPostcommitEvents: { add: (value, attributes) => calls.push({ value, attributes }) },
			relayOutboxOperations: { add: (value, attributes) => calls.push({ value, attributes }) },
			startSpan: () => noopSpan,
		});
		recordChangeLogTransaction("committed");
		recordChangeLogPostcommitEvent("failed");
		recordRelayOutboxOperation("read", "hit", 2);
		expect(calls).toEqual([
			{ value: 1, attributes: { outcome: "committed" } },
			{ value: 1, attributes: { outcome: "failed" } },
			{ value: 2, attributes: { operation: "read", outcome: "hit" } },
		]);
	});

	it("creates one outer span and records aggregate events", () => {
		const events: unknown[] = [];
		let ended = 0;
		setCoreTelemetry({
			changeLogTransactions: noop,
			changeLogPostcommitEvents: noop,
			relayOutboxOperations: noop,
			startSpan: (name) => ({
				addEvent: (event, attributes) => events.push({ name, event, attributes }),
				recordException() {},
				end: () => ended++,
			}),
		});
		withCoreSpan("changelog.transaction", (span) => span.addEvent("committed", { entry_count: 1 }));
		expect(events).toEqual([
			{ name: "changelog.transaction", event: "committed", attributes: { entry_count: 1 } },
		]);
		expect(ended).toBe(1);
	});

	it("exports bounded attribution on detached relay-outbox root spans", () => {
		const starts: unknown[] = [];
		setCoreTelemetry({
			changeLogTransactions: noop,
			changeLogPostcommitEvents: noop,
			relayOutboxOperations: noop,
			relayOutboxOperationDuration: { record() {} },
			startSpan: (name, attributes) => {
				starts.push({ name, attributes });
				return noopSpan;
			},
		});

		withCoreSpan(
			"relay_outbox.operation",
			{
				"relay.trigger": "push-write",
				"relay.path": "outbox.write",
				"relay.direction": "outbound",
				"relay.kind": "tool_call",
				"relay.carrier_state": "absent",
				"relay.entry_count": 1,
			},
			() => undefined,
		);

		expect(starts).toEqual([
			{
				name: "relay_outbox.operation",
				attributes: {
					"relay.trigger": "push-write",
					"relay.path": "outbox.write",
					"relay.direction": "outbound",
					"relay.kind": "tool_call",
					"relay.carrier_state": "absent",
					"relay.entry_count": 1,
				},
			},
		]);
	});
});

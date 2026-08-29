import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { TypedEventEmitter } from "@bound/shared";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { setSyncTelemetry, startConsistencyServing } from "../telemetry.js";
import { WsMessageType, decodeFrame } from "../ws-frames.js";
import { WsTransport } from "../ws-transport.js";

const key = new Uint8Array(32).fill(9);

function createDb(): Database {
	const db = new Database(":memory:");
	db.run(`CREATE TABLE semantic_memory (
		id TEXT PRIMARY KEY, key TEXT NOT NULL, value TEXT NOT NULL, source TEXT,
		created_at TEXT NOT NULL, modified_at TEXT NOT NULL, last_accessed_at TEXT,
		tier TEXT DEFAULT 'default', deleted INTEGER DEFAULT 0
	)`);
	return db;
}

function configureExporter(): { exporter: InMemorySpanExporter; provider: BasicTracerProvider } {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider();
	provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
	provider.register({ contextManager: new AsyncLocalStorageContextManager() });
	setSyncTelemetry({
		handshakes: { add() {} },
		drains: { add() {} },
		drainedEntries: { add() {} },
		drainDuration: { record() {} },
		activeConnections: { add() {} },
		startSpan: (name, attributes, parentContext) =>
			trace.getTracer("bound.sync").startSpan(name, { attributes }, parentContext),
	});
	return { exporter, provider };
}

afterEach(() => {
	setSyncTelemetry();
	trace.disable();
});

describe("consistency serving telemetry", () => {
	it("carries the spoke consistency parent through hub serving completion", async () => {
		const { exporter, provider } = configureExporter();
		const hubDb = createDb();
		hubDb.run(
			"INSERT INTO semantic_memory (id, key, value, created_at, modified_at) VALUES ('m1', 'k', 'v', 'now', 'now')",
		);
		const spokeDb = createDb();
		const hub = new WsTransport({
			db: hubDb,
			siteId: "hub",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});
		const spoke = new WsTransport({
			db: spokeDb,
			siteId: "spoke",
			eventBus: new TypedEventEmitter(),
		});
		try {
			let forwardedTraceData: string | undefined;
			hub.addPeer(
				"spoke",
				(frame) => {
					const decoded = decodeFrame(frame, key);
					if (decoded.ok && decoded.value.type === WsMessageType.CONSISTENCY_RESPONSE) {
						forwardedTraceData = decoded.value.payload.trace_data;
						spoke.handleConsistencyResponse(decoded.value.payload);
					}
					return true;
				},
				key,
			);
			spoke.addPeer(
				"hub",
				(frame) => {
					const decoded = decodeFrame(frame, key);
					if (decoded.ok && decoded.value.type === WsMessageType.CONSISTENCY_REQUEST)
						setTimeout(() => hub.handleConsistencyRequest("spoke", decoded.value.payload), 0);
					return true;
				},
				key,
			);

			const parent = trace.getTracer("test").startSpan("sync.consistency");
			await context.with(trace.setSpan(context.active(), parent), () =>
				spoke.requestConsistency(["semantic_memory"]),
			);
			parent.end();
			const serving = exporter
				.getFinishedSpans()
				.find((span) => span.name === "sync.consistency.serve");
			// The hub's request-scoped collector is distinct from the global/spoke exporter.
			expect(serving).toBeUndefined();
			const hubScoped = JSON.parse(forwardedTraceData ?? "[]") as Array<{
				attributes: Record<string, unknown>;
			}>;
			expect(hubScoped).toHaveLength(1);
			expect(hubScoped[0]?.attributes).toMatchObject({
				"consistency.serve.page_count": 1,
				"consistency.serve.frame_count": 1,
				"consistency.serve.terminal": "all_done",
			});
		} finally {
			spoke.stop();
			hub.stop();
			spokeDb.close();
			hubDb.close();
			provider.shutdown();
		}
	});

	it("keeps the serving span open across backpressure until drain resumes", async () => {
		const { exporter, provider } = configureExporter();
		const hubDb = createDb();
		for (let i = 0; i < 10_001; i++)
			hubDb.run(
				"INSERT INTO semantic_memory (id, key, value, created_at, modified_at) VALUES (?, ?, 'v', 'now', 'now')",
				[`m${i}`, `k${i}`],
			);
		const hub = new WsTransport({
			db: hubDb,
			siteId: "hub",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});
		let sends = 0;
		let forwardedTraceData: string | undefined;
		try {
			hub.addPeer(
				"spoke",
				(frame) => {
					if (++sends === 2) return false;
					const decoded = decodeFrame(frame, key);
					if (decoded.ok && decoded.value.type === WsMessageType.CONSISTENCY_RESPONSE)
						forwardedTraceData = decoded.value.payload.trace_data;
					return true;
				},
				key,
			);
			hub.handleConsistencyRequest("spoke", {
				tables: ["semantic_memory"],
				trace_context: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
			});
			await new Promise((resolve) => setTimeout(resolve, 5));
			hub.addPeer(
				"spoke",
				(frame) => {
					const decoded = decodeFrame(frame, key);
					if (decoded.ok && decoded.value.type === WsMessageType.CONSISTENCY_RESPONSE)
						forwardedTraceData = decoded.value.payload.trace_data;
					return true;
				},
				key,
			);
			hub.continueConsistencyStream("spoke");
			await new Promise((resolve) => setTimeout(resolve, 10));
			const serving = exporter
				.getFinishedSpans()
				.find((span) => span.name === "sync.consistency.serve");
			// Continuation telemetry belongs to the independent hub-scoped collector.
			expect(serving).toBeUndefined();
			const hubScoped = JSON.parse(forwardedTraceData ?? "[]") as Array<{
				attributes: Record<string, number>;
			}>;
			expect(hubScoped).toHaveLength(1);
			expect(hubScoped[0]?.attributes["consistency.serve.page_count"]).toBeGreaterThanOrEqual(2);
			expect(
				hubScoped[0]?.attributes["consistency.serve.drain_resume_count"],
			).toBeGreaterThanOrEqual(1);
			expect(
				hubScoped[0]?.attributes["consistency.serve.backpressure_duration_ms"],
			).toBeGreaterThanOrEqual(0);
		} finally {
			hub.stop();
			hubDb.close();
			provider.shutdown();
		}
	});

	it("fails exactly once when a resumed stream throws in its continuation", async () => {
		const { exporter, provider } = configureExporter();
		const hubDb = createDb();
		hubDb.run(
			"INSERT INTO semantic_memory (id, key, value, created_at, modified_at) VALUES ('m1', 'k', 'v', 'now', 'now')",
		);
		const hub = new WsTransport({
			db: hubDb,
			siteId: "hub",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});
		try {
			hub.addPeer("spoke", () => false, key);
			hub.handleConsistencyRequest("spoke", { tables: ["semantic_memory", "tasks"] });
			hub.addPeer("spoke", () => true, key);
			hub.continueConsistencyStream("spoke");
			await new Promise((resolve) => setTimeout(resolve, 10));

			const serving = exporter
				.getFinishedSpans()
				.filter((span) => span.name === "sync.consistency.serve");
			expect(serving).toHaveLength(1);
			expect(serving[0]?.status.code).toBe(2);
			expect(serving[0]?.attributes["consistency.serve.terminal"]).toBe("error");
			expect(
				serving[0]?.events.filter((event) => event.name === "sync.consistency.serve.error"),
			).toHaveLength(1);
		} finally {
			hub.stop();
			hubDb.close();
			provider.shutdown();
		}
	});

	it("caps repetitive serving events while retaining aggregate totals", () => {
		const { exporter, provider } = configureExporter();
		try {
			const serving = startConsistencyServing();
			serving.requestReceived();
			for (let index = 0; index < 20; index++) {
				serving.page({ queryMs: 1_001, encodeMs: 1_002, sendMs: 1_003, rows: 2, tableIndex: 0 });
				serving.backpressured();
				serving.resumed(10);
			}
			serving.complete("all_done");

			const span = exporter
				.getFinishedSpans()
				.find((finished) => finished.name === "sync.consistency.serve");
			const eventCount = (name: string) =>
				span?.events.filter((event) => event.name === name).length;
			expect(eventCount("sync.consistency.serve.slow_query")).toBeLessThanOrEqual(3);
			expect(eventCount("sync.consistency.serve.slow_encode")).toBeLessThanOrEqual(3);
			expect(eventCount("sync.consistency.serve.slow_send")).toBeLessThanOrEqual(3);
			expect(eventCount("sync.consistency.serve.send_backpressure")).toBeLessThanOrEqual(3);
			expect(eventCount("sync.consistency.serve.drain_resume")).toBeLessThanOrEqual(3);
			expect(span?.attributes).toMatchObject({
				"consistency.serve.page_count": 20,
				"consistency.serve.row_count": 40,
				"consistency.serve.query_duration_ms": 20_020,
				"consistency.serve.encode_duration_ms": 20_040,
				"consistency.serve.send_duration_ms": 20_060,
				"consistency.serve.backpressure_duration_ms": 200,
				"consistency.serve.drain_resume_count": 20,
				"consistency.serve.terminal": "all_done",
			});
		} finally {
			provider.shutdown();
		}
	});
});

describe("terminal errors", () => {
	it("ends the serving span with an error when a requested table cannot be served", () => {
		const { exporter, provider } = configureExporter();
		const hubDb = createDb();
		const hub = new WsTransport({
			db: hubDb,
			siteId: "hub",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});
		try {
			hub.addPeer("spoke", () => true, key);
			expect(() => hub.handleConsistencyRequest("spoke", { tables: ["tasks"] })).toThrow();
			const serving = exporter
				.getFinishedSpans()
				.find((span) => span.name === "sync.consistency.serve");
			expect(serving?.status.code).toBe(2);
			expect(serving?.events.some((event) => event.name === "sync.consistency.serve.error")).toBe(
				true,
			);
		} finally {
			hub.stop();
			hubDb.close();
			provider.shutdown();
		}
	});
});

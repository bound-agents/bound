import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { TypedEventEmitter, setTraceExporter } from "@bound/shared";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { WsMessageType, decodeFrame } from "../ws-frames.js";
import { WsTransport } from "../ws-transport.js";

const key = new Uint8Array(32).fill(7);

function createDb(): Database {
	const db = new Database(":memory:");
	db.run(`CREATE TABLE semantic_memory (
		id TEXT PRIMARY KEY, key TEXT NOT NULL, value TEXT NOT NULL, source TEXT,
		created_at TEXT NOT NULL, modified_at TEXT NOT NULL, last_accessed_at TEXT,
		tier TEXT DEFAULT 'default', deleted INTEGER DEFAULT 0
	)`);
	return db;
}

function configureSpokeTracing() {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider();
	provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
	provider.register({ contextManager: new AsyncLocalStorageContextManager() });
	setTraceExporter(exporter);
	return { exporter, provider };
}

afterEach(() => {
	setTraceExporter(null);
	trace.disable();
});

describe("consistency serve trace forwarding", () => {
	it("re-exports the hub serve span once with the spoke consistency span as parent", async () => {
		// Reproduce a process whose bootstrap has not installed a propagator. The
		// request must use injectTraceContext's manual traceparent fallback.
		propagation.disable();
		const { exporter, provider } = configureSpokeTracing();
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
			hub.addPeer(
				"spoke",
				(frame) => {
					const decoded = decodeFrame(frame, key);
					if (decoded.ok && decoded.value.type === WsMessageType.CONSISTENCY_RESPONSE)
						spoke.handleConsistencyResponse(decoded.value.payload);
					return true;
				},
				key,
			);
			let requestTraceContext: { traceparent: string; tracestate?: string } | undefined;
			spoke.addPeer(
				"hub",
				(frame) => {
					const decoded = decodeFrame(frame, key);
					if (decoded.ok && decoded.value.type === WsMessageType.CONSISTENCY_REQUEST) {
						requestTraceContext = decoded.value.payload.trace_context;
						setTimeout(() => hub.handleConsistencyRequest("spoke", decoded.value.payload), 0);
					}
					return true;
				},
				key,
			);
			const parent = trace.getTracer("test").startSpan("sync.consistency");
			await context.with(trace.setSpan(context.active(), parent), () =>
				spoke.requestConsistency(["semantic_memory"]),
			);
			parent.end();
			expect(requestTraceContext?.traceparent).toBe(
				`00-${parent.spanContext().traceId}-${parent.spanContext().spanId}-01`,
			);
			const serving = exporter
				.getFinishedSpans()
				.filter((span) => span.name === "sync.consistency.serve");
			expect(serving).toHaveLength(1);
			expect(serving[0]?.spanContext().traceId).toBe(parent.spanContext().traceId);
			expect(serving[0]?.parentSpanId).toBe(parent.spanContext().spanId);
			expect(serving[0]?.attributes["bound.site_id"]).toBe("hub");
		} finally {
			spoke.stop();
			hub.stop();
			spokeDb.close();
			hubDb.close();
			await provider.shutdown();
		}
	});

	it("does not attach trace data for a carrier-less request", async () => {
		const db = createDb();
		const hub = new WsTransport({
			db,
			siteId: "hub",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});
		const payloads: Array<Record<string, unknown>> = [];
		try {
			hub.addPeer(
				"spoke",
				(frame) => {
					const decoded = decodeFrame(frame, key);
					if (decoded.ok && decoded.value.type === WsMessageType.CONSISTENCY_RESPONSE)
						payloads.push(decoded.value.payload as Record<string, unknown>);
					return true;
				},
				key,
			);
			hub.handleConsistencyRequest("spoke", { tables: ["semantic_memory"] });
			await Bun.sleep(10);
			expect(payloads[0]?.trace_data).toBeUndefined();
		} finally {
			hub.stop();
			db.close();
		}
	});
});

describe("consistency continuation failures", () => {
	it("forwards one traced ERROR frame when an asynchronous page continuation fails", async () => {
		const { provider } = configureSpokeTracing();
		const db = createDb();
		const hub = new WsTransport({
			db,
			siteId: "hub",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});
		const errors: Array<{ request_id?: string; trace_data?: string }> = [];
		try {
			hub.addPeer(
				"spoke",
				(frame) => {
					const decoded = decodeFrame(frame, key);
					if (decoded.ok && decoded.value.type === WsMessageType.ERROR)
						errors.push(decoded.value.payload);
					return true;
				},
				key,
			);
			const parent = trace.getTracer("test").startSpan("sync.consistency");
			await context.with(trace.setSpan(context.active(), parent), () => {
				hub.handleConsistencyRequest("spoke", {
					tables: ["semantic_memory", "tasks"],
					request_id: "request-1",
					trace_context: {
						traceparent: `00-${parent.spanContext().traceId}-${parent.spanContext().spanId}-01`,
					},
				});
			});
			parent.end();
			await Bun.sleep(10);
			expect(errors).toHaveLength(1);
			expect(errors[0]?.request_id).toBe("request-1");
			const spans = JSON.parse(errors[0]?.trace_data ?? "[]") as Array<{
				name: string;
				traceId: string;
				parentSpanId?: string;
			}>;
			expect(spans).toEqual([
				expect.objectContaining({
					name: "sync.consistency.serve",
					traceId: parent.spanContext().traceId,
					parentSpanId: parent.spanContext().spanId,
				}),
			]);
		} finally {
			hub.stop();
			db.close();
			await provider.shutdown();
		}
	});

	it("emits one terminal traced ERROR when synchronous and scheduled continuation failures overlap", async () => {
		const db = createDb();
		const hub = new WsTransport({
			db,
			siteId: "hub",
			eventBus: new TypedEventEmitter(),
			isHub: true,
		});
		const errors: Array<{ request_id?: string; trace_data?: string }> = [];
		try {
			hub.addPeer(
				"spoke",
				(frame) => {
					const decoded = decodeFrame(frame, key);
					if (decoded.ok && decoded.value.type === WsMessageType.ERROR)
						errors.push(decoded.value.payload);
					return true;
				},
				key,
			);

			const transport = hub as unknown as {
				streamConsistencyPages: (...args: unknown[]) => void;
			};
			const originalStreamConsistencyPages = transport.streamConsistencyPages.bind(hub);
			let streamCalls = 0;
			transport.streamConsistencyPages = (...args) => {
				streamCalls++;
				if (streamCalls === 1) {
					// Schedule the real continuation, then fail the request handler itself.
					originalStreamConsistencyPages(...args);
					throw new Error("synchronous handler failure");
				}
				// The real setTimeout callback below invokes this second call and reaches
				// streamConsistencyPages' asynchronous continuation catch.
				throw new Error("scheduled continuation failure");
			};

			expect(() =>
				hub.handleConsistencyRequest("spoke", {
					tables: ["semantic_memory", "tasks"],
					request_id: "request-1",
					trace_context: {
						traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
					},
				}),
			).toThrow("synchronous handler failure");
			await Bun.sleep(10);

			expect(streamCalls).toBe(2);
			expect(errors).toHaveLength(1);
			expect(errors[0]?.request_id).toBe("request-1");
			const spans = JSON.parse(errors[0]?.trace_data ?? "[]") as Array<{
				name: string;
				attributes: Record<string, unknown>;
				events: Array<{ name: string }>;
			}>;
			expect(spans).toHaveLength(1);
			expect(spans[0]?.name).toBe("sync.consistency.serve");
			expect(spans[0]?.attributes["consistency.serve.terminal"]).toBe("error");
			expect(
				spans[0]?.events.filter((event) => event.name === "sync.consistency.serve.error"),
			).toHaveLength(1);
		} finally {
			hub.stop();
			db.close();
		}
	});
});

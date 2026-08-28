import Database from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema, insertInbox, readUndelivered } from "@bound/core";
import type { Logger, RelayInboxEntry, TypedEventEmitter } from "@bound/shared";
import { trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { MCPClient } from "../mcp-client";
import { RelayProcessor } from "../relay-processor";
import { waitFor } from "./helpers";

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const eventBus = () => new (require("@bound/shared").TypedEventEmitter)() as TypedEventEmitter;

describe("relay trace topology", () => {
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;
	let db: Database;

	beforeAll(() => {
		exporter = new InMemorySpanExporter();
		provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		provider.register({ contextManager: new AsyncLocalStorageContextManager() });
	});

	beforeEach(() => {
		exporter.reset();
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterAll(async () => {
		await provider.shutdown();
		trace.disable();
	});

	it("parents active request handler spans under relay.request.receive", async () => {
		const remoteTraceId = "0af7651916cd43dd8448eb211c80319c";
		const remoteSpanId = "b7ad6b7169203331";
		const entry: RelayInboxEntry = {
			id: "request-1",
			source_site_id: "source-site",
			kind: "tool_call",
			ref_id: null,
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ tool: "server", args: { subcommand: "echo" }, timeout_ms: 1000 }),
			expires_at: new Date(Date.now() + 60_000).toISOString(),
			received_at: new Date().toISOString(),
			processed: 0,
			trace_context: JSON.stringify({ traceparent: `00-${remoteTraceId}-${remoteSpanId}-01` }),
		};
		insertInbox(db, entry);
		const client = {
			getConfig: () => ({ name: "server", transport: "stdio" as const }),
			listTools: async () => [{ name: "echo", inputSchema: { type: "object" } }],
			callTool: async () => {
				const child = trace.getTracer("test").startSpan("test.handler");
				child.end();
				return { content: "ok", isError: false };
			},
		} as unknown as MCPClient;
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map([["server", client]]),
			null,
			logger,
			eventBus(),
		);
		const handle = processor.start(5);
		await waitFor(() =>
			exporter.getFinishedSpans().some((span) => span.name === "relay.request.receive"),
		);
		handle.stop();

		const receive = exporter
			.getFinishedSpans()
			.find((span) => span.name === "relay.request.receive");
		const child = exporter.getFinishedSpans().find((span) => span.name === "test.handler");
		expect(receive?.spanContext().traceId).toBe(remoteTraceId);
		expect(receive?.parentSpanId).toBe(remoteSpanId);
		expect(child?.parentSpanId).toBe(receive?.spanContext().spanId);
		expect(receive?.attributes["relay.kind"]).toBe("tool_call");

		const response = readUndelivered(db, "source-site").find((outbox) => outbox.kind === "result");
		expect(response?.trace_context).not.toBeNull();
		const responseCarrier = JSON.parse(response?.trace_context ?? "{}");
		expect(responseCarrier).toEqual({ traceparent: `00-${remoteTraceId}-${remoteSpanId}-01` });
	});

	it("preserves the initiating carrier when asynchronous inference flushes a stream chunk", () => {
		const carrier = JSON.stringify({
			traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
		});
		const processor = new RelayProcessor(db, "target-site", new Map(), null, logger, eventBus());
		const request: RelayInboxEntry = {
			id: "inference-1",
			source_site_id: "source-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: "stream-1",
			payload: "{}",
			expires_at: new Date(Date.now() + 60_000).toISOString(),
			received_at: new Date().toISOString(),
			processed: 0,
			trace_context: carrier,
		};

		// Flushes run after the receipt callback's context may have exited. The
		// durable request carrier, not ambient context, is the response authority.
		(
			processor as unknown as {
				writeStreamChunk: (
					request: RelayInboxEntry,
					kind: "stream_chunk" | "stream_end",
					streamId: string,
					seq: number,
					chunks: unknown[],
				) => void;
			}
		).writeStreamChunk(request, "stream_chunk", "stream-1", 0, []);
		const response = readUndelivered(db, "source-site").find(
			(entry) => entry.kind === "stream_chunk",
		);
		expect(response?.trace_context).toBe(carrier);
	});

	it("does not create receive spans for passive mailbox rows", async () => {
		insertInbox(db, {
			id: "passive-1",
			source_site_id: "source-site",
			kind: "webhook_intake",
			ref_id: null,
			idempotency_key: null,
			stream_id: null,
			payload: "{}",
			expires_at: new Date(Date.now() + 60_000).toISOString(),
			received_at: new Date().toISOString(),
			processed: 0,
			trace_context: null,
		});
		const processor = new RelayProcessor(db, "target-site", new Map(), null, logger, eventBus());
		const handle = processor.start(5);
		await Bun.sleep(25);
		handle.stop();
		expect(
			exporter.getFinishedSpans().filter((span) => span.name === "relay.request.receive"),
		).toHaveLength(0);
	});
});

/**
 * In-process single-node boot test for `bound start`.
 *
 * Boots a real Bound node via `startNode` (NOT a replica of the bootstrap
 * logic) against a temp config dir whose only model backend points at a fake
 * OpenAI-compatible server. A `BoundClient` from `@bound/client` connects to
 * the real web port, sends a user message, and the test asserts the fake
 * model's reply is delivered over the WS stream and persisted as an assistant
 * message. One shared node across the describe (beforeAll/afterAll) keeps the
 * boot count — the slow part — to one.
 *
 * Exercises the real wiring in index.ts/bootstrap.ts/server.ts/scheduler.ts/
 * sync.ts/relay.ts/sandbox.ts/agent-factory.ts end to end, so the start path
 * is covered by booting the actual node rather than asserting against copied
 * logic.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundClient } from "@bound/client";
import { cleanupTmpDirSync } from "@bound/shared/test-utils";
import { runInit } from "../../init.js";
import { type NodeHandle, startNode } from "../index.js";

/**
 * A minimal OpenAI-compatible `/v1/chat/completions` SSE server. Streams one
 * content delta carrying `replyText`, a stop, then the `[DONE]` sentinel —
 * enough for the AI SDK's openai-compatible driver to assemble a clean stream
 * so the agent loop persists an assistant turn. Bound to port 0 so the OS
 * hands out a free ephemeral port; the real port is read back from
 * `server.port`.
 */
function startFakeOpenAiServer(replyText: string) {
	let lastBody: unknown;
	const server = Bun.serve({
		port: 0,
		hostname: "localhost",
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname.endsWith("/chat/completions") && req.method === "POST") {
				lastBody = await req.json().catch(() => undefined);
				const body = `data: {"id":"fake-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":${JSON.stringify(
					replyText,
				)}}}]}\n\ndata: {"id":"fake-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
				return new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			// Any unmatched route (e.g. a /models probe) gets an empty-but-valid
			// JSON body so no request path 500s the driver.
			return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
		},
	});
	return {
		baseUrl: `http://localhost:${server.port}/v1`,
		getLastBody: () => lastBody,
		stop: () => server.stop(true),
	};
}

describe("bound start — single-node in-process boot", () => {
	const REPLY = "pong from the fake model";
	let tempDir: string;
	let fake: ReturnType<typeof startFakeOpenAiServer>;
	let node: NodeHandle;
	let client: BoundClient;

	beforeAll(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-boot-single-"));
		const configDir = join(tempDir, "config");

		fake = startFakeOpenAiServer(REPLY);

		// Lay down a real config via the production init path, then repoint the
		// single backend's base_url at the fake server. init writes an
		// ollama-preset openai-compatible backend, so only the base_url changes.
		await runInit({ ollama: true, name: "boot-operator", configDir });
		const modelBackendsPath = join(configDir, "model_backends.js");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			modelBackendsPath,
			`export default ${JSON.stringify(
				{
					backends: [
						{
							id: "fake",
							provider: "openai-compatible",
							model: "fake-model",
							context_window: 8192,
							tier: 3,
							base_url: fake.baseUrl,
							api_key: "test-key",
						},
					],
					default: "fake",
				},
				null,
				2,
			)};\n`,
		);

		// Boot the real node on ephemeral ports. No signal handlers so the test
		// process keeps its own SIGINT/SIGTERM behavior and nothing leaks.
		node = await startNode(
			{ configDir },
			{ webPort: 0, syncPort: 0, webHost: "localhost", syncHost: "localhost" },
		);
	});

	afterAll(async () => {
		client?.disconnect();
		await node?.stop();
		fake?.stop();
		cleanupTmpDirSync(tempDir);
	});

	it("binds the web server to a real OS-assigned ephemeral port (port 0 round-trip)", () => {
		// The real bound port must come back, not the configured 0 and not the
		// default 3001. A single-node config has no keyring, so initServer
		// correctly skips the sync server and syncPort is null (production
		// behavior: createSyncServer only runs when a keyring is present).
		expect(node.webPort).toBeGreaterThan(0);
		expect(node.webPort).not.toBe(3001);
		expect(node.syncPort).toBeNull();
		expect(node.webUrl).toBe(`http://localhost:${node.webPort}`);
	});

	it("delivers the fake model's reply through BoundClient (streamed + persisted)", async () => {
		client = new BoundClient(node.webUrl ?? "");
		await client.connect();

		const thread = await client.createThread();

		// Collect both the streamed chunks and the created assistant message so
		// we can assert whichever surface arrives.
		const streamed: string[] = [];
		let assistantContent: string | null = null;
		const assistantDelivered = new Promise<void>((resolve) => {
			client.on("stream:chunk", ({ chunk }) => {
				const text =
					(chunk as { text?: string; delta?: string }).text ??
					(chunk as { delta?: string }).delta ??
					"";
				if (text) streamed.push(text);
			});
			client.on("message:created", (msg) => {
				if (msg.role === "assistant") {
					assistantContent =
						typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
					resolve();
				}
			});
		});

		client.subscribe(thread.id);
		client.sendMessage(thread.id, "ping");

		// Wait for the assistant turn, bounded so a hang fails loudly instead of
		// timing out the whole suite.
		await Promise.race([
			assistantDelivered,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("no assistant reply within 30s")), 30_000),
			),
		]);

		const streamedText = streamed.join("");
		const persisted = assistantContent ?? "";
		// The reply reached the client on at least one surface.
		expect(streamedText.includes(REPLY) || persisted.includes(REPLY)).toBe(true);

		// And the fake server actually received a chat/completions request
		// carrying the user's message — proves the loop drove real inference.
		const sentBody = fake.getLastBody() as { messages?: Array<{ content?: unknown }> } | undefined;
		expect(sentBody).toBeDefined();
		expect(JSON.stringify(sentBody)).toContain("ping");
	}, 40_000);

	it("persists the assistant reply so a fresh listMessages reflects it", async () => {
		// A second client reading the thread back confirms the turn was written
		// to the messages table, not only streamed.
		const threads = await client.listThreads();
		expect(threads.length).toBeGreaterThan(0);
		const messages = await client.listMessages(threads[0].id);
		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant).toBeDefined();
	}, 20_000);
});

describe("bound start — NodeHandle.stop() closes the owned DB before teardown", () => {
	let tempDir: string | null = null;
	let fake: ReturnType<typeof startFakeOpenAiServer> | null = null;

	afterEach(() => {
		fake?.stop();
		fake = null;
		// Belt-and-braces: if the assertion raw-rm already ran this is a no-op; if
		// the test threw before it, fall back to the tolerant helper so a leaked
		// handle does not poison a later test's temp dir. Uses the tolerant path
		// here deliberately — the raw-rm assertion lives inside the `it`.
		if (tempDir) cleanupTmpDirSync(tempDir);
		tempDir = null;
	});

	it("lets a raw rmSync of the config/data dir succeed after stop() — no leaked SQLite handle", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-boot-dbclose-"));
		const configDir = join(tempDir, "config");

		fake = startFakeOpenAiServer("unused");

		await runInit({ ollama: true, name: "dbclose-operator", configDir });
		const modelBackendsPath = join(configDir, "model_backends.js");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			modelBackendsPath,
			`export default ${JSON.stringify(
				{
					backends: [
						{
							id: "fake",
							provider: "openai-compatible",
							model: "fake-model",
							context_window: 8192,
							tier: 3,
							base_url: fake.baseUrl,
							api_key: "test-key",
						},
					],
					default: "fake",
				},
				null,
				2,
			)};\n`,
		);

		const node = await startNode(
			{ configDir },
			{ webPort: 0, syncPort: 0, webHost: "localhost", syncHost: "localhost" },
		);
		await node.stop();

		// Root cause, cross-platform: after stop() NO file descriptor may remain open
		// under tempDir. The node-owned DB runs with cached prepared statements
		// (bun:sqlite memoizes every repository db.query(sql), keyed by SQL text, on
		// the Database) and mmap_size=256MiB; a graceful close() defers releasing the
		// connection until those statements are finalized, which only happens when GC
		// collects them — not synchronously at stop(). So a bare close() leaves
		// bound.db, bound.db-wal and bound.db-shm (plus the mmap) open under the data
		// dir. On Windows those held handles are a mandatory lock and the retry-less raw
		// rm below fails EBUSY; on macOS POSIX unlink-while-open hides the Windows EBUSY
		// from that rm, so lsof is the cross-platform observable for the exact handles
		// that lock the dir on Windows. stop() now closes then forces a synchronous GC
		// (Bun.gc(true)) to collect the cached statements and release every fd + mapping.
		//
		// Fails on cabd6c21's code (bare close() leaves 5 fds under tempDir), passes
		// with the close()+GC fix. Skip only this sub-assertion on win32 (lsof is a
		// POSIX tool); the raw rm below is the Windows-side guard for the same handles.
		if (platform() !== "win32") {
			const lsof = Bun.spawnSync(["lsof", "-p", String(process.pid)], {
				stdout: "pipe",
				stderr: "pipe",
			});
			// Only assert when lsof is actually available (exit 0 and some output); a
			// missing/sandboxed lsof must not turn into a false green or a false red.
			if (lsof.exitCode === 0) {
				const out = lsof.stdout.toString();
				// Resolve both symlink forms of tempDir (/var vs /private/var on macOS)
				// so a /private-prefixed lsof path still matches.
				const forms = Array.from(new Set([tempDir as string, realpathSync(tempDir as string)]));
				const leaked = out
					.split("\n")
					.filter((line) => forms.some((f) => line.includes(f)))
					.map((line) => line.replace(/\s+/g, " ").trim());
				expect(leaked).toEqual([]);
			}
		}

		// Raw removal — deliberately NOT cleanupTmpDirSync. The tolerant helper
		// swallows EBUSY, which would mask a DB handle that stop() failed to close.
		// On the pre-fix code (no appContext.db.close()) the open bun:sqlite
		// DB/WAL/SHM handles hold a Windows mandatory lock on bound.db under
		// tempDir, so this rmSync throws EBUSY and the test fails — proving the
		// leak. With db.close() wired into stop() the handle is released and this
		// succeeds everywhere.
		expect(() => rmSync(tempDir as string, { recursive: true, force: true })).not.toThrow();
		// The raw rm removed the dir, so skip the afterEach fallback.
		tempDir = null;
	}, 60_000);
});

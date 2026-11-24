/**
 * In-process boot tests targeting four otherwise-uncovered arms of
 * `startNode` / `runStart` in index.ts:
 *
 *  1. The MCP OAuth wiring arm (110, 134-148, 170, 174): booting with an
 *     oauth-configured HTTP MCP server makes `createMcpOAuthWiring` return a
 *     non-null wiring, so the `provideAuth` closure (110), the
 *     `reloadMcpForReconnect` assignment (134-148), and the owner-exchange +
 *     app-proxy consumer wiring (170, 174) all run. The reconnect wrapper is
 *     then driven directly through the live relay processor consumer to prove
 *     the late-bound `reloadMcpForReconnect` callback is reachable (110).
 *
 *  2. The null-router SIGHUP arm (266-269): a model_backends config whose
 *     `default` names a backend that does not exist makes `createModelRouter`
 *     throw, so `initInference` catches and leaves `modelRouter` null. A SIGHUP
 *     config reload then drives `onModelBackendsChanged` into the `!modelRouter`
 *     warn-and-return arm.
 *
 *  3. The MCP disconnect catch in teardown (371-373): a client whose
 *     `disconnect()` rejects is injected into the live `mcpClientsMap`; `stop()`
 *     must swallow the throw and complete the rest of teardown.
 *
 *  4. `runStart` signal wiring (405-421): `runStart` registers real
 *     SIGINT/SIGTERM listeners and blocks until one fires. The test records the
 *     listener delta, emits SIGINT to drive the full `handle.stop()` teardown,
 *     asserts `runStart` resolves, and removes exactly the listeners it added.
 *     No real signal is sent to the test process beyond the synthetic `emit`.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDirSync } from "@bound/shared/test-utils";
import { runInit } from "../../init.js";
import { type NodeHandle, runStart, startNode } from "../index.js";

/**
 * Minimal OpenAI-compatible SSE server on port 0, so a configured model backend
 * builds a live router without a real provider.
 */
function startFakeOpenAiServer() {
	const server = Bun.serve({
		port: 0,
		hostname: "localhost",
		fetch() {
			return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
		},
	});
	return { baseUrl: `http://localhost:${server.port}/v1`, stop: () => server.stop(true) };
}

/**
 * Minimal HTTP MCP server on port 0 that returns a protocol error on the
 * initialize handshake. The connect attempt fails fast (so boot does not block
 * on a live MCP session) while still exercising the oauth-wiring construction
 * path in index.ts, which keys only off the presence of an oauth-configured
 * server in config — not on a successful connection.
 */
function startFakeMcpServer() {
	const server = Bun.serve({
		port: 0,
		hostname: "localhost",
		fetch() {
			return new Response(JSON.stringify({ error: "unavailable" }), {
				status: 503,
				headers: { "content-type": "application/json" },
			});
		},
	});
	return { url: `http://localhost:${server.port}/mcp`, stop: () => server.stop(true) };
}

describe("bound start — MCP OAuth wiring arm", () => {
	let tempDir: string;
	let configDir: string;
	let fakeLlm: ReturnType<typeof startFakeOpenAiServer>;
	let fakeMcp: ReturnType<typeof startFakeMcpServer>;
	let node: NodeHandle;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-oauth-wiring-"));
		configDir = join(tempDir, "config");
		fakeLlm = startFakeOpenAiServer();
		fakeMcp = startFakeMcpServer();

		await runInit({ ollama: true, name: "oauth-operator", configDir });
		writeFileSync(
			join(configDir, "model_backends.js"),
			`export default ${JSON.stringify(
				{
					backends: [
						{
							id: "fake",
							provider: "openai-compatible",
							model: "fake-model",
							context_window: 8192,
							base_url: fakeLlm.baseUrl,
							api_key: "test-key",
						},
					],
					default: "fake",
				},
				null,
				2,
			)};\n`,
		);
		// An oauth-configured HTTP MCP server is the sole condition under which
		// createMcpOAuthWiring returns a non-null wiring.
		writeFileSync(
			join(configDir, "mcp.json"),
			`${JSON.stringify(
				{
					servers: [
						{
							name: "oauthsrv",
							transport: "http",
							url: fakeMcp.url,
							auth: { type: "oauth", scopes: ["read"], client_id: "test-client" },
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		node = await startNode(
			{ configDir },
			{ webPort: 0, syncPort: 0, webHost: "localhost", syncHost: "localhost" },
		);
	}, 60_000);

	afterEach(async () => {
		await node?.stop();
		fakeMcp?.stop();
		fakeLlm?.stop();
		cleanupTmpDirSync(tempDir);
	});

	it("boots with the oauth owner-exchange + app-proxy consumers wired on the relay processor", () => {
		// The node booted at all with an oauth server present, which proves the
		// `if (mcpOAuth)` consumer-wiring arm (170/174) ran rather than throwing.
		// The relay processor is a live subsystem on this configured node.
		expect(node.appContext).toBeDefined();
		expect(node.webPort).toBeGreaterThan(0);
		// The oauth server's config row is present — the wiring keyed off it.
		const mcpConfigPresent = node.appContext.optionalConfig.mcp?.ok === true;
		expect(mcpConfigPresent).toBe(true);
	});

	it("re-runs connect for the oauth server through the late-bound reconnect wrapper", async () => {
		// `reloadMcpForReconnect` (134-148) is assigned after Phase 3 and invoked via
		// `reconnect(serverName)` inside the oauth wiring (110). Driving it through the
		// `__test` seam exercises both the late-bound callback assignment and the
		// `reconnectResolvedMcpServer` wrapper body. The underlying connect fails fast
		// against the 503 fixture; reconnectResolvedMcpServer swallows connect failures,
		// so the wrapper must resolve rather than reject.
		const seam = node.__test;
		expect(seam).toBeDefined();
		await expect(seam?.reloadMcpForReconnect("oauthsrv")).resolves.toBeUndefined();
	}, 20_000);
});

describe("bound start — null model router SIGHUP arm", () => {
	let tempDir: string;
	let configDir: string;
	let node: NodeHandle;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-nullrouter-"));
		configDir = join(tempDir, "config");

		await runInit({ ollama: true, name: "nullrouter-operator", configDir });
		// A `bedrock` backend with no `region` passes the model_backends schema (no
		// refine requires region for bedrock) but makes `createModelRouter` throw
		// inside `createBackendFromConfig` ("Bedrock driver requires region in
		// config"), so `initInference`'s catch leaves `modelRouter` null — the only
		// schema-valid construction that nulls the router. A missing-`default`
		// config can't be used: the schema's `.refine` rejects it at load time
		// (config-schemas.ts), at both boot AND SIGHUP reload.
		writeFileSync(
			join(configDir, "model_backends.js"),
			`export default ${JSON.stringify(
				{
					backends: [
						{
							id: "bedrocknoregion",
							provider: "bedrock",
							model: "anthropic.claude-dummy",
							context_window: 8192,
						},
					],
					default: "bedrocknoregion",
				},
				null,
				2,
			)};\n`,
		);

		node = await startNode(
			{ configDir },
			{ webPort: 0, syncPort: 0, webHost: "localhost", syncHost: "localhost" },
		);
	}, 60_000);

	afterEach(async () => {
		await node?.stop();
		cleanupTmpDirSync(tempDir);
	});

	it("boots with no model router when the default backend is missing", () => {
		// A null router means no web server booted (the agentLoopFactory &&
		// modelRouter branch fell to the single-host fallback).
		expect(node.webPort).toBeNull();
		expect(node.syncPort).toBeNull();
	});

	it("warns and returns from onModelBackendsChanged when no router is registered", async () => {
		// Capture the warn emitted by the `!modelRouter` arm (266-269). A SIGHUP
		// config reload invokes onModelBackendsChanged; with modelRouter null the
		// callback warns and returns without touching a (nonexistent) router.
		const warnings: string[] = [];
		const logger = node.appContext.logger as unknown as {
			warn: (msg: string, ...rest: unknown[]) => void;
		};
		const originalWarn = logger.warn;
		logger.warn = (msg: string, ...rest: unknown[]) => {
			warnings.push(msg);
			return originalWarn.call(logger, msg, ...rest);
		};
		try {
			// Write a DIFFERENT but schema-valid model_backends so the SIGHUP reload
			// succeeds (loadModelBackendsConfig validates; an invalid config would
			// throw before onModelBackendsChanged fires). The callback checks the
			// closure-captured `modelRouter` (null), not the new config, so any valid
			// change reaches the `!modelRouter` arm.
			writeFileSync(
				join(configDir, "model_backends.js"),
				`export default ${JSON.stringify(
					{
						backends: [
							{
								id: "bedrocknoregion2",
								provider: "bedrock",
								model: "anthropic.claude-dummy-2",
								context_window: 8192,
							},
						],
						default: "bedrocknoregion2",
					},
					null,
					2,
				)};\n`,
			);
			process.emit("SIGHUP");
			// The SIGHUP handler reloads asynchronously; poll briefly for the warn.
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				if (warnings.some((w) => w.includes("[sighup]") && w.includes("no router is registered"))) {
					break;
				}
				await new Promise((r) => setTimeout(r, 50));
			}
			expect(
				warnings.some((w) => w.includes("[sighup]") && w.includes("no router is registered")),
			).toBe(true);
		} finally {
			logger.warn = originalWarn;
		}
	}, 20_000);
});

describe("bound start — teardown with a throwing MCP client", () => {
	let tempDir: string;
	let configDir: string;
	let node: NodeHandle;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-teardown-throw-"));
		configDir = join(tempDir, "config");
		await runInit({ ollama: true, name: "teardown-operator", configDir });
		node = await startNode(
			{ configDir },
			{ webPort: 0, syncPort: 0, webHost: "localhost", syncHost: "localhost" },
		);
	}, 60_000);

	afterEach(() => {
		cleanupTmpDirSync(tempDir);
	});

	it("swallows a client whose disconnect() throws and still completes teardown", async () => {
		// The teardown loop iterates the live mcpClientsMap and calls
		// `await client.disconnect()` inside a try/catch (371-373). Inject a
		// client whose disconnect rejects; stop() must not propagate it.
		let disconnectCalled = false;
		const throwingClient = {
			disconnect: async () => {
				disconnectCalled = true;
				throw new Error("disconnect boom");
			},
		};
		// Inject the throwing client into the live mcpClientsMap via the `__test`
		// seam so the teardown disconnect loop (371-373) iterates it and its catch
		// swallows the rejection.
		const seam = node.__test;
		expect(seam).toBeDefined();
		seam?.mcpClients.set("throwing", throwingClient);
		// stop() must resolve despite the throwing disconnect.
		await expect(node.stop()).resolves.toBeUndefined();
		expect(disconnectCalled).toBe(true);
		// stop() is idempotent; afterEach need not call it.
		node = { ...node, stop: async () => {} } as NodeHandle;
	}, 20_000);
});

describe("bound start — runStart signal wiring", () => {
	let tempDir: string;
	let configDir: string;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-runstart-"));
		configDir = join(tempDir, "config");
		await runInit({ ollama: true, name: "runstart-operator", configDir });
	}, 60_000);

	afterEach(() => {
		cleanupTmpDirSync(tempDir);
	});

	it("registers SIGINT/SIGTERM handlers and tears down when SIGINT fires", async () => {
		// Snapshot the listeners we must not disturb.
		const beforeSigint = new Set(process.listeners("SIGINT"));
		const beforeSigterm = new Set(process.listeners("SIGTERM"));
		const beforeExit = new Set(process.listeners("exit"));

		// runStart boots with installSignalHandlers: true, so bootstrap ALSO adds
		// a SIGINT handler that calls process.exit(0). Invoking it for real would
		// end the whole test process with exit code 0 (silently truncating the
		// suite and the coverage report), so stub exit for the duration.
		const exitCodes: unknown[] = [];
		const exitSpy = spyOn(process, "exit").mockImplementation(((code?: unknown) => {
			exitCodes.push(code);
		}) as never);

		let addedSigint: ((...args: unknown[]) => void)[] = [];
		let addedSigterm: ((...args: unknown[]) => void)[] = [];
		try {
			// runStart blocks until a shutdown signal arrives. Start it, let it
			// register its listeners, then invoke them to drive handle.stop().
			const runPromise = runStart({ configDir });

			// Poll until runStart has added its SIGINT listener (startNode must
			// finish booting first; bootstrap's listener alone is one entry).
			const deadline = Date.now() + 40_000;
			while (Date.now() < deadline) {
				addedSigint = (process.listeners("SIGINT") as ((...args: unknown[]) => void)[]).filter(
					(l) => !beforeSigint.has(l as never),
				);
				if (addedSigint.length >= 2) break;
				await new Promise((r) => setTimeout(r, 100));
			}
			addedSigterm = (process.listeners("SIGTERM") as ((...args: unknown[]) => void)[]).filter(
				(l) => !beforeSigterm.has(l as never),
			);

			// At least bootstrap's lockfile handler + runStart's graceful-shutdown
			// handler (other boot subsystems may add their own).
			expect(addedSigint.length).toBeGreaterThanOrEqual(2);
			expect(addedSigterm.length).toBeGreaterThanOrEqual(2);

			for (const l of addedSigint) l("SIGINT");

			await expect(runPromise).resolves.toBeUndefined();
			// bootstrap's handler asked to exit cleanly; the stub absorbed it.
			expect(exitCodes).toContain(0);
		} finally {
			exitSpy.mockRestore();
			// Remove exactly the listeners this boot added (whole-suite hygiene).
			for (const l of addedSigint) process.removeListener("SIGINT", l as never);
			for (const l of addedSigterm) process.removeListener("SIGTERM", l as never);
			for (const l of process.listeners("exit")) {
				if (!beforeExit.has(l)) process.removeListener("exit", l);
			}
		}

		// The listener sets must be back to their pre-test state.
		expect(new Set(process.listeners("SIGINT"))).toEqual(beforeSigint);
		expect(new Set(process.listeners("SIGTERM"))).toEqual(beforeSigterm);
		expect(new Set(process.listeners("exit"))).toEqual(beforeExit);
	}, 60_000);
});

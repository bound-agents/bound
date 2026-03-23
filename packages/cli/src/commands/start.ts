// Task 3: bound start command
// Full orchestrator bootstrap sequence

import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createAppContext } from "@bound/core";
import { AgentLoop, Scheduler } from "@bound/agent";
import type { AgentLoopConfig } from "@bound/agent";
import { MCPClient } from "@bound/agent";
import { generateMCPCommands } from "@bound/agent";
import { OllamaDriver } from "@bound/llm";
import type { LLMBackend, LLMMessage, ToolDefinition } from "@bound/llm";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { ensureKeypair } from "@bound/sync";
import { createClusterFs, createSandbox } from "@bound/sandbox";
import { createWebServer } from "@bound/web";

export interface StartArgs {
	configDir?: string;
}

export async function runStart(args: StartArgs): Promise<void> {
	const configDir = args.configDir || "config";

	console.log("Starting Bound orchestrator...");

	// Bootstrap sequence per spec:
	// 1. Load and validate all config files
	console.log("Loading configuration...");
	mkdirSync("data", { recursive: true });
	const dbPath = resolve("data", "bound.db");

	let appContext: Awaited<ReturnType<typeof createAppContext>>;
	try {
		appContext = createAppContext(resolve(configDir), dbPath);
	} catch (error) {
		console.error(
			"Configuration error:",
			error instanceof Error ? error.message : String(error),
		);
		process.exit(1);
	}

	// 2. Ensure Ed25519 keypair via @bound/sync
	console.log("Initializing cryptography...");
	const keypair = await ensureKeypair(resolve("data"));
	// Update site_id in host_meta to the value derived from the Ed25519 public key.
	// On first startup, createAppContext generated a randomUUID placeholder because
	// the keypair did not yet exist. Now that the keypair is available, replace it.
	if (appContext.siteId !== keypair.siteId) {
		appContext.db.run("UPDATE host_meta SET value = ? WHERE key = 'site_id'", [keypair.siteId]);
		appContext.siteId = keypair.siteId;
		appContext.logger.info("Updated site_id from Ed25519 public key", { siteId: keypair.siteId });
	}

	// 3. Create/open SQLite database and run migrations
	console.log("Initializing database...");
	// TODO: Database setup and schema migrations

	// 4. Create DI container
	console.log("Setting up services...");
	// TODO: Bootstrap tsyringe container

	// 5. User seeding
	console.log("Seeding users from allowlist...");
	{
		const now = new Date().toISOString();
		for (const [username, entry] of Object.entries(appContext.config.allowlist.users)) {
			const userId = deterministicUUID(BOUND_NAMESPACE, username);
			appContext.db.run(
				`INSERT OR IGNORE INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted)
				VALUES (?, ?, ?, ?, ?, 0)`,
				[userId, entry.display_name, entry.discord_id ?? null, now, now],
			);
		}
	}

	// 6. Host registration
	console.log("Registering host...");
	{
		const now = new Date().toISOString();
		appContext.db.run(
			`INSERT INTO hosts (site_id, host_name, online_at, modified_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(site_id) DO UPDATE SET
				host_name = excluded.host_name,
				online_at = excluded.online_at,
				modified_at = excluded.modified_at`,
			[appContext.siteId, appContext.hostName, now, now],
		);
	}

	// 7. Crash recovery scan
	console.log("Scanning for crash recovery...");
	{
		const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		const staleRunning = appContext.db
			.query(
				`SELECT id FROM tasks
				 WHERE status = 'running'
				   AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
			)
			.all(staleThreshold) as Array<{ id: string }>;

		if (staleRunning.length > 0) {
			appContext.db
				.query(
					`UPDATE tasks SET status = 'pending', lease_id = NULL, claimed_by = NULL, claimed_at = NULL
					 WHERE status = 'running'
					   AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
				)
				.run(staleThreshold);
			console.log(`[recovery] Reset ${staleRunning.length} stale running task(s) to pending`);
		} else {
			console.log("[recovery] No crashed tasks found");
		}
	}

	// 8. MCP connections — build a named Map so the agent loop can look up clients by server name
	console.log("Initializing MCP servers...");
	const mcpClientsMap = new Map<string, MCPClient>();
	{
		const mcpResult = appContext.optionalConfig["mcp"];
		if (mcpResult && mcpResult.ok) {
			const mcpConfig = mcpResult.value as {
				servers: Array<{
					name: string;
					command?: string;
					args?: string[];
					url?: string;
					transport: "stdio" | "sse";
					allow_tools?: string[];
					confirm?: string[];
				}>;
			};

			console.log(`[mcp] Found ${mcpConfig.servers.length} server(s) in config`);

			for (const serverCfg of mcpConfig.servers) {
				try {
					const client = new MCPClient(serverCfg);
					await client.connect();
					mcpClientsMap.set(serverCfg.name, client);
					const tools = await client.listTools();
					console.log(
						`[mcp] Connected to server: ${serverCfg.name} (${serverCfg.transport}), tools: ${tools.map((t) => t.name).join(", ") || "(none)"}`,
					);
				} catch (error) {
					console.warn(
						`[mcp] Failed to connect to ${serverCfg.name}:`,
						error instanceof Error ? error.message : String(error),
					);
				}
			}
		} else {
			console.log("[mcp] No MCP servers configured");
		}
	}

	// Generate MCP command definitions (for sandbox/scheduler use)
	const mcpCommands = await generateMCPCommands(mcpClientsMap);
	console.log(`[mcp] Generated ${mcpCommands.length} MCP command definition(s)`);

	// Build LLM ToolDefinitions from discovered MCP tools
	const mcpToolDefinitions: ToolDefinition[] = [];
	for (const [serverName, client] of mcpClientsMap) {
		if (!client.isConnected()) continue;
		try {
			const tools = await client.listTools();
			for (const tool of tools) {
				mcpToolDefinitions.push({
					type: "function",
					function: {
						name: `${serverName}-${tool.name}`,
						description: tool.description ?? "",
						parameters: tool.inputSchema as Record<string, unknown>,
					},
				});
			}
		} catch (error) {
			console.warn(
				`[mcp] Failed to list tools for ${serverName}:`,
				error instanceof Error ? error.message : String(error),
			);
		}
	}
	if (mcpToolDefinitions.length > 0) {
		console.log(
			`[mcp] Registered ${mcpToolDefinitions.length} tool(s) for LLM: ${mcpToolDefinitions.map((t) => t.function.name).join(", ")}`,
		);
	}

	// 9. Sandbox setup
	console.log("Setting up sandbox...");
	let sandbox: Awaited<ReturnType<typeof createSandbox>> | null = null;
	try {
		const clusterFs = createClusterFs({
			hostName: appContext.hostName,
			syncEnabled: false,
		});
		sandbox = await createSandbox({
			clusterFs,
			commands: mcpCommands,
		});
		console.log("[sandbox] Sandbox ready");
	} catch (error) {
		console.warn(
			"[sandbox] Failed to create sandbox:",
			error instanceof Error ? error.message : String(error),
		);
	}

	// 10. Persona loading
	console.log("Loading persona...");
	let personaText: string | null = null;
	{
		const personaPath = resolve(configDir, "persona.md");
		if (existsSync(personaPath)) {
			try {
				personaText = readFileSync(personaPath, "utf-8");
				console.log(`[persona] Loaded persona (${personaText.length} chars)`);
			} catch (error) {
				console.warn(
					"[persona] Failed to read persona.md:",
					error instanceof Error ? error.message : String(error),
				);
			}
		} else {
			console.log("[persona] No persona configured");
		}
	}

	// 11. LLM setup
	console.log("Initializing LLM...");
	const defaultBackend = appContext.config.modelBackends.backends.find(
		(b) => b.id === appContext.config.modelBackends.default,
	) || appContext.config.modelBackends.backends[0];

	let llmDriver: OllamaDriver | null = null;
	if (defaultBackend?.provider === "ollama" && defaultBackend.base_url) {
		llmDriver = new OllamaDriver({
			baseUrl: defaultBackend.base_url,
			model: defaultBackend.model,
			contextWindow: defaultBackend.context_window,
		});
		console.log(`[llm] Initialized Ollama driver: ${defaultBackend.model} at ${defaultBackend.base_url}`);
	} else {
		console.warn("[llm] No supported LLM backend configured");
	}

	// 12. Web server
	console.log("Starting web server...");
	let webServer: Awaited<ReturnType<typeof createWebServer>> | null = null;
	try {
		const modelBackends = appContext.config.modelBackends;

		// Extract keyring if configured — needed by the MCP proxy endpoint for request verification
		const keyringResult = appContext.optionalConfig["keyring"];
		const keyring =
			keyringResult && keyringResult.ok
				? (keyringResult.value as import("@bound/shared").KeyringConfig)
				: undefined;

		webServer = await createWebServer(appContext.db, appContext.eventBus, {
			port: 3000,
			host: "localhost",
			models: {
				models: modelBackends.backends.map((b) => ({ id: b.id, provider: b.provider })),
				default: modelBackends.default,
			},
			mcpClients: mcpClientsMap,
			keyring,
		});
		await webServer.start();

		// Wire message:created events to the agent loop
		const activeLoops = new Set<string>();
		appContext.eventBus.on("message:created", async ({ message, thread_id }) => {
			// Only process user messages, skip our own assistant messages
			if (message.role !== "user") return;
			if (!llmDriver) {
				console.warn("[agent] No LLM driver configured, cannot process message");
				return;
			}
			if (activeLoops.has(thread_id)) {
				console.log(`[agent] Loop already active for thread ${thread_id}, skipping`);
				return;
			}

			console.log(`[agent] Processing message in thread ${thread_id}`);
			activeLoops.add(thread_id);

			try {
				// Fetch thread history
				const dbMessages = appContext.db
					.query("SELECT role, content, tool_name FROM messages WHERE thread_id = ? ORDER BY created_at ASC")
					.all(thread_id) as Array<{ role: string; content: string; tool_name: string | null }>;

				// Build LLM messages — tool_call and tool_result rows store JSON content
				const llmMessages: LLMMessage[] = dbMessages.map((m) => {
					if (m.role === "tool_call" || m.role === "tool_result") {
						return {
							role: m.role as "tool_call" | "tool_result",
							content: m.content,
							tool_use_id: m.tool_name ?? undefined,
						};
					}
					return {
						role: m.role as "user" | "assistant" | "system",
						content: m.content,
					};
				});

				console.log(`[agent] Calling LLM with ${llmMessages.length} messages`);

				// Tool execution loop — runs until the LLM produces a text-only response
				let responseText = "";
				let continueLoop = true;

				while (continueLoop) {
					// Accumulate tool call data across stream chunks
					const pendingToolCalls: Array<{ id: string; name: string; argsJson: string }> = [];
					// Map from id -> accumulated partial_json
					const argsAccumulator = new Map<string, string>();
					let currentText = "";

					const stream = llmDriver.chat({
						model: defaultBackend.model,
						messages: llmMessages,
						tools: mcpToolDefinitions.length > 0 ? mcpToolDefinitions : undefined,
					});

					for await (const chunk of stream) {
						if (chunk.type === "text") {
							currentText += chunk.content;
						} else if (chunk.type === "tool_use_start") {
							// Register new tool call being built
							argsAccumulator.set(chunk.id, "");
						} else if (chunk.type === "tool_use_args") {
							// Accumulate partial JSON for this tool call
							const existing = argsAccumulator.get(chunk.id) ?? "";
							argsAccumulator.set(chunk.id, existing + chunk.partial_json);
						} else if (chunk.type === "tool_use_end") {
							// Finalise the tool call entry
							const fullArgs = argsAccumulator.get(chunk.id) ?? "{}";
							// The id emitted by OllamaDriver is the tool function name; name is also available
							// from tool_use_start. We stored it as the id, so use chunk.id as both.
							pendingToolCalls.push({ id: chunk.id, name: chunk.id, argsJson: fullArgs });
						} else if (chunk.type === "error") {
							console.error(`[agent] LLM error: ${chunk.error}`);
							currentText = `Error from LLM: ${chunk.error}`;
							break;
						} else if (chunk.type === "done") {
							console.log(
								`[agent] LLM done: ${chunk.usage.input_tokens} in, ${chunk.usage.output_tokens} out`,
							);
						}
					}

					if (pendingToolCalls.length === 0) {
						// No tool calls — the LLM is done
						responseText = currentText;
						continueLoop = false;
					} else {
						// The assistant turn that requested tool calls
						const toolCallContent = JSON.stringify(
							pendingToolCalls.map((tc) => ({
								type: "tool_use",
								id: tc.id,
								name: tc.name,
								input: (() => {
									try {
										return JSON.parse(tc.argsJson);
									} catch {
										return {};
									}
								})(),
							})),
						);

						// Persist the tool_call message
						const toolCallMsgId = randomUUID();
						const now = new Date().toISOString();
						appContext.db.run(
							`INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin)
							 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
							[toolCallMsgId, thread_id, "tool_call", toolCallContent, defaultBackend.id, null, now, now, appContext.hostName],
						);

						// Add to in-memory context for next LLM call
						llmMessages.push({
							role: "tool_call",
							content: toolCallContent,
						});

						// Execute each tool call
						for (const tc of pendingToolCalls) {
							// Name format is "{serverName}-{toolName}" (e.g. "metacog-become")
							const dashIdx = tc.name.indexOf("-");
							const serverName = dashIdx >= 0 ? tc.name.slice(0, dashIdx) : tc.name;
							const toolName = dashIdx >= 0 ? tc.name.slice(dashIdx + 1) : tc.name;

							console.log(`[agent] Calling MCP tool: ${tc.name}`);

							let toolResultContent: string;
							const client = mcpClientsMap.get(serverName);
							if (!client) {
								toolResultContent = `Error: No MCP server named "${serverName}"`;
								console.warn(`[agent] Unknown MCP server: ${serverName}`);
							} else {
								try {
									let toolArgs: Record<string, unknown> = {};
									try {
										toolArgs = JSON.parse(tc.argsJson);
									} catch {
										// leave as empty object
									}
									const result = await client.callTool(toolName, toolArgs);
									toolResultContent = result.content;
									console.log(`[agent] Tool result: ${toolResultContent.slice(0, 200)}${toolResultContent.length > 200 ? "..." : ""}`);
								} catch (error) {
									toolResultContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
									console.error(`[agent] Tool call failed: ${toolResultContent}`);
								}
							}

							// Persist the tool_result message
							const toolResultMsgId = randomUUID();
							const resultNow = new Date().toISOString();
							appContext.db.run(
								`INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin)
								 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
								[toolResultMsgId, thread_id, "tool_result", toolResultContent, defaultBackend.id, tc.id, resultNow, resultNow, appContext.hostName],
							);

							// Add to in-memory context for next LLM call
							llmMessages.push({
								role: "tool_result",
								content: toolResultContent,
								tool_use_id: tc.id,
							});
						}

						// Loop again — feed results back to LLM
						console.log(`[agent] Executed ${pendingToolCalls.length} tool call(s), continuing loop`);
					}
				}

				if (responseText) {
					// Persist assistant response
					const msgId = randomUUID();
					const now = new Date().toISOString();
					appContext.db.run(
						`INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						[msgId, thread_id, "assistant", responseText, defaultBackend.id, null, now, now, appContext.hostName],
					);

					console.log(`[agent] Response persisted (${responseText.length} chars)`);

					// Emit so WebSocket pushes to client
					const savedMsg = appContext.db.query("SELECT * FROM messages WHERE id = ?").get(msgId);
					appContext.eventBus.emit("message:created", {
						message: savedMsg as any,
						thread_id,
					});
				}
			} catch (error) {
				console.error(`[agent] Error: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				activeLoops.delete(thread_id);
			}
		});
	} catch (error) {
		console.warn(
			"Web server failed to start:",
			error instanceof Error ? error.message : String(error),
		);
		console.warn("Continuing without web UI. API will not be available.");
	}

	// 13. Discord (if configured)
	console.log("Initializing Discord...");
	// TODO: Start Discord bot if discord.json exists and host matches

	// 14. Sync (if configured)
	console.log("Initializing sync loop...");
	// TODO: Start sync loop if sync.json exists

	// 15. Overlay scanning (if configured)
	console.log("Initializing overlay scanner...");
	// TODO: Start overlay index scan if overlay.json exists

	// 16. Scheduler
	console.log("Starting scheduler...");
	let schedulerHandle: { stop: () => void } | null = null;
	try {
		const agentLoopFactory = (config: AgentLoopConfig): AgentLoop => {
			const llmBackend: LLMBackend = llmDriver ?? {
				chat: async function* () {
					// No-op backend when no LLM is configured
				},
				capabilities: () => ({ streaming: false, tools: false, vision: false }),
			};

			return new AgentLoop(appContext, sandbox ?? ({} as any), llmBackend, config);
		};

		const scheduler = new Scheduler(appContext, agentLoopFactory);
		schedulerHandle = scheduler.start(30_000);
		console.log("[scheduler] Scheduler started (30s poll interval)");
	} catch (error) {
		console.warn(
			"[scheduler] Failed to start scheduler:",
			error instanceof Error ? error.message : String(error),
		);
	}

	console.log(`
Bound is running!
Operator: ${appContext.config.allowlist.default_web_user}

Open http://localhost:3000 in your browser to start chatting.

Press Ctrl+C to stop.
`);

	// Keep process alive until shutdown signal (web server keeps event loop active)
	await new Promise<void>((resolve) => {
		process.on("SIGINT", async () => {
			console.log("\nShutting down gracefully...");
			if (schedulerHandle) schedulerHandle.stop();
			// Disconnect MCP clients
			for (const [, client] of mcpClientsMap) {
				try {
					await client.disconnect();
				} catch (_err) {
					// Ignore disconnect errors during shutdown
				}
			}
			if (webServer) await webServer.stop();
			resolve();
		});

		process.on("SIGTERM", async () => {
			console.log("\nTerminating...");
			if (schedulerHandle) schedulerHandle.stop();
			for (const [, client] of mcpClientsMap) {
				try {
					await client.disconnect();
				} catch (_err) {
					// Ignore disconnect errors during shutdown
				}
			}
			if (webServer) await webServer.stop();
			resolve();
		});
	});
}

// Task 3: bound start command
// Full orchestrator bootstrap sequence

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	AgentLoop,
	RelayProcessor,
	Scheduler,
	seedCronTasks,
	getDelegationTarget,
	createRelayOutboxEntry,
	resolveModel,
} from "@bound/agent";
import type { AgentLoopConfig } from "@bound/agent";
import { MCPClient } from "@bound/agent";
import { generateMCPCommands, getAllCommands, setCommandRegistry } from "@bound/agent";
import { generateThreadTitle } from "@bound/agent";
import {
	createAppContext,
	insertRow,
	resolveRelayConfig,
	updateRow,
	withChangeLog,
	writeOutbox,
} from "@bound/core";
import { createModelRouter } from "@bound/llm";
import type { BackendConfig, ModelBackendsConfig, ToolDefinition } from "@bound/llm";
import { createClusterFs, createDefineCommands, createSandbox } from "@bound/sandbox";
import type { SyncConfig, StatusForwardPayload, ProcessPayload } from "@bound/shared";
import { BOUND_NAMESPACE, deterministicUUID, formatError } from "@bound/shared";
import { ReachabilityTracker, ensureKeypair } from "@bound/sync";
import type { RelayExecutor } from "@bound/sync";
import { createWebServer } from "@bound/web";
import { runLocalAgentLoop } from "../lib/message-handler";

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
		console.error("Configuration error:", formatError(error));
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
	// Database initialized by createAppContext above

	// 4. Create DI container
	console.log("Setting up services...");
	// DI container bootstrapped by createAppContext above

	// 5. User seeding
	console.log("Seeding users from allowlist...");
	{
		const now = new Date().toISOString();
		for (const [username, entry] of Object.entries(appContext.config.allowlist.users)) {
			const userId = deterministicUUID(BOUND_NAMESPACE, username);
			// Check if user already exists before inserting (per R-U5)
			const existingUser = appContext.db.query("SELECT id FROM users WHERE id = ?").get(userId) as {
				id: string;
			} | null;

			if (!existingUser) {
				insertRow(
					appContext.db,
					"users",
					{
						id: userId,
						display_name: entry.display_name,
						platform_ids: entry.platforms ? JSON.stringify(entry.platforms) : null,
						first_seen_at: now,
						modified_at: now,
						deleted: 0,
					},
					appContext.siteId,
				);
			} else {
				// Update display_name and platforms if changed in allowlist
				updateRow(
					appContext.db,
					"users",
					userId,
					{
						display_name: entry.display_name,
						platform_ids: entry.platforms ? JSON.stringify(entry.platforms) : null,
						modified_at: now,
					},
					appContext.siteId,
				);
			}
		}
	}

	// 6. Host registration (via outbox for sync compliance)
	console.log("Registering host...");
	{
		const now = new Date().toISOString();
		const existingHost = appContext.db
			.query("SELECT site_id FROM hosts WHERE site_id = ?")
			.get(appContext.siteId) as { site_id: string } | null;

		if (existingHost) {
			withChangeLog(appContext.db, appContext.siteId, () => {
				appContext.db.run(
					"UPDATE hosts SET host_name = ?, online_at = ?, modified_at = ? WHERE site_id = ?",
					[appContext.hostName, now, now, appContext.siteId],
				);
				const updatedRow = appContext.db
					.query("SELECT * FROM hosts WHERE site_id = ?")
					.get(appContext.siteId) as Record<string, unknown>;
				return {
					tableName: "hosts" as const,
					rowId: appContext.siteId,
					rowData: updatedRow,
					result: undefined,
				};
			});
		} else {
			const hostRow = {
				site_id: appContext.siteId,
				host_name: appContext.hostName,
				online_at: now,
				modified_at: now,
				deleted: 0,
			};
			withChangeLog(appContext.db, appContext.siteId, () => {
				appContext.db.run(
					"INSERT INTO hosts (site_id, host_name, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
					[appContext.siteId, appContext.hostName, now, now],
				);
				return {
					tableName: "hosts" as const,
					rowId: appContext.siteId,
					rowData: hostRow,
					result: undefined,
				};
			});
		}
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

		// Scan for interrupted tool-use per R-E13
		const interruptedThreads = appContext.db
			.query(
				`SELECT DISTINCT m.thread_id FROM messages m
				 WHERE m.role IN ('tool_call', 'tool_result')
				 AND NOT EXISTS (
					SELECT 1 FROM messages m2
					WHERE m2.thread_id = m.thread_id
					AND m2.created_at > m.created_at
					AND m2.role = 'assistant'
				 )`,
			)
			.all() as Array<{ thread_id: string }>;

		if (interruptedThreads.length > 0) {
			const now = new Date().toISOString();
			for (const { thread_id } of interruptedThreads) {
				try {
					insertRow(
						appContext.db,
						"messages",
						{
							id: randomUUID(),
							thread_id: thread_id,
							role: "system",
							content: `Agent response was interrupted on host ${appContext.hostName}. The previous tool interaction may be incomplete.`,
							model_id: null,
							tool_name: null,
							created_at: now,
							modified_at: now,
							host_origin: appContext.hostName,
							deleted: 0,
						},
						appContext.siteId,
					);
				} catch (error) {
					console.warn(
						`[recovery] Failed to insert interrupted tool message for thread ${thread_id}:`,
						formatError(error),
					);
				}
			}
			console.log(
				`[recovery] Inserted interruption notices for ${interruptedThreads.length} thread(s)`,
			);
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
					console.warn(`[mcp] Failed to connect to ${serverCfg.name}:`, formatError(error));
				}
			}
		} else {
			console.log("[mcp] No MCP servers configured");
		}
	}

	// Generate MCP command definitions (for sandbox/scheduler use)
	// Build confirm gates map from MCP config (R-U32)
	const confirmGates = new Map<string, string[]>();
	{
		const mcpResult = appContext.optionalConfig["mcp"];
		if (mcpResult && mcpResult.ok) {
			const mcpConfig = mcpResult.value as {
				servers: Array<{
					name: string;
					confirm?: string[];
				}>;
			};
			for (const serverCfg of mcpConfig.servers) {
				if (serverCfg.confirm && serverCfg.confirm.length > 0) {
					confirmGates.set(serverCfg.name, serverCfg.confirm);
				}
			}
		}
	}

	const mcpCommands = await generateMCPCommands(mcpClientsMap, confirmGates);
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
			console.warn(`[mcp] Failed to list tools for ${serverName}:`, formatError(error));
		}
	}
	if (mcpToolDefinitions.length > 0) {
		console.log(
			`[mcp] Registered ${mcpToolDefinitions.length} tool(s) for LLM: ${mcpToolDefinitions.map((t) => t.function.name).join(", ")}`,
		);
	}

	// 8b. Relay processor setup (deferred until after modelRouter is initialized)
	console.log("Initializing relay processor...");
	let relayProcessorHandle: { stop: () => void } | null = null;
	let relayExecutor: RelayExecutor | undefined;
	let keyring: import("@bound/shared").KeyringConfig | undefined;
	{
		const keyringResult = appContext.optionalConfig["keyring"];
		keyring =
			keyringResult && keyringResult.ok
				? (keyringResult.value as import("@bound/shared").KeyringConfig)
				: undefined;

		if (!keyring) {
			console.log("[relay] No keyring configured, relay processor disabled");
		}
	}

	// 9. Sandbox setup
	console.log("Setting up sandbox...");
	let sandbox: Awaited<ReturnType<typeof createSandbox>> | null = null;
	try {
		const clusterFs = createClusterFs({
			hostName: appContext.hostName,
			syncEnabled: false,
		});
		const commandContext = {
			db: appContext.db,
			siteId: appContext.siteId,
			eventBus: appContext.eventBus,
			logger: appContext.logger,
			mcpClients: mcpClientsMap,
		};
		const builtinCommands = getAllCommands();
		const allDefinitions = [...builtinCommands, ...mcpCommands];
		setCommandRegistry(allDefinitions);
		const registeredCommands = createDefineCommands(allDefinitions, commandContext);
		sandbox = await createSandbox({
			clusterFs,
			commands: registeredCommands,
		});
		console.log(
			`[sandbox] ${builtinCommands.length} built-in + ${mcpCommands.length} MCP commands registered`,
		);
		console.log("[sandbox] Sandbox ready");
	} catch (error) {
		console.warn("[sandbox] Failed to create sandbox:", formatError(error));
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
				console.warn("[persona] Failed to read persona.md:", formatError(error));
			}
		} else {
			console.log("[persona] No persona configured");
		}
	}

	// 11. LLM setup — use ModelRouter to support all configured backends
	console.log("Initializing LLM...");
	const rawBackends = appContext.config.modelBackends;
	const routerConfig: ModelBackendsConfig = {
		backends: rawBackends.backends.map(
			(b): BackendConfig => ({
				id: b.id,
				provider: b.provider,
				model: b.model,
				baseUrl: b.base_url,
				contextWindow: b.context_window,
				apiKey: b.api_key,
				region: b.region,
				profile: b.profile,
			}),
		),
		default: rawBackends.default,
	};

	// Map backend IDs to their provider-specific model names for chat() calls
	const backendModelMap = new Map<string, string>();
	for (const b of routerConfig.backends) {
		backendModelMap.set(b.id, b.model);
	}

	let modelRouter: ReturnType<typeof createModelRouter> | null = null;
	try {
		modelRouter = createModelRouter(routerConfig);
		const ids = routerConfig.backends.map((b) => b.id).join(", ");
		console.log(`[llm] Model router ready — backends: ${ids} (default: ${routerConfig.default})`);
	} catch (error) {
		console.warn(`[llm] Failed to create model router: ${formatError(error)}`);
	}

	// Register local model IDs in hosts.models for sync advertisement
	if (modelRouter) {
		const modelIds = modelRouter.listBackends().map((b) => b.id);
		const existingHost = appContext.db
			.query("SELECT site_id FROM hosts WHERE site_id = ?")
			.get(appContext.siteId) as { site_id: string } | null;

		if (existingHost) {
			updateRow(
				appContext.db,
				"hosts",
				appContext.siteId,
				{ models: JSON.stringify(modelIds) },
				appContext.siteId,
			);
		}
		// If no host row yet, the sync bootstrap will create it — hosts.models is set
		// on the initial row insertion. On next startup, this code re-runs and updates.
	}

	// 11a. Initialize relay processor (now that modelRouter is ready)
	// Always started — even in single-host mode without a keyring, the relay processor
	// handles local platform connector intake relays via the self-loopback mechanism.
	const syncConfigResult = appContext.optionalConfig.sync;
	const relayConfig = resolveRelayConfig(
		syncConfigResult?.ok ? (syncConfigResult.value as SyncConfig) : undefined,
	);
	// In single-host mode (no keyring), trust only self; in multi-host, trust all keyring peers.
	const keyringSiteIds = keyring
		? new Set(Object.keys(keyring.hosts))
		: new Set([appContext.siteId]);
	const relayProcessor = new RelayProcessor(
		appContext.db,
		appContext.siteId,
		mcpClientsMap,
		modelRouter ?? null,
		keyringSiteIds,
		appContext.logger,
		appContext.eventBus,
		appContext,
		relayConfig,
	);
	relayProcessorHandle = relayProcessor.start();
	console.log("[relay] Relay processor started");

	// Create the RelayExecutor callback for hub-local execution
	relayExecutor = async (request, hubSiteId) => {
		return relayProcessor.executeImmediate(request, hubSiteId);
	};

	// 11b. Initialize reachability tracker for eager push (hub-side)
	const reachabilityTracker = new ReachabilityTracker();

	// Determine hub siteId from keyring (for spoke-side validation)
	let hubSiteId: string | undefined;
	{
		const keyringResult = appContext.optionalConfig.keyring;
		const syncConfigResult = appContext.optionalConfig.sync;
		if (keyringResult?.ok && syncConfigResult?.ok) {
			const keyring = keyringResult.value as import("@bound/shared").KeyringConfig;
			const syncConfig = syncConfigResult.value as import("@bound/shared").SyncConfig;
			const hubEntry = Object.entries(keyring.hosts).find(([_, v]) => v.url === syncConfig.hub);
			if (hubEntry) {
				hubSiteId = hubEntry[0];
			}
		}
	}

	// Define agent loop factory BEFORE the web server section so the
	// message:created handler can close over it without hitting the temporal
	// dead zone that would exist if agentLoopFactory were a const declared
	// after the handler is registered.
	//
	// Single bash tool for sandbox interaction — all commands (built-in + MCP)
	// are registered inside the sandbox via defineCommand, so the LLM only
	// needs bash.
	const sandboxTool: ToolDefinition = {
		type: "function",
		function: {
			name: "bash",
			description:
				"Execute a command in the sandboxed shell. Built-in commands: query, memorize, forget, schedule, cancel, emit, purge, await, cache-warm, cache-pin, cache-unpin, cache-evict, model-hint, archive, hostinfo. MCP tools are also available as commands. Run standard shell commands too.",
			parameters: {
				type: "object",
				properties: {
					command: {
						type: "string",
						description: "The shell command to execute",
					},
				},
				required: ["command"],
			},
		},
	};

	const agentLoopFactory = (config: AgentLoopConfig): AgentLoop => {
		if (!modelRouter) {
			throw new Error("agentLoopFactory called without a configured model router");
		}
		return new AgentLoop(appContext, sandbox?.bash ?? ({} as any), modelRouter, {
			...config,
			tools: config.tools ?? [sandboxTool],
		});
	};

	// Wire the factory into the relay processor so process relays run with full sandbox + tools.
	relayProcessor.setAgentLoopFactory(agentLoopFactory);

	// 12. Web server
	console.log("Starting web server...");
	let webServer: Awaited<ReturnType<typeof createWebServer>> | null = null;
	const statusForwardCache = new Map<string, StatusForwardPayload>();
	const activeDelegations = new Map<string, { targetSiteId: string; processOutboxId: string }>();
	try {
		const modelBackends = appContext.config.modelBackends;

		// Extract keyring if configured — needed by the MCP proxy endpoint for request verification
		const keyringResult = appContext.optionalConfig["keyring"];
		const keyring =
			keyringResult && keyringResult.ok
				? (keyringResult.value as import("@bound/shared").KeyringConfig)
				: undefined;

		const eagerPushConfig =
			keyring && appContext.siteId
				? {
						privateKey: keypair.privateKey,
						siteId: appContext.siteId,
						db: appContext.db,
						keyring,
						reachabilityTracker,
						logger: appContext.logger,
					}
				: undefined;

		const webPort = Number.parseInt(process.env.PORT || "3000", 10);
		webServer = await createWebServer(appContext.db, appContext.eventBus, {
			port: webPort,
			host: "localhost",
			hostName: appContext.hostName,
			models: {
				models: modelBackends.backends.map((b) => ({ id: b.id, provider: b.provider })),
				default: modelBackends.default,
			},
			mcpClients: mcpClientsMap,
			keyring,
			siteId: appContext.siteId,
			logger: appContext.logger,
			relayExecutor,
			hubSiteId,
			eagerPushConfig,
			statusForwardCache,
			activeDelegations,
		});
		await webServer.start();

		// Wire message:created events to the agent loop
		const activeLoops = new Set<string>();
		const activeLoopAbortControllers = new Map<string, AbortController>();

		// Listen for status:forward events from RelayProcessor
		appContext.eventBus.on("status:forward", (payload: StatusForwardPayload) => {
			statusForwardCache.set(payload.thread_id, payload);
		});

		// Helper: count messages in thread
		const getThreadMessageCount = (threadId: string): number => {
			const result = appContext.db
				.query("SELECT COUNT(*) as count FROM messages WHERE thread_id = ? AND deleted = 0")
				.get(threadId) as { count: number } | null;
			return result?.count ?? 0;
		};

		// Helper: dispatch delegation to remote host
		const dispatchDelegation = async (
			targetHost: ReturnType<typeof getDelegationTarget>,
			threadId: string,
			messageId: string,
			userId: string,
		): Promise<void> => {
			if (!targetHost) return;

			const processPayload: ProcessPayload = {
				thread_id: threadId,
				message_id: messageId,
				user_id: userId,
				platform: null, // null = web UI delegation
			};
			const outboxEntry = createRelayOutboxEntry(
				targetHost.site_id,
				"process",
				JSON.stringify(processPayload),
				5 * 60 * 1000, // 5 minute timeout for delegated loop
			);
			writeOutbox(appContext.db, outboxEntry);
			activeDelegations.set(threadId, {
				targetSiteId: targetHost.site_id,
				processOutboxId: outboxEntry.id,
			});
			appContext.eventBus.emit("sync:trigger", { reason: "delegation" });

			// Poll until new assistant message appears in thread (loop completed on remote)
			const POLL_INTERVAL_MS = 1000;
			const TIMEOUT_MS = 5 * 60 * 1000;
			const startTime = Date.now();
			const initialMessageCount = getThreadMessageCount(threadId);

			while (true) {
				if (Date.now() - startTime > TIMEOUT_MS) {
					appContext.logger.warn("Delegation timeout — no response received", { threadId });
					break;
				}
				const currentCount = getThreadMessageCount(threadId);
				if (currentCount > initialMessageCount) break; // Response arrived via sync

				await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
			}

			activeDelegations.delete(threadId);
		};

		appContext.eventBus.on("message:created", async ({ message, thread_id }) => {
			if (message.role !== "user") return;
			if (!modelRouter) {
				console.warn("[agent] No model router configured, cannot process message");
				return;
			}
			if (activeLoops.has(thread_id)) {
				console.log(`[agent] Loop already active for thread ${thread_id}, skipping`);
				return;
			}

			console.log(`[agent] Processing message in thread ${thread_id}`);
			activeLoops.add(thread_id);

			try {
				const selectedModelId = message.model_id || undefined;
				const activeModelId = selectedModelId || routerConfig.default;

				// AC6.1: Check delegation conditions
				const delegationTarget = getDelegationTarget(
					appContext.db,
					thread_id,
					activeModelId,
					modelRouter,
					appContext.siteId,
				);

				// Get thread user_id
				const threadRow = appContext.db
					.query("SELECT user_id FROM threads WHERE id = ?")
					.get(thread_id) as { user_id: string } | null;
				const userId = threadRow?.user_id || appContext.config.allowlist.default_web_user;

				let shouldReEmitMessage = false;

				if (delegationTarget) {
					// Delegate entire loop to remote host
					console.log(`[agent] Delegating to remote host ${delegationTarget.site_id}`);
					await dispatchDelegation(delegationTarget, thread_id, message.id, userId);
					// Don't re-emit on delegation path to avoid stale message propagation
				} else {
					// AC6.5: Run locally via extracted helper (testable, handles
					// AbortController / timeout / agent:cancel wiring).
					const { agentResult: result } = await runLocalAgentLoop({
						eventBus: appContext.eventBus,
						threadId: thread_id,
						userId,
						modelId: activeModelId,
						activeLoopAbortControllers,
						agentLoopFactory,
					});

					if (result.error) {
						console.error(`[agent] Error: ${result.error}`);
					} else {
						console.log(
							`[agent] Done: ${result.messagesCreated} messages, ${result.toolCallsMade} tool calls`,
						);
					}

					// Only re-emit if successful AND created new messages
					shouldReEmitMessage = !result.error && result.messagesCreated > 0;
				}

				// Push the last assistant message to WebSocket clients via the dedicated
				// broadcast event. Using message:broadcast (not message:created) avoids
				// re-triggering the agent loop handler on the same event channel.
				if (shouldReEmitMessage) {
					const lastMsg = appContext.db
						.query("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1")
						.get(thread_id);
					if (lastMsg) {
						appContext.eventBus.emit("message:broadcast", {
							message: lastMsg as any,
							thread_id,
						});
					}
				}

				// Fire-and-forget: generate thread title
				generateThreadTitle(appContext.db, thread_id, modelRouter.getDefault(), appContext.siteId)
					.then((titleResult) => {
						if (titleResult.ok) {
							console.log(`[agent] Thread title: ${titleResult.value}`);
						}
					})
					.catch((err) => console.warn("[agent] Title generation failed:", formatError(err)));
			} catch (error) {
				console.error(`[agent] Error: ${formatError(error)}`);
			} finally {
				activeLoops.delete(thread_id);
			}
		});
	} catch (error) {
		console.warn("Web server failed to start:", formatError(error));
		console.warn("Continuing without web UI. API will not be available.");
	}

	// 13. Platform connectors (if configured)
	let platformRegistry: { start(): void; stop(): void } | null = null;
	const platformsResult = appContext.optionalConfig.platforms;
	if (platformsResult?.ok) {
		const { PlatformConnectorRegistry } = await import("@bound/platforms");
		const platformsConfig = platformsResult.value as import("@bound/shared").PlatformsConfig;
		platformRegistry = new PlatformConnectorRegistry(appContext, platformsConfig);
		platformRegistry.start();
		console.log("[platforms] Platform connector registry started");
	} else {
		console.log("[platforms] Not configured (no platforms.json)");
	}

	// 14. Sync (if configured)
	console.log("Initializing sync loop...");
	let syncLoopHandle: { stop: () => void } | null = null;
	const syncResult = appContext.optionalConfig.sync;
	if (syncResult?.ok) {
		const syncConfig = syncResult.value as { hub: string; sync_interval_seconds: number };
		try {
			const { SyncClient, startSyncLoop } = await import("@bound/sync");
			const keyringResult = appContext.optionalConfig.keyring;
			const keyring = keyringResult?.ok
				? (keyringResult.value as import("@bound/shared").KeyringConfig)
				: { hosts: {} };
			const syncClient = new SyncClient(
				appContext.db,
				appContext.siteId,
				keypair.privateKey,
				syncConfig.hub,
				appContext.logger,
				appContext.eventBus,
				keyring,
			);
			syncLoopHandle = startSyncLoop(
				syncClient,
				syncConfig.sync_interval_seconds || 30,
				appContext.eventBus,
			);
			console.log(`[sync] Sync loop started (${syncConfig.sync_interval_seconds}s interval)`);
		} catch (error) {
			console.warn(`[sync] Failed to start: ${formatError(error)}`);
		}
	} else {
		console.log("[sync] Not configured");
	}

	// 15. Overlay scanning (if configured)
	console.log("Initializing overlay scanner...");
	let overlayHandle: { stop: () => void } | null = null;
	const overlayResult = appContext.optionalConfig.overlay;
	if (overlayResult?.ok) {
		const overlayConfig = overlayResult.value as { mounts: Record<string, string> };
		try {
			const { startOverlayScanLoop } = await import("@bound/sandbox");
			overlayHandle = startOverlayScanLoop(appContext.db, appContext.siteId, overlayConfig.mounts);
			console.log(
				`[overlay] Scanner started (${Object.keys(overlayConfig.mounts).length} mount(s))`,
			);
		} catch (error) {
			console.warn(`[overlay] Failed to start: ${formatError(error)}`);
		}
	} else {
		console.log("[overlay] Not configured");
	}

	// 16. Seed cron tasks from config
	console.log("Seeding cron tasks...");
	{
		const cronResult = appContext.optionalConfig["cronSchedules"];
		if (cronResult?.ok) {
			const cronSchedules = cronResult.value as Record<
				string,
				{ schedule: string; payload?: string }
			>;
			const cronConfigs = Object.entries(cronSchedules).map(([name, cfg]) => ({
				name,
				cron: cfg.schedule,
				payload: cfg.payload,
			}));
			try {
				seedCronTasks(appContext.db, cronConfigs, appContext.siteId);
				console.log(`[scheduler] Seeded ${cronConfigs.length} cron task(s)`);
			} catch (error) {
				console.warn("[scheduler] Failed to seed cron tasks:", formatError(error));
			}
		} else {
			console.log("[scheduler] No cron schedules configured");
		}
	}

	// 17. Scheduler
	console.log("Starting scheduler...");
	let schedulerHandle: { stop: () => void } | null = null;
	try {
		const scheduler = new Scheduler(
			appContext,
			agentLoopFactory,
			{
				modelValidator: modelRouter
					? (modelId: string) => {
							const resolution = resolveModel(
								modelId,
								modelRouter,
								appContext.db,
								appContext.siteId,
							);
							if (resolution.kind === "error") {
								return { ok: false as const, error: resolution.error };
							}
							return { ok: true as const };
						}
					: undefined,
			},
			sandbox?.bash,
		);
		schedulerHandle = scheduler.start(30_000);
		console.log("[scheduler] Scheduler started (30s poll interval)");
	} catch (error) {
		console.warn("[scheduler] Failed to start scheduler:", formatError(error));
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
			if (syncLoopHandle) syncLoopHandle.stop();
			if (overlayHandle) overlayHandle.stop();
			if (relayProcessorHandle) relayProcessorHandle.stop();
			if (platformRegistry) {
				try {
					platformRegistry.stop();
				} catch (err) {
					console.error("[platforms] Error stopping platform registry:", err);
				}
			}
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
			if (syncLoopHandle) syncLoopHandle.stop();
			if (overlayHandle) overlayHandle.stop();
			if (relayProcessorHandle) relayProcessorHandle.stop();
			if (platformRegistry) {
				try {
					platformRegistry.stop();
				} catch (err) {
					console.error("[platforms] Error stopping platform registry:", err);
				}
			}
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

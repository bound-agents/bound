/**
 * Sandbox subsystem: ClusterFs creation, command registry, VFS hydration, persona loading.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateRemoteMCPProxyCommands, getAllCommands, setCommandRegistry } from "@bound/agent";
import type { MCPClient } from "@bound/agent";
import type { AppContext } from "@bound/core";
import type { CommandDefinition } from "@bound/sandbox";
import {
	type ClusterFsResult,
	createClusterFs,
	createDefineCommands,
	createSandbox,
	hydrateWorkspace,
} from "@bound/sandbox";
import { formatError } from "@bound/shared";

export interface SandboxResult {
	sandbox: Awaited<ReturnType<typeof createSandbox>> | null;
	clusterFsObj: ClusterFsResult | null;
	commandContext: Record<string, unknown> | null;
	personaText: string | null;
}

export async function initSandbox(
	appContext: AppContext,
	mcpClientsMap: Map<string, MCPClient>,
	mcpCommands: CommandDefinition[],
	mcpServerNames: Set<string>,
	configDir: string,
): Promise<SandboxResult> {
	// 9. Sandbox setup
	appContext.logger.info("Setting up sandbox...");
	let sandbox: Awaited<ReturnType<typeof createSandbox>> | null = null;
	let clusterFsObj: ClusterFsResult | null = null;
	let commandContext: Record<string, unknown> | null = null;
	try {
		const clusterFsRaw = createClusterFs({
			hostName: appContext.hostName,
			syncEnabled: false,
			db: appContext.db,
			siteId: appContext.siteId,
		});
		// Extract the MountableFs from either a MountableFs directly or ClusterFsResult
		// biome-ignore lint/suspicious/noExplicitAny: MountableFs type lives in just-bash, not re-exported from @bound/sandbox
		const clusterFs = ("fs" in clusterFsRaw ? clusterFsRaw.fs : clusterFsRaw) as any;
		// With db and siteId provided, createClusterFs always returns ClusterFsResult
		clusterFsObj = clusterFsRaw as unknown as ClusterFsResult;
		commandContext = {
			db: appContext.db,
			siteId: appContext.siteId,
			eventBus: appContext.eventBus,
			logger: appContext.logger,
			mcpClients: mcpClientsMap,
			// biome-ignore lint/suspicious/noExplicitAny: MountableFs satisfies IFileSystem; cross-package type not importable here
			fs: clusterFs as any,
		};
		const builtinCommands = getAllCommands();

		// Discover remote MCP servers from the hosts table and create proxy commands
		// that relay tool calls to the remote host via the sync outbox.
		const { commands: remoteMcpCommands, remoteServerNames } = generateRemoteMCPProxyCommands(
			appContext.db,
			appContext.siteId,
			mcpServerNames,
		);
		if (remoteMcpCommands.length > 0) {
			appContext.logger.info(
				`[mcp] Registered ${remoteMcpCommands.length} remote server proxy(s): ${Array.from(remoteServerNames).join(", ")}`,
			);
		}

		const allDefinitions = [...builtinCommands, ...mcpCommands, ...remoteMcpCommands];
		setCommandRegistry(allDefinitions, mcpServerNames, remoteServerNames);
		// biome-ignore lint/suspicious/noExplicitAny: commandContext is typed as Record for late modelRouter injection
		const registeredCommands = createDefineCommands(allDefinitions, commandContext as any);
		// Restore previously persisted VFS state from the files table BEFORE
		// creating the sandbox, so that hydrated files are not counted against
		// the memory threshold (which only limits new agent-written content).
		await hydrateWorkspace(clusterFs, appContext.db);

		sandbox = await createSandbox({
			clusterFs,
			commands: registeredCommands,
		});
		appContext.logger.info(
			`[sandbox] ${builtinCommands.length} built-in + ${mcpCommands.length} MCP commands registered`,
		);
		appContext.logger.info("[sandbox] Sandbox ready");
	} catch (error) {
		appContext.logger.warn("[sandbox] Failed to create sandbox", { error: formatError(error) });
	}

	// 10. Persona loading
	appContext.logger.info("Loading persona...");
	let personaText: string | null = null;
	{
		const personaPath = resolve(configDir, "persona.md");
		if (existsSync(personaPath)) {
			try {
				personaText = readFileSync(personaPath, "utf-8");
				appContext.logger.info(`[persona] Loaded persona (${personaText.length} chars)`);
			} catch (error) {
				appContext.logger.warn("[persona] Failed to read persona.md:", {
					error: formatError(error),
				});
			}
		} else {
			appContext.logger.info("[persona] No persona configured");
		}
	}

	return { sandbox, clusterFsObj, commandContext, personaText };
}

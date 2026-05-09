import type { Database } from "bun:sqlite";
import type { Logger, TypedEventEmitter } from "@bound/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export interface PlatformServerEntry {
	name: string;
	server: Server;
	client: Client;
	clientTransport: InMemoryTransport;
	serverTransport: InMemoryTransport;
}

export interface PlatformMcpRegistryDeps {
	db: Database;
	siteId: string;
	eventBus: TypedEventEmitter;
	logger: Logger;
}

/**
 * Manages MCP server instances for platform connectors.
 * Creates InMemoryTransport pairs, connects clients to servers,
 * and manages the lifecycle of platform MCP connections.
 */
export class PlatformMcpRegistry {
	private servers = new Map<string, PlatformServerEntry>();
	private deps: PlatformMcpRegistryDeps;

	constructor(deps: PlatformMcpRegistryDeps) {
		this.deps = deps;
	}

	/**
	 * Registers a platform MCP server and establishes an in-process connection.
	 * Creates an InMemoryTransport pair, connects client and server.
	 */
	async registerServer(name: string, server: Server): Promise<PlatformServerEntry> {
		if (this.servers.has(name)) {
			throw new Error(`Platform server '${name}' already registered`);
		}

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

		const client = new Client(
			{ name: `bound-platform-${name}`, version: "1.0.0" },
			{ capabilities: {} },
		);

		// Connect both sides — server connects to its transport, client connects to its transport
		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const entry: PlatformServerEntry = {
			name,
			server,
			client,
			clientTransport,
			serverTransport,
		};

		this.servers.set(name, entry);
		this.deps.logger.info(`Platform MCP server '${name}' registered and connected`);

		return entry;
	}

	/**
	 * Unregisters a platform MCP server and tears down its transport.
	 */
	async unregisterServer(name: string): Promise<void> {
		const entry = this.servers.get(name);
		if (!entry) {
			return;
		}

		await entry.client.close();
		await entry.server.close();
		this.servers.delete(name);
		this.deps.logger.info(`Platform MCP server '${name}' unregistered`);
	}

	/**
	 * Returns the MCP client for a given platform server name.
	 */
	getClient(name: string): Client | undefined {
		return this.servers.get(name)?.client;
	}

	/**
	 * Returns all registered server names.
	 */
	getServerNames(): string[] {
		return Array.from(this.servers.keys());
	}

	/**
	 * Returns a server entry by name.
	 */
	getServerEntry(name: string): PlatformServerEntry | undefined {
		return this.servers.get(name);
	}

	/**
	 * Tears down all registered servers. Called on shutdown or leader loss.
	 */
	async shutdown(): Promise<void> {
		const names = Array.from(this.servers.keys());
		for (const name of names) {
			await this.unregisterServer(name);
		}
	}
}

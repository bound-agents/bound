import { Bash, type CustomCommand, type NetworkConfig } from "just-bash";
import type { MountableFs } from "just-bash";
import {
	type MemoryThresholdResult,
	MemoryTracker,
	wrapWithMemoryTracking,
} from "./memory-tracker";
import { materializeSandboxRuntime } from "./runtime/materialize";
import { UrlFilter } from "./url-filter";

export interface ExecutionLimits {
	maxCallDepth?: number;
	maxCommandCount?: number;
	maxLoopIterations?: number;
}

export interface SandboxConfig {
	clusterFs: MountableFs;
	commands: CustomCommand[];
	networkConfig?: NetworkConfig;
	executionLimits?: ExecutionLimits;
	/** Memory threshold in bytes for the in-memory filesystem. Defaults to 50MB. */
	memoryThresholdBytes?: number;
	/** Allowed URL prefixes for outbound requests. Empty array allows all. */
	allowedUrlPrefixes?: string[];
}

export interface Sandbox {
	bash: Bash;
	/** Check current memory usage against the configured threshold. */
	checkMemoryThreshold: () => MemoryThresholdResult;
	/** Get the memory tracker instance for direct access. */
	memoryTracker: MemoryTracker;
	/** URL filter for enforcing outbound request allowlist. */
	urlFilter: UrlFilter;
}

export async function createSandbox(config: SandboxConfig): Promise<Sandbox> {
	// Materialize embedded worker assets to disk before any python3/js-exec
	// command can spawn its Worker. Idempotent after the first call per
	// process — see packages/sandbox/src/runtime/materialize.ts for why
	// this copy step is load-bearing under `bun build --compile`.
	materializeSandboxRuntime();

	// Set up memory tracking on the filesystem
	const memoryTracker = new MemoryTracker(config.memoryThresholdBytes);
	wrapWithMemoryTracking(config.clusterFs, memoryTracker);

	// Create URL filter
	const urlFilter = new UrlFilter(config.allowedUrlPrefixes ?? []);

	const bashOptions: ConstructorParameters<typeof Bash>[0] = {
		fs: config.clusterFs,
		customCommands: config.commands,
		python: true,
		javascript: true,
	};

	// Apply network configuration if provided
	if (config.networkConfig) {
		bashOptions.network = config.networkConfig;
	}

	// Apply execution limits if provided
	if (config.executionLimits) {
		bashOptions.executionLimits = {
			maxCallDepth: config.executionLimits.maxCallDepth ?? 50,
			maxCommandCount: config.executionLimits.maxCommandCount ?? 10000,
			maxLoopIterations: config.executionLimits.maxLoopIterations ?? 10000,
		};
	} else {
		// Apply defaults from spec
		bashOptions.executionLimits = {
			maxCallDepth: 50,
			maxCommandCount: 10000,
			maxLoopIterations: 10000,
		};
	}

	const bash = new Bash(bashOptions);

	return {
		bash,
		checkMemoryThreshold: () => memoryTracker.checkMemoryThreshold(),
		memoryTracker,
		urlFilter,
	};
}

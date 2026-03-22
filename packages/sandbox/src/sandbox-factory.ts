import { Bash, type CustomCommand, type NetworkConfig } from "just-bash";
import type { MountableFs } from "just-bash";

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
}

export async function createSandbox(config: SandboxConfig): Promise<Bash> {
	const bashOptions: ConstructorParameters<typeof Bash>[0] = {
		fs: config.clusterFs,
		customCommands: config.commands,
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

	return new Bash(bashOptions);
}

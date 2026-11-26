import { Bash, type CustomCommand, type ExecOptions } from "just-bash";
import type { MountableFs } from "just-bash";
import {
	type MemoryThresholdResult,
	MemoryTracker,
	wrapWithMemoryTracking,
} from "./memory-tracker";
import { materializeSandboxRuntime } from "./runtime/materialize";
import { UrlFilter } from "./url-filter";

/**
 * The sandbox's only exec seam. just-bash's default script normalization
 * `trimStart()`s every non-heredoc line without tracking quotes, so indentation
 * inside a quoted multiline argument is silently dropped (#308, #319). Every
 * exec is forced to `rawScript: true`; all other options (signal, cwd, env,
 * stdin) pass through. The interpreter re-enters through `this.exec`, so nested
 * `bash -c` and `source` inherit the flag. Never construct a just-bash `Bash`
 * anywhere else — `scripts/validate-sandbox-exec-seam.ts` enforces it.
 */
class RawScriptBash extends Bash {
	override exec(commandLine: string, options?: ExecOptions) {
		return super.exec(commandLine, { ...options, rawScript: true });
	}
}

export interface SandboxConfig {
	clusterFs: MountableFs;
	commands: CustomCommand[];
	/** Memory threshold in bytes for the in-memory filesystem. Defaults to 500MB. */
	memoryThresholdBytes?: number;
	/** Allowed URL prefixes for outbound requests. Empty array allows all. */
	allowedUrlPrefixes?: string[];
}

export interface Sandbox {
	bash: Bash;
	checkMemoryThreshold: () => MemoryThresholdResult;
	memoryTracker: MemoryTracker;
	/** Outbound request allowlist; callers must check it before fetching. */
	urlFilter: UrlFilter;
}

export async function createSandbox(config: SandboxConfig): Promise<Sandbox> {
	// Materialize embedded worker assets to disk before any python3/js-exec
	// command can spawn its Worker. Idempotent after the first call per
	// process — see packages/sandbox/src/runtime/materialize.ts for why
	// this copy step is load-bearing under `bun build --compile`.
	materializeSandboxRuntime();

	const memoryTracker = new MemoryTracker(config.memoryThresholdBytes);
	wrapWithMemoryTracking(config.clusterFs, memoryTracker);
	const urlFilter = new UrlFilter(config.allowedUrlPrefixes ?? []);

	const bashOptions: ConstructorParameters<typeof Bash>[0] = {
		fs: config.clusterFs,
		customCommands: config.commands,
		python: true,
		javascript: true,
		executionLimits: { maxCallDepth: 50, maxCommandCount: 10000, maxLoopIterations: 10000 },
	};

	const bash = new RawScriptBash(bashOptions);

	return {
		bash,
		checkMemoryThreshold: () => memoryTracker.checkMemoryThreshold(),
		memoryTracker,
		urlFilter,
	};
}

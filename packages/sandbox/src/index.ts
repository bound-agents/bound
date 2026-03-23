export {
	createClusterFs,
	snapshotWorkspace,
	diffWorkspace,
	diffWorkspaceAsync,
	hydrateWorkspace,
	hydrateRemoteCache,
	type ClusterFsConfig,
	type ClusterFsResult,
	type StalenessResult,
	type FileChange,
} from "./cluster-fs";

export {
	persistWorkspaceChanges,
	type PersistResult,
	type PersistError,
	type PersistOptions,
} from "./fs-persist";

export {
	createDefineCommands,
	type CommandDefinition,
	type CommandResult,
	type CommandContext,
} from "./commands";

export {
	createSandbox,
	type SandboxConfig,
	type ExecutionLimits,
	type Sandbox,
} from "./sandbox-factory";

export {
	MemoryTracker,
	wrapWithMemoryTracking,
	type MemoryThresholdResult,
} from "./memory-tracker";

export type { ScanResult } from "./overlay-scanner";
export { scanOverlayIndex, startOverlayScanLoop } from "./overlay-scanner";

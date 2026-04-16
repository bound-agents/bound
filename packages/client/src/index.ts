// Client classes
export { BoundClient, BoundNotRunningError, BoundApiError } from "./client.js";
export { BoundSocket } from "./socket.js";

// API-specific types
export type {
	ThreadListEntry,
	ThreadStatus,
	SendMessageOptions,
	RedactMessageResult,
	RedactThreadResult,
	FileListEntry,
	TaskListEntry,
	AdvisoryCount,
	HostStatus,
	NetworkStatus,
	ClusterModelInfo,
	ModelsResponse,
	CancelResult,
	MemoryGraphNode,
	MemoryGraphEdge,
	MemoryGraphResponse,
	ContextDebugSection,
	CrossThreadSource,
	ContextDebugInfo,
	ContextDebugTurn,
	CreateMcpThreadResult,
	ApiErrorBody,
	BoundSocketEvents,
} from "./types.js";

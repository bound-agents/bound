// Client classes
export { BoundClient, BoundNotRunningError, BoundApiError } from "./client.js";

// Tracing utilities
export {
	createClientTracingSession,
	type ClientTracingSession,
	type ClientToolTracingResult,
	type WrapToolCallOptions,
} from "./tracing.js";

// API-specific types
export type {
	ThreadListEntry,
	ThreadStatus,
	CreateThreadOptions,
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
	CacheMarker,
	CreateMcpThreadResult,
	ApiErrorBody,
	BoundClientEvents,
	ConnectionState,
	ToolDefinition,
	ToolCallRequest,
	ToolCallResult,
	ToolCancelEvent,
	WebhookListEntry,
	WebhookCreateResponse,
	WebhookRotateResponse,
	CreateWebhookOptions,
	UpdateWebhookOptions,
} from "./types.js";

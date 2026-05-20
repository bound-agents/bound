// Client classes
export { BoundClient, BoundNotRunningError, BoundApiError } from "./client.js";

// Tracing utilities
export {
	withClientToolTracing,
	type ClientToolTracingResult,
	type ClientToolTracingOptions,
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
	CreateMcpThreadResult,
	ApiErrorBody,
	BoundClientEvents,
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

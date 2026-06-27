import type { ToolAnnotations } from "./types";

export interface RelayWaitLikeResult {
	content: string;
	retriable?: boolean;
	definitely_not_executed?: boolean;
}

export interface ShouldRetryRelayCallInput {
	waitResult: RelayWaitLikeResult;
	attempt: number;
	maxAttempts: number;
	aborted: boolean;
	annotations?: ToolAnnotations;
}

export function shouldRetryRelayCall(input: ShouldRetryRelayCallInput): boolean {
	if (input.aborted) return false;
	if (input.attempt >= input.maxAttempts) return false;
	if (!input.waitResult.retriable) return false;
	if (input.waitResult.definitely_not_executed === true) return true;
	if (input.annotations?.readOnly === true) return true;
	if (input.annotations?.idempotent === true) return true;
	return false;
}

export function resolveToolAnnotations(
	registry: Map<
		string,
		{ resolveAnnotations?: (args: Record<string, unknown>) => ToolAnnotations } & ToolAnnotations
	>,
	toolName: string,
	args: Record<string, unknown>,
): ToolAnnotations {
	const tool = registry.get(toolName);
	if (!tool) return {};
	if (tool.resolveAnnotations) {
		return tool.resolveAnnotations(args);
	}
	const result: ToolAnnotations = {};
	if (tool.idempotent !== undefined) result.idempotent = tool.idempotent;
	if (tool.readOnly !== undefined) result.readOnly = tool.readOnly;
	return result;
}

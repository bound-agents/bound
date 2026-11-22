export type {
	LLMBackend,
	BackendReadiness,
	ModelDescriptor,
	ModelRegistrar,
	ChatParams,
	LLMMessage,
	ContentBlock,
	ImageMediaType,
	StreamChunk,
	LLMFinishReason,
	BackendCapabilities,
	CapabilityRequirements,
	ToolDefinition,
	BackendConfig,
	ModelBackendsConfig,
	InferenceRequestPayload,
	StreamChunkPayload,
	StreamEndPayload,
} from "./types";
export { LLMError } from "./types";

export type {
	DriverFallbackSupport,
	ModelFallbackPolicy,
	ResolvedFallbackChain,
	ResolveFallbackChainArgs,
} from "./fallback-policy";
export { resolveFallbackChain } from "./fallback-policy";
export type {
	CreditIneligibleReason,
	CreditRedemptionContext,
	CreditRedemptionPlan,
	CreditStep,
	CreditStepKind,
} from "./fallback-credit";
export { isTransientRedemptionError, planCreditRedemption } from "./fallback-credit";

export { AnthropicDriver } from "./drivers/anthropic";

export { BedrockDriver } from "./drivers/bedrock";

export { BedrockMantleDriver } from "./drivers/bedrock-mantle";

export { OpenAICompatibleDriver } from "./drivers/openai-compatible";

export { OpenCodeGoDriver } from "./drivers/opencode-go";

export { ChatGptOAuthDriver } from "./drivers/chatgpt-oauth/driver";

export { FileTokenStore, TokenManager } from "./drivers/chatgpt-oauth/token-store";

export {
	buildAuthorizeUrl,
	CHATGPT_OAUTH_REDIRECT_URI,
	exchangeCodeForTokens,
	extractIdClaims,
	generatePkce,
	generateState,
	type ChatGptTokens,
} from "./drivers/chatgpt-oauth/auth-core";

export { GitHubCopilotDriver } from "./drivers/github-copilot/driver";

export { CopilotTokenManager, FileCopilotTokenStore } from "./drivers/github-copilot/token-store";

export {
	COPILOT_CLIENT_ID,
	type AuthCoreDeps,
	fetchAccountInfo,
	pollDeviceToken,
	refreshTokens,
	startDeviceFlow,
	validateCopilotApiEndpoint,
	type CopilotAccountInfo,
	type CopilotTokens,
	type DeviceCodeGrant,
	type DevicePollResult,
} from "./drivers/github-copilot/auth-core";

export { UmansDriver, type UmansAccount } from "./drivers/umans";

export {
	fetchUmansModelMetadata,
	fetchUmansUsage,
	deriveUmansTiers,
	UMANS_ANTHROPIC_BASE,
	UMANS_OPENAI_BASE,
	type UmansModelMeta,
	type UmansUsage,
} from "./umans-metadata";
export {
	createModelRouter,
	ModelRouter,
	makeRouteId,
	type BackendInfo,
	type RouteEntry,
	type RouteId,
} from "./model-router";
export {
	markAwsCredentialCacheStale,
	consumeAwsCredentialCacheBust,
	resolveAwsCredentials,
} from "./drivers/aws-credential-cache";

export {
	sniffImageMediaType,
	correctMediaType,
	PROVIDER_IMAGE_BASE64_MAX_BYTES,
	PROVIDER_IMAGE_RAW_MAX_BYTES,
} from "./image-utils";

export { installAiSdkWarningHook, uninstallAiSdkWarningHook } from "./ai-sdk-warning-hook";

export { createLoggingFetch } from "./fetch-logger";

export {
	LLMRefusalError,
	classifyGeminiInteractions400,
	type ModelDeclinedOutcome,
} from "./model-declined";

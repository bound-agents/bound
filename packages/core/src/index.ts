export { createDatabase, getSiteId } from "./database";
export { applySchema, installRowHashInvalidationTriggers } from "./schema";
export {
	getSyncedTableSchemas,
	type ColumnInfo,
	type TableSchemaInfo,
} from "./schema-introspection";
export {
	createChangeLogEntry,
	setChangelogEventBus,
	withChangeLog,
	withTx,
	insertRow,
	updateRow,
	updateRowIf,
	softDelete,
	dangerouslyExecuteRawWrite,
	insertMessage,
	readMessageMetadata,
	writeMessageMetadata,
	validateColumnName,
	getPkColumn,
} from "./change-log";
export {
	getCachedRowStateHashes,
	computeRowStateHash,
	type CachedRowStateHashes,
} from "./row-hash-cache";
export {
	syncableRowPredicate,
	syncableWhereClause,
	getLocalPksSorted,
	getBackfillablePksSorted,
	getBackfillableEntriesSorted,
	mergeDiffPks,
	mergeDiffEntries,
	hashRow,
	compareAllTables,
	countUnsyncableLocalOnly,
	type TableDiff,
	type ConsistencyEntry,
	type ConsistencyDiff,
} from "./consistency";
export {
	loadConfigFile,
	loadConfigWithPrecedence,
	loadModelBackendsConfig,
	loadRequiredConfigs,
	loadOptionalConfigs,
	expandEnvVars,
	resolveRelayConfig,
	type ConfigError,
	type RequiredConfig,
	type OptionalConfigs,
} from "./config-loader";
export {
	bootstrapContainer,
	DatabaseService,
	ConfigService,
	EventBusService,
	LoggerService,
	container,
} from "./container";
export { createAppContext, type AppContext } from "./app-context";
export {
	InMemoryTurnStateStore,
	type TurnStateStore,
} from "./turn-state-store";
export {
	applyMetricsSchema,
	recordTurn,
	recordContextDebug,
	getDailySpend,
	type TurnRecord,
} from "./metrics-schema";
export {
	recordRelayCycle,
	recordTurnRelayMetrics,
	pruneRelayCycles,
	type RelayCycleEntry,
} from "./relay-metrics";
export {
	writeOutbox,
	readUndelivered,
	markDelivered,
	markDeliveredForTarget,
	readUnprocessed,
	insertInbox,
	markProcessed,
	pruneRelayTables,
	readInboxByRefId,
	readInboxByStreamId,
	readUnprocessedInboxByRefId,
	findStaleUnprocessedIntake,
	type StaleIntakeGroup,
	PayloadTooLargeError,
	setRelayOutboxEventBus,
} from "./relay";
export {
	enqueueMessage,
	enqueueNotification,
	enqueueClientToolCall,
	enqueueToolResult,
	acknowledgeClientToolCall,
	acknowledgeToolResultForCall,
	claimPending,
	acknowledgeBatch,
	resetProcessing,
	resetProcessingForThread,
	pruneAcknowledged,
	hasPending,
	hasPendingClientToolCalls,
	hasInFlightClientToolCallsForConnection,
	getPendingClientToolCalls,
	expireClientToolCalls,
	expireClientToolCallsForConnection,
	cancelClientToolCalls,
	updateClaimedBy,
	CLIENT_TOOL_CALL,
	TOOL_RESULT,
	resolveDeferredToolResult,
	type DispatchEntry,
} from "./dispatch";
export {
	insertDurableWork,
	claimLocalDurableWork,
	acknowledgeDurableWork,
	beginDurableWorkTransfer,
	acknowledgeDurableWorkTransfer,
	resetProcessingDurableWork,
	deadLetterExpiredDurableWork,
	deadLetterDurableWork,
	pruneExpiredDeadLetters,
	validateDurableWork,
	InvalidDurableWorkRowError,
	type DurableWorkRow,
	type NewDurableWork,
	type DurableWorkClaimState,
	type WorkClaimDiscipline,
	type WorkRetirementRule,
} from "./durable-work";
export { ThreadExecutor, type ExecutorRunResult, type ExecutorOptions } from "./thread-executor";
export {
	HOST_HEARTBEAT_INTERVAL,
	startHostHeartbeat,
	type HeartbeatOptions,
} from "./host-heartbeat";
export {
	PLATFORM_HOST_STALE_THRESHOLD_MS,
	isHostFresh,
	findFreshPlatformHost,
	listFreshRemotePlatforms,
} from "./platform-routing";
export {
	CANONICAL_RELATIONS,
	type CanonicalRelation,
	isCanonicalRelation,
	InvalidRelationError,
	SPELLING_VARIANTS,
	FALLBACK_RELATION,
	normalizeRelationValue,
} from "./memory-relations";
export { normalizeEdgeRelations, type NormalizationSummary } from "./normalize-edge-relations";
// Read repository layer (synced-table SELECT helpers). Writes go through change-log.ts.
export * from "./repositories";

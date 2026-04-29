// @bound/sync — Event-sourced sync protocol with Ed25519 authentication

// Crypto and signing
export {
	ensureKeypair,
	generateKeypair,
	deriveSiteId,
	exportPublicKey,
	exportPrivateKey,
	importPublicKey,
	importPrivateKey,
} from "./crypto.js";
export { signRequest } from "./signing.js";

// Relay wire format
export type { RelayRequest, RelayResponse } from "./changeset.js";
export { chunkChangeset, DEFAULT_MAX_CHUNK_BYTES } from "./changeset.js";
export type { RelayExecutor } from "./relay-executor.js";
export { noopRelayExecutor } from "./relay-executor.js";

// Pruning
export { startPruningLoop } from "./pruning.js";

// Encryption and key management
export {
	encryptBody,
	decryptBody,
	deriveSharedSecret,
	ed25519ToX25519Public,
	ed25519ToX25519Private,
	computeFingerprint,
	extractRawEd25519Keys,
} from "./encryption.js";
export { KeyManager } from "./key-manager.js";

// WebSocket frame codec
export {
	encodeFrame,
	decodeFrame,
	WsMessageType,
	type WsFrame,
	type WsFrameError,
	type ChangelogPushPayload,
	type ChangelogAckPayload,
	type RelaySendPayload,
	type RelayDeliverPayload,
	type RelayAckPayload,
	type DrainRequestPayload,
	type DrainCompletePayload,
	type SnapshotBeginPayload,
	type SnapshotChunkPayload,
	type SnapshotEndPayload,
	type SnapshotAckPayload,
	type ReseedRequestPayload,
	type ConsistencyRequestPayload,
	type ConsistencyResponsePayload,
	type ErrorPayload,
} from "./ws-frames.js";

// WebSocket server
export {
	authenticateWsUpgrade,
	WsConnectionManager,
	createWsHandlers,
	type WsConnectionData,
	type WsServerConfig,
} from "./ws-server.js";

// WebSocket client
export { WsSyncClient, type WsClientConfig } from "./ws-client.js";

// WebSocket transport (push-on-write changelog replication)
export { WsTransport, type WsTransportConfig } from "./ws-transport.js";
export { MicrotaskCoalescer } from "./ws-coalescer.js";

// Reducers and column cache
export { clearColumnCache, applySnapshotRows } from "./reducers.js";

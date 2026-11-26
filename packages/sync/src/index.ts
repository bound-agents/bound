// @bound/sync — Event-sourced sync protocol with Ed25519 authentication

// Crypto and signing
export {
	ensureKeypair,
	deriveSiteId,
	exportPublicKey,
	importPublicKey,
	importPrivateKey,
} from "./crypto.js";
export { signRequest } from "./signing.js";

// Pruning
export { startPruningLoop, drainFreelistOnStartup } from "./pruning.js";

// Encryption and key management
export {
	encryptBody,
	decryptBody,
	deriveSharedSecret,
	ed25519ToX25519Public,
	ed25519ToX25519Private,
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
	type SpoolTransferPayload,
	type SpoolTransferAckPayload,
	type DrainRequestPayload,
	type DrainCompletePayload,
	type SnapshotBeginPayload,
	type SnapshotChunkPayload,
	type SnapshotEndPayload,
	type SnapshotAckPayload,
	type ReseedRequestPayload,
	type ConsistencyRequestPayload,
	type ConsistencyResponsePayload,
	type RowPullRequestPayload,
	type RowPullResponsePayload,
	type RowPullAckPayload,
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

// Reducers and column cache
export { clearColumnCache, applyLWWReducer } from "./reducers.js";

// Peer sync cursors — getConfirmedSyncWatermark is the sole anchor authority
// for delegation range segments (R-UD11).
export { getPeerCursor, updatePeerCursor, getConfirmedSyncWatermark } from "./peer-cursor.js";

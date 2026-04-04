// @bound/sync — Event-sourced sync protocol with Ed25519 authentication

// Crypto and signing
export { ensureKeypair } from "./crypto.js";
export { signRequest } from "./signing.js";

// Middleware
export { createSyncAuthMiddleware } from "./middleware.js";

// Client and loop
export { SyncClient } from "./sync-loop.js";
export { startSyncLoop } from "./sync-loop.js";

// Routes
export { createSyncRoutes } from "./routes.js";

// Relay wire format
export type { RelayRequest, RelayResponse } from "./changeset.js";
export type { RelayExecutor } from "./relay-executor.js";
export { noopRelayExecutor } from "./relay-executor.js";

// Reachability tracking
export { ReachabilityTracker } from "./reachability.js";

// Eager push
export type { EagerPushConfig } from "./eager-push.js";
export { eagerPushToSpoke } from "./eager-push.js";

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
export { SyncTransport } from "./transport.js";
export type { TransportResponse } from "./transport.js";

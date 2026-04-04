import type { KeyringConfig } from "@bound/shared";
import {
	computeFingerprint,
	deriveSharedSecret,
	ed25519ToX25519Private,
	ed25519ToX25519Public,
	extractRawEd25519Keys,
} from "./encryption.js";

interface PeerCrypto {
	symmetricKey: Uint8Array;
	fingerprint: string;
}

export class KeyManager {
	private localX25519Priv: Uint8Array | null = null;
	private localX25519Pub: Uint8Array | null = null;
	private localFingerprint: string | null = null;
	private peers: Map<string, PeerCrypto> = new Map();

	constructor(
		private readonly localKeypair: { publicKey: CryptoKey; privateKey: CryptoKey },
		private readonly siteId: string,
	) {}

	/**
	 * Initialize the KeyManager: derive X25519 keys from Ed25519 identity,
	 * then compute shared secrets for all keyring peers.
	 * Must be called before any other method.
	 * Throws on key derivation failure (caller should treat as FATAL per R-SE19).
	 */
	async init(keyring: KeyringConfig): Promise<void> {
		const { pubRaw, privRaw } = await extractRawEd25519Keys(this.localKeypair);

		this.localX25519Priv = ed25519ToX25519Private(privRaw);
		this.localX25519Pub = ed25519ToX25519Public(pubRaw);
		this.localFingerprint = computeFingerprint(this.localX25519Pub);

		this.computePeerSecrets(keyring);
	}

	getSymmetricKey(siteId: string): Uint8Array | null {
		return this.peers.get(siteId)?.symmetricKey ?? null;
	}

	getFingerprint(siteId: string): string | null {
		return this.peers.get(siteId)?.fingerprint ?? null;
	}

	getLocalFingerprint(): string {
		if (!this.localFingerprint) {
			throw new Error("KeyManager not initialized");
		}
		return this.localFingerprint;
	}

	/**
	 * Reload keyring: evict removed peers, derive new/changed peers,
	 * preserve unchanged peers (no unnecessary recomputation).
	 * Uses fingerprint-keyed map for O(n) lookup of existing peers.
	 */
	reloadKeyring(newKeyring: KeyringConfig): void {
		if (!this.localX25519Priv) {
			throw new Error("KeyManager not initialized");
		}

		// Build fingerprint -> PeerCrypto + siteId map from old peers for O(n) lookup
		const oldByFingerprint = new Map<string, { siteId: string; peer: PeerCrypto }>();
		for (const [siteId, peer] of this.peers) {
			oldByFingerprint.set(peer.fingerprint, { siteId, peer });
		}

		const newPeers = new Map<string, PeerCrypto>();

		for (const [hostName, hostConfig] of Object.entries(newKeyring.hosts)) {
			// Skip self
			if (hostName === this.siteId) continue;

			const peerX25519Pub = this.deriveX25519PubFromEd25519Encoded(hostConfig.public_key);
			const fingerprint = computeFingerprint(peerX25519Pub);

			// Preserve unchanged peers (same fingerprint = same key = same shared secret)
			const existing = oldByFingerprint.get(fingerprint);
			if (existing) {
				newPeers.set(hostName, existing.peer);
				continue;
			}

			// Derive new shared secret for new/changed peer
			const symmetricKey = deriveSharedSecret(this.localX25519Priv, peerX25519Pub);
			newPeers.set(hostName, { symmetricKey, fingerprint });
		}

		this.peers = newPeers;
	}

	private computePeerSecrets(keyring: KeyringConfig): void {
		if (!this.localX25519Priv) {
			throw new Error("KeyManager not initialized");
		}

		this.peers.clear();

		for (const [hostName, hostConfig] of Object.entries(keyring.hosts)) {
			// Skip self
			if (hostName === this.siteId) continue;

			const peerX25519Pub = this.deriveX25519PubFromEd25519Encoded(hostConfig.public_key);
			const fingerprint = computeFingerprint(peerX25519Pub);
			const symmetricKey = deriveSharedSecret(this.localX25519Priv, peerX25519Pub);

			this.peers.set(hostName, { symmetricKey, fingerprint });
		}
	}

	/**
	 * Derive X25519 public key from an ed25519:-prefixed public key string.
	 * Reuses the import path from crypto.ts (SPKI base64 with ed25519: prefix).
	 */
	private deriveX25519PubFromEd25519Encoded(encodedPubKey: string): Uint8Array {
		// Strip "ed25519:" prefix and decode base64 SPKI
		const prefix = "ed25519:";
		if (!encodedPubKey.startsWith(prefix)) {
			throw new Error(`Invalid public key format: missing '${prefix}' prefix`);
		}
		const spkiBase64 = encodedPubKey.slice(prefix.length);
		const spkiBytes = Uint8Array.from(atob(spkiBase64), (c) => c.charCodeAt(0));

		// SPKI for Ed25519 is 44 bytes: 12-byte header + 32-byte public key
		// The raw public key is the last 32 bytes
		const rawPubKey = spkiBytes.slice(-32);

		return ed25519ToX25519Public(rawPubKey);
	}
}

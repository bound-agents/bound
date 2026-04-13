import type { Logger } from "@bound/shared";
import { decryptBody, encryptBody } from "./encryption.js";
import type { KeyManager } from "./key-manager.js";
import { signRequest } from "./signing.js";

export interface TransportResponse {
	status: number;
	body: string;
	headers: Headers;
}

export class SyncTransport {
	constructor(
		private keyManager: KeyManager,
		private privateKey: CryptoKey,
		private siteId: string,
		private logger?: Logger,
	) {}

	/**
	 * Send an encrypted, signed request to a sync peer.
	 *
	 * Pipeline: JSON string -> encode -> encrypt -> sign(ciphertext) -> fetch -> decrypt response
	 *
	 * @param method HTTP method (POST for all sync endpoints)
	 * @param url Full URL (e.g., "http://hub:3000/sync/push")
	 * @param path URL path component for signature (e.g., "/sync/push")
	 * @param body JSON string to encrypt and send
	 * @param targetSiteId Site ID of the target host (for symmetric key lookup)
	 * @param signal Optional AbortSignal for request timeout
	 */
	async send(
		method: string,
		url: string,
		path: string,
		body: string,
		targetSiteId: string,
		signal?: AbortSignal,
	): Promise<TransportResponse> {
		const symmetricKey = this.keyManager.getSymmetricKey(targetSiteId);
		if (!symmetricKey) {
			throw new Error(`No symmetric key for peer ${targetSiteId}`);
		}

		// Encrypt
		const plaintext = new TextEncoder().encode(body);
		const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);

		// Sign the ciphertext (R-SE6: signature covers ciphertext, not plaintext)
		const signHeaders = await signRequest(this.privateKey, this.siteId, method, path, ciphertext);

		// Log sending of encrypted request
		const nonceHex = Buffer.from(nonce).toString("hex");
		this.logger?.debug("Sending encrypted request", {
			endpoint: path,
			targetSiteId,
			ciphertextLength: ciphertext.length,
			nonce: nonceHex,
		});

		// Fetch with encryption headers
		const response = await fetch(url, {
			method,
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Encryption": "xchacha20",
				"X-Nonce": nonceHex,
				"X-Key-Fingerprint": this.keyManager.getLocalFingerprint(),
				...signHeaders,
			},
			body: Buffer.from(ciphertext),
			signal,
		});

		// Decrypt response if encrypted
		const responseBody = await this.decryptResponse(response, targetSiteId);

		return {
			status: response.status,
			body: responseBody,
			headers: response.headers,
		};
	}

	/**
	 * Decrypt response body if X-Encryption header is present.
	 * If absent (e.g., plaintext error response per R-SE22), return raw text.
	 */
	private async decryptResponse(response: Response, targetSiteId: string): Promise<string> {
		const encryption = response.headers.get("X-Encryption");

		if (!encryption) {
			// Plaintext response (error responses per R-SE22)
			const text = await response.text();
			if (response.status >= 400) {
				this.logger?.warn("Received plaintext error response", {
					status: response.status,
					targetSiteId,
				});
			}
			return text;
		}

		const nonceHex = response.headers.get("X-Nonce");
		if (!nonceHex || nonceHex.length !== 48) {
			throw new Error(
				`Invalid X-Nonce in response: expected 48 hex chars, got ${nonceHex?.length ?? "null"}`,
			);
		}

		const symmetricKey = this.keyManager.getSymmetricKey(targetSiteId);
		if (!symmetricKey) {
			throw new Error(`No symmetric key for peer ${targetSiteId} to decrypt response`);
		}

		const nonce = Buffer.from(nonceHex, "hex");
		const ciphertext = new Uint8Array(await response.arrayBuffer());
		const plaintext = decryptBody(ciphertext, nonce, symmetricKey);
		return new TextDecoder().decode(plaintext);
	}
}

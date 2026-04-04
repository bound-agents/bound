import type { KeyringConfig } from "@bound/shared";
import type { Context, MiddlewareHandler } from "hono";
import { decryptBody, encryptBody } from "./encryption.js";
import type { KeyManager } from "./key-manager.js";
import { detectClockSkew, verifyRequest } from "./signing.js";

type AppContext = {
	Variables: {
		siteId: string;
		hostName: string;
		rawBody: string;
	};
};

export function createSyncAuthMiddleware(
	keyring: KeyringConfig,
	keyManager?: KeyManager,
): MiddlewareHandler<AppContext> {
	return async (c: Context<AppContext>, next) => {
		const method = c.req.method;
		const path = c.req.path;

		// Read body as binary (not text) to support encrypted payloads
		const bodyBytes = new Uint8Array(await c.req.arrayBuffer());

		const headers: Record<string, string> = {};
		c.req.raw.headers.forEach((value, key) => {
			headers[key.toLowerCase()] = value;
		});

		const encryption = headers["x-encryption"];
		const nonceHex = headers["x-nonce"];
		const fingerprint = headers["x-key-fingerprint"];

		if (keyManager) {
			// Step 1: Encryption check — reject plaintext (R-SE10)
			if (!encryption) {
				if (nonceHex) {
					// X-Nonce without X-Encryption is ambiguous (R-SE21, AC8.2)
					return c.json(
						{ error: "malformed_encryption_headers", message: "X-Nonce present without X-Encryption" },
						400,
					);
				}
				return c.json(
					{
						error: "plaintext_rejected",
						message: "Plaintext sync requests are not accepted. Upgrade to a version with sync encryption.",
					},
					400,
				);
			}

			// Step 2: Validate X-Encryption value and X-Nonce presence (R-SE21, AC8.3)
			if (encryption !== "xchacha20") {
				return c.json(
					{ error: "malformed_encryption_headers", message: `Unsupported encryption: ${encryption}` },
					400,
				);
			}
			if (!nonceHex || nonceHex.length !== 48) {
				return c.json(
					{ error: "malformed_encryption_headers", message: "X-Nonce must be 48 hex characters (24 bytes)" },
					400,
				);
			}

			// Step 3: Fingerprint validation (R-SE12, AC3.3)
			const siteIdHeader = headers["x-site-id"];
			if (siteIdHeader && fingerprint) {
				const expectedFingerprint = keyManager.getFingerprint(siteIdHeader);
				if (expectedFingerprint && fingerprint !== expectedFingerprint) {
					return c.json(
						{
							error: "key_mismatch",
							site_id: siteIdHeader,
							expected_fingerprint: expectedFingerprint,
							received_fingerprint: fingerprint,
						},
						400,
					);
				}
			}

			// Step 4: Signature verification over ciphertext (existing, body is now Uint8Array)
			// verifyRequest needs to accept string | Uint8Array body (extended in Phase 2)
			const bodyForVerification = bodyBytes; // ciphertext bytes
			const result = await verifyRequest(keyring, method, path, headers, bodyForVerification);

			if (!result.ok) {
				const error = result.error;
				let statusCode: 401 | 403 | 408 | 500 = 500;
				if (error.code === "unknown_site") statusCode = 403;
				else if (error.code === "invalid_signature") statusCode = 401;
				else if (error.code === "stale_timestamp") statusCode = 408;
				return c.json({ error: error.message }, statusCode);
			}

			c.set("siteId", result.value.siteId);
			c.set("hostName", result.value.hostName);

			// Step 5: Decrypt body (R-SE11, AC6.3)
			const symmetricKey = keyManager.getSymmetricKey(result.value.siteId);
			if (!symmetricKey) {
				return c.json(
					{
						error: "decryption_failed",
						site_id: result.value.siteId,
						hint: "Check that keyring.json is identical on both hosts.",
					},
					400,
				);
			}

			try {
				const nonce = Buffer.from(nonceHex, "hex");
				const plaintext = decryptBody(bodyBytes, nonce, symmetricKey);
				c.set("rawBody", new TextDecoder().decode(plaintext));
			} catch {
				return c.json(
					{
						error: "decryption_failed",
						site_id: result.value.siteId,
						hint: "Check that keyring.json is identical on both hosts.",
					},
					400,
				);
			}
		} else {
			// No encryption — existing signature-only path for single-node
			const body = new TextDecoder().decode(bodyBytes);
			c.set("rawBody", body);

			const result = await verifyRequest(keyring, method, path, headers, body);
			if (!result.ok) {
				const error = result.error;
				let statusCode: 401 | 403 | 408 | 500 = 500;
				if (error.code === "unknown_site") statusCode = 403;
				else if (error.code === "invalid_signature") statusCode = 401;
				else if (error.code === "stale_timestamp") statusCode = 408;
				return c.json({ error: error.message }, statusCode);
			}
			c.set("siteId", result.value.siteId);
			c.set("hostName", result.value.hostName);
		}

		// Clock skew detection (unchanged)
		const remoteTimestamp = headers["x-timestamp"];
		if (remoteTimestamp) {
			const now = new Date().toISOString();
			const skew = detectClockSkew(now, remoteTimestamp);
			if (skew !== null) {
				c.header("X-Clock-Skew", skew.toString());
			}
		}

		// Response encryption hook — encrypt outbound response if keyManager is present
		await next();

		if (keyManager) {
			const spokeSiteId = c.get("siteId");
			if (spokeSiteId) {
				const spokeKey = keyManager.getSymmetricKey(spokeSiteId);
				// Guard: skip if already encrypted (prevent double-encryption)
				const existingContentType = c.res.headers.get("Content-Type");
				if (spokeKey && existingContentType !== "application/octet-stream") {
					// Clone response to avoid consuming the body stream
					const responseBody = await c.res.clone().text();
					const responsePlaintext = new TextEncoder().encode(responseBody);
					const { ciphertext: responseCiphertext, nonce: responseNonce } = encryptBody(
						responsePlaintext,
						spokeKey,
					);
					const responseNonceHex = Buffer.from(responseNonce).toString("hex");

					c.res = new Response(responseCiphertext as BodyInit, {
						status: c.res.status,
						headers: {
							"X-Encryption": "xchacha20",
							"X-Nonce": responseNonceHex,
							"Content-Type": "application/octet-stream",
						},
					});
				}
			}
		}
	};
}

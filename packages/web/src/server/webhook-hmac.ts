import { createHmac, timingSafeEqual } from "node:crypto";
import type { SignatureFormat } from "@bound/shared";

export interface HmacValidationResult {
	valid: boolean;
}

const REPLAY_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Validates webhook signatures in four formats:
 * - GitHub: X-Hub-Signature-256: sha256=<hex>
 * - Stripe: Stripe-Signature: t=<ts>,v1=<hex>
 * - Slack: X-Slack-Signature: v0=<hex> + X-Slack-Request-Timestamp: <unix>
 * - Raw: X-Webhook-Signature: <hex>
 */
export function validateWebhookSignature(
	format: SignatureFormat,
	secret: string,
	headers: Headers,
	rawBody: Buffer,
): HmacValidationResult {
	try {
		switch (format) {
			case "github":
				return validateGitHub(secret, headers, rawBody);
			case "stripe":
				return validateStripe(secret, headers, rawBody);
			case "slack":
				return validateSlack(secret, headers, rawBody);
			case "raw":
				return validateRaw(secret, headers, rawBody);
		}
	} catch {
		return { valid: false };
	}
}

function validateGitHub(secret: string, headers: Headers, rawBody: Buffer): HmacValidationResult {
	const headerValue = headers.get("X-Hub-Signature-256");
	if (!headerValue) {
		return { valid: false };
	}

	// Extract hex from "sha256=<hex>"
	const match = headerValue.match(/^sha256=([a-f0-9]{64})$/);
	if (!match) {
		return { valid: false };
	}

	const providedHex = match[1];
	const expectedHex = createHmac("sha256", secret).update(rawBody).digest("hex");

	return {
		valid: constantTimeEqual(providedHex, expectedHex),
	};
}

function validateStripe(secret: string, headers: Headers, rawBody: Buffer): HmacValidationResult {
	const headerValue = headers.get("Stripe-Signature");
	if (!headerValue) {
		return { valid: false };
	}

	// Parse "t=<ts>,v1=<hex>"
	const tMatch = headerValue.match(/t=(\d+)/);
	const v1Match = headerValue.match(/v1=([a-f0-9]{64})/);

	if (!tMatch || !v1Match) {
		return { valid: false };
	}

	const timestamp = tMatch[1];
	const providedHex = v1Match[1];

	// Check replay protection (5 minute tolerance)
	const now = Math.floor(Date.now() / 1000);
	const ts = Number.parseInt(timestamp, 10);
	if (Number.isNaN(ts) || Math.abs(now - ts) > REPLAY_TOLERANCE_MS / 1000) {
		return { valid: false };
	}

	// Compute HMAC over "<timestamp>.<body>"
	const payload = `${timestamp}.${rawBody.toString("utf-8")}`;
	const expectedHex = createHmac("sha256", secret).update(payload).digest("hex");

	return {
		valid: constantTimeEqual(providedHex, expectedHex),
	};
}

function validateSlack(secret: string, headers: Headers, rawBody: Buffer): HmacValidationResult {
	const signatureHeader = headers.get("X-Slack-Signature");
	const timestampHeader = headers.get("X-Slack-Request-Timestamp");

	if (!signatureHeader || !timestampHeader) {
		return { valid: false };
	}

	// Extract hex from "v0=<hex>"
	const match = signatureHeader.match(/^v0=([a-f0-9]{64})$/);
	if (!match) {
		return { valid: false };
	}

	const providedHex = match[1];

	// Check replay protection (5 minute tolerance)
	const now = Math.floor(Date.now() / 1000);
	const ts = Number.parseInt(timestampHeader, 10);
	if (Number.isNaN(ts) || Math.abs(now - ts) > REPLAY_TOLERANCE_MS / 1000) {
		return { valid: false };
	}

	// Compute HMAC over "v0:<timestamp>:<body>"
	const payload = `v0:${timestampHeader}:${rawBody.toString("utf-8")}`;
	const expectedHex = createHmac("sha256", secret).update(payload).digest("hex");

	return {
		valid: constantTimeEqual(providedHex, expectedHex),
	};
}

function validateRaw(secret: string, headers: Headers, rawBody: Buffer): HmacValidationResult {
	const headerValue = headers.get("X-Webhook-Signature");
	if (!headerValue) {
		return { valid: false };
	}

	// Extract hex (must be exactly 64 chars for SHA256)
	if (!/^[a-f0-9]{64}$/.test(headerValue)) {
		return { valid: false };
	}

	const providedHex = headerValue;
	const expectedHex = createHmac("sha256", secret).update(rawBody).digest("hex");

	return {
		valid: constantTimeEqual(providedHex, expectedHex),
	};
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Both strings must be exactly 64 hex characters (SHA256 digest length).
 */
function constantTimeEqual(a: string, b: string): boolean {
	// Both must be exactly 64 hex chars for SHA256
	if (a.length !== 64 || b.length !== 64) {
		return false;
	}

	const bufA = Buffer.from(a, "hex");
	const bufB = Buffer.from(b, "hex");

	// timingSafeEqual requires buffers of equal length
	if (bufA.length !== bufB.length) {
		return false;
	}

	return timingSafeEqual(bufA, bufB);
}

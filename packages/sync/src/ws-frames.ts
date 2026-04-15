// WebSocket frame codec for sync protocol with XChaCha20-Poly1305 encryption

import type { Result } from "@bound/shared";
import { decryptBody, encryptBody } from "./encryption.js";

/**
 * WebSocket message types for sync protocol.
 * Each type has a unique byte value for wire encoding.
 */
export enum WsMessageType {
	CHANGELOG_PUSH = 0x01,
	CHANGELOG_ACK = 0x02,
	RELAY_SEND = 0x03,
	RELAY_DELIVER = 0x04,
	RELAY_ACK = 0x05,
	DRAIN_REQUEST = 0x06,
	DRAIN_COMPLETE = 0x07,
	ERROR = 0xff,
}

// Payload types for each message kind

export type ChangelogPushPayload = {
	entries: Array<{
		hlc: string;
		table_name: string;
		row_id: string;
		site_id: string;
		row_data: Record<string, unknown>;
	}>;
};

export type ChangelogAckPayload = {
	cursor: string;
};

export type RelaySendPayload = {
	entries: Array<{
		id: string;
		target_site_id: string;
		kind: string;
		payload: unknown;
	}>;
};

export type RelayDeliverPayload = {
	entries: Array<{
		id: string;
		source_site_id: string;
		kind: string;
		payload: unknown;
	}>;
};

export type RelayAckPayload = {
	ids: string[];
};

export type DrainRequestPayload = {
	reason: string;
};

export type DrainCompletePayload = {
	success: boolean;
};

export type ErrorPayload = {
	code: string;
	message: string;
};

// Discriminated union for all frame types
export type WsFrame =
	| {
			type: WsMessageType.CHANGELOG_PUSH;
			payload: ChangelogPushPayload;
	  }
	| {
			type: WsMessageType.CHANGELOG_ACK;
			payload: ChangelogAckPayload;
	  }
	| {
			type: WsMessageType.RELAY_SEND;
			payload: RelaySendPayload;
	  }
	| {
			type: WsMessageType.RELAY_DELIVER;
			payload: RelayDeliverPayload;
	  }
	| {
			type: WsMessageType.RELAY_ACK;
			payload: RelayAckPayload;
	  }
	| {
			type: WsMessageType.DRAIN_REQUEST;
			payload: DrainRequestPayload;
	  }
	| {
			type: WsMessageType.DRAIN_COMPLETE;
			payload: DrainCompletePayload;
	  }
	| {
			type: WsMessageType.ERROR;
			payload: ErrorPayload;
	  };

export type WsFrameError =
	| "frame_too_short"
	| "unknown_type"
	| "decryption_failed"
	| "invalid_payload";

/**
 * Encode a message into a WebSocket frame with XChaCha20-Poly1305 encryption.
 * Frame format: [1 byte type][24 bytes nonce][N bytes ciphertext (includes auth tag)]
 *
 * @param type Message type byte value
 * @param payload JSON-serializable payload object
 * @param symmetricKey 32-byte symmetric key for encryption
 * @returns Uint8Array containing encrypted frame
 */
export function encodeFrame(
	type: WsMessageType,
	payload: unknown,
	symmetricKey: Uint8Array,
): Uint8Array {
	// JSON-stringify and encode to UTF-8
	const jsonStr = JSON.stringify(payload);
	const plaintext = new TextEncoder().encode(jsonStr);

	// Encrypt with random nonce
	const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);

	// Allocate frame: [1 byte type][24 bytes nonce][ciphertext]
	const frameSize = 1 + 24 + ciphertext.length;
	const frame = new Uint8Array(frameSize);

	// Write type byte at offset 0
	frame[0] = type;

	// Write nonce at offset 1..25
	frame.set(nonce, 1);

	// Write ciphertext at offset 25..end
	frame.set(ciphertext, 25);

	return frame;
}

/**
 * Decode a WebSocket frame with XChaCha20-Poly1305 decryption.
 * Validates frame format, type, and decrypts payload.
 * Decryption failures (tampered ciphertext) are handled gracefully
 * and do not throw — they return an error result.
 *
 * @param frame Uint8Array containing encrypted frame
 * @param symmetricKey 32-byte symmetric key for decryption
 * @returns Result with decoded WsFrame on success, WsFrameError on failure
 */
export function decodeFrame(
	frame: Uint8Array,
	symmetricKey: Uint8Array,
): Result<WsFrame, WsFrameError> {
	// Minimum frame size: 1 (type) + 24 (nonce) + 16 (minimum ciphertext with auth tag)
	if (frame.length < 41) {
		return { ok: false, error: "frame_too_short" };
	}

	// Extract type byte at offset 0
	const typeByte = frame[0];

	// Validate type is in enum
	if (!Object.values(WsMessageType).includes(typeByte)) {
		return { ok: false, error: "unknown_type" };
	}

	// Extract 24-byte nonce at offset 1..25
	const nonce = frame.slice(1, 25);

	// Extract ciphertext at offset 25..end
	const ciphertext = frame.slice(25);

	// Attempt decryption
	let plaintext: Uint8Array;
	try {
		plaintext = decryptBody(ciphertext, nonce, symmetricKey);
	} catch {
		// Decryption failed (tampered ciphertext) — return error result
		return { ok: false, error: "decryption_failed" };
	}

	// Decode UTF-8 to string
	const jsonStr = new TextDecoder().decode(plaintext);

	// Parse JSON
	let payload: unknown;
	try {
		payload = JSON.parse(jsonStr);
	} catch {
		return { ok: false, error: "invalid_payload" };
	}

	// Return discriminated union based on type
	const framePayload = { type: typeByte as WsMessageType, payload } as unknown;
	return { ok: true, value: framePayload as WsFrame };
}

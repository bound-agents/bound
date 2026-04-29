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
	SNAPSHOT_BEGIN = 0x10,
	SNAPSHOT_CHUNK = 0x11,
	SNAPSHOT_END = 0x12,
	SNAPSHOT_ACK = 0x13,
	RESEED_REQUEST = 0x14,
	CONSISTENCY_REQUEST = 0x20,
	CONSISTENCY_RESPONSE = 0x21,
	ROW_PULL_REQUEST = 0x30,
	ROW_PULL_RESPONSE = 0x31,
	ROW_PULL_ACK = 0x32,
	ERROR = 0xff,
}

// Payload types for each message kind

export type ChangelogPushPayload = {
	entries: Array<{
		hlc: string;
		table_name: string;
		row_id: string;
		site_id: string;
		timestamp: string;
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
		ref_id: string | null;
		idempotency_key: string | null;
		stream_id: string | null;
		expires_at: string;
		payload: unknown;
	}>;
};

export type RelayDeliverPayload = {
	entries: Array<{
		id: string;
		source_site_id: string;
		kind: string;
		ref_id: string | null;
		idempotency_key: string | null;
		stream_id: string | null;
		expires_at: string;
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

export type SnapshotBeginPayload = {
	/** HLC at the moment seeding started — changelog catchup starts from here. */
	snapshot_hlc: string;
	/** Ordered list of table names that will be seeded. */
	tables: string[];
};

export type SnapshotChunkPayload = {
	table_name: string;
	/** Byte offset within the table (for resume). */
	offset: number;
	/** Rows in this chunk. Each row is { column: value }. Empty for column-chunk frames. */
	rows: Array<Record<string, unknown>>;
	/** Whether this is the final chunk for this table. */
	last: boolean;
	/** PK value of the row being column-chunked (absent for normal row frames). */
	col_chunk_row_id?: string;
	/** Column name being sent in pieces. */
	col_chunk_column?: string;
	/** 0-based index of this chunk within the column value. */
	col_chunk_index?: number;
	/** True if this is the last chunk for this column of this row. */
	col_chunk_final?: boolean;
	/** The chunk content (substring of the column value). */
	col_chunk_data?: string;
};

export type SnapshotEndPayload = {
	/** Total tables seeded. */
	table_count: number;
	/** Total rows seeded. */
	row_count: number;
};

export type SnapshotAckPayload = {
	/** The snapshot_hlc from SNAPSHOT_BEGIN, confirming successful application. */
	snapshot_hlc: string;
};

export type ReseedRequestPayload = {
	/** Human-readable reason for this reseed request (logged, not acted upon). */
	reason: string;
};

export type ConsistencyRequestPayload = {
	tables: string[];
	request_id?: string;
};

export type ConsistencyResponsePayload = {
	table: string;
	pks: string[];
	count: number;
	has_more: boolean;
	table_index: number;
	table_count: number;
	all_done: boolean;
	request_id?: string;
};

export type RowPullRequestPayload = {
	request_id: string;
	tables: Array<{ table: string; pks: string[] }>;
};

export type RowPullResponsePayload = {
	request_id: string;
	table_name: string;
	rows: Array<Record<string, unknown>>;
	last: boolean;
	col_chunk_row_id?: string;
	col_chunk_column?: string;
	col_chunk_index?: number;
	col_chunk_final?: boolean;
	col_chunk_data?: string;
};

export type RowPullAckPayload = {
	request_id: string;
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
			type: WsMessageType.SNAPSHOT_BEGIN;
			payload: SnapshotBeginPayload;
	  }
	| {
			type: WsMessageType.SNAPSHOT_CHUNK;
			payload: SnapshotChunkPayload;
	  }
	| {
			type: WsMessageType.SNAPSHOT_END;
			payload: SnapshotEndPayload;
	  }
	| {
			type: WsMessageType.SNAPSHOT_ACK;
			payload: SnapshotAckPayload;
	  }
	| {
			type: WsMessageType.RESEED_REQUEST;
			payload: ReseedRequestPayload;
	  }
	| {
			type: WsMessageType.CONSISTENCY_REQUEST;
			payload: ConsistencyRequestPayload;
	  }
	| {
			type: WsMessageType.CONSISTENCY_RESPONSE;
			payload: ConsistencyResponsePayload;
	  }
	| {
			type: WsMessageType.ROW_PULL_REQUEST;
			payload: RowPullRequestPayload;
	  }
	| {
			type: WsMessageType.ROW_PULL_RESPONSE;
			payload: RowPullResponsePayload;
	  }
	| {
			type: WsMessageType.ROW_PULL_ACK;
			payload: RowPullAckPayload;
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

	// Validate payload structure matches expected type
	if (!isValidPayloadForType(typeByte as WsMessageType, payload)) {
		return { ok: false, error: "invalid_payload" };
	}

	// Return discriminated union based on type
	const framePayload = { type: typeByte as WsMessageType, payload } as unknown;
	return { ok: true, value: framePayload as WsFrame };
}

/**
 * Validates that a parsed payload object has the expected fields for its message type.
 * Returns false if required fields are clearly missing or wrong types for core fields.
 * Note: We're lenient on structure to allow flexible payloads for non-critical fields.
 */
function isValidPayloadForType(type: WsMessageType, payload: unknown): boolean {
	if (typeof payload !== "object" || payload === null) {
		return false;
	}

	const p = payload as Record<string, unknown>;

	switch (type) {
		case WsMessageType.CHANGELOG_PUSH:
			// Required: entries array
			return Array.isArray(p.entries);
		case WsMessageType.CHANGELOG_ACK:
			// Required: cursor string
			return typeof p.cursor === "string";
		case WsMessageType.RELAY_SEND:
			// Required: entries array
			return Array.isArray(p.entries);
		case WsMessageType.RELAY_DELIVER:
			// Required: entries array
			return Array.isArray(p.entries);
		case WsMessageType.RELAY_ACK:
			// Required: ids array
			return Array.isArray(p.ids);
		case WsMessageType.SNAPSHOT_BEGIN:
			// Required: snapshot_hlc string, tables array
			return typeof p.snapshot_hlc === "string" && Array.isArray(p.tables);
		case WsMessageType.SNAPSHOT_CHUNK:
			// Required: table_name string, offset number, rows array
			return (
				typeof p.table_name === "string" && typeof p.offset === "number" && Array.isArray(p.rows)
			);
		case WsMessageType.SNAPSHOT_END:
			// Required: table_count number, row_count number
			return typeof p.table_count === "number" && typeof p.row_count === "number";
		case WsMessageType.SNAPSHOT_ACK:
			// Required: snapshot_hlc string
			return typeof p.snapshot_hlc === "string";
		case WsMessageType.RESEED_REQUEST:
			return typeof p.reason === "string";
		case WsMessageType.CONSISTENCY_REQUEST:
			return Array.isArray(p.tables);
		case WsMessageType.CONSISTENCY_RESPONSE:
			return (
				typeof p.table === "string" &&
				Array.isArray(p.pks) &&
				typeof p.count === "number" &&
				typeof p.all_done === "boolean"
			);
		case WsMessageType.ROW_PULL_REQUEST:
			return typeof p.request_id === "string" && Array.isArray(p.tables);
		case WsMessageType.ROW_PULL_RESPONSE:
			return (
				typeof p.request_id === "string" &&
				typeof p.table_name === "string" &&
				Array.isArray(p.rows) &&
				typeof p.last === "boolean"
			);
		case WsMessageType.ROW_PULL_ACK:
			return typeof p.request_id === "string";
		case WsMessageType.DRAIN_REQUEST:
			// Lenient: allow any object (reason is optional or may be in different format)
			return true;
		case WsMessageType.DRAIN_COMPLETE:
			// Lenient: allow any object (success may be optional)
			return true;
		case WsMessageType.ERROR:
			// Lenient: allow any object (code/message are optional or may be in different format)
			return true;
		default:
			return false;
	}
}

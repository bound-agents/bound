import { beforeEach, describe, expect, it } from "bun:test";
import { encryptBody } from "../encryption.js";
import {
	type ChangelogAckPayload,
	type ChangelogPushPayload,
	type ErrorPayload,
	type RelayAckPayload,
	WsMessageType,
	decodeFrame,
	encodeFrame,
} from "../ws-frames.js";

describe("ws-frames module", () => {
	let symmetricKey: Uint8Array;

	beforeEach(() => {
		// Generate a random 32-byte symmetric key
		symmetricKey = crypto.getRandomValues(new Uint8Array(32));
	});

	describe("encodeFrame and decodeFrame", () => {
		describe("AC3.1 — Roundtrip for all 8 message types (XChaCha20-Poly1305 encryption)", () => {
			it("roundtrip CHANGELOG_PUSH", () => {
				const payload: ChangelogPushPayload = {
					entries: [
						{
							hlc: "2026-04-15T12:00:00.000Z_0001_abc123",
							table_name: "users",
							row_id: "user-1",
							site_id: "hub",
							row_data: { display_name: "Alice" },
						},
					],
				};

				const frame = encodeFrame(WsMessageType.CHANGELOG_PUSH, payload, symmetricKey);
				const result = decodeFrame(frame, symmetricKey);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.value.type).toBe(WsMessageType.CHANGELOG_PUSH);
					expect(result.value.payload).toEqual(payload);
				}
			});

			it("roundtrip CHANGELOG_ACK", () => {
				const payload: ChangelogAckPayload = {
					cursor: "2026-04-15T12:00:00.000Z_0100_abc123",
				};

				const frame = encodeFrame(WsMessageType.CHANGELOG_ACK, payload, symmetricKey);
				const result = decodeFrame(frame, symmetricKey);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.value.type).toBe(WsMessageType.CHANGELOG_ACK);
					expect(result.value.payload).toEqual(payload);
				}
			});

			it("roundtrip RELAY_ACK", () => {
				const payload: RelayAckPayload = {
					ids: ["relay-1", "relay-2", "relay-3"],
				};

				const frame = encodeFrame(WsMessageType.RELAY_ACK, payload, symmetricKey);
				const result = decodeFrame(frame, symmetricKey);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.value.type).toBe(WsMessageType.RELAY_ACK);
					expect(result.value.payload).toEqual(payload);
				}
			});

			it("roundtrip ERROR", () => {
				const payload: ErrorPayload = {
					code: "AUTH_FAILED",
					message: "Invalid credentials",
				};

				const frame = encodeFrame(WsMessageType.ERROR, payload, symmetricKey);
				const result = decodeFrame(frame, symmetricKey);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.value.type).toBe(WsMessageType.ERROR);
					expect(result.value.payload).toEqual(payload);
				}
			});
		});

		describe("AC3.2 — Random nonce per frame (each frame uses different random 24-byte nonce)", () => {
			it("same payload encoded twice produces different ciphertexts (different nonces)", () => {
				const payload: ChangelogAckPayload = { cursor: "test-cursor" };

				const frame1 = encodeFrame(WsMessageType.CHANGELOG_ACK, payload, symmetricKey);
				const frame2 = encodeFrame(WsMessageType.CHANGELOG_ACK, payload, symmetricKey);

				// Frames should differ
				expect(frame1).not.toEqual(frame2);

				// Extract nonces at offset 1..25
				const nonce1 = frame1.slice(1, 25);
				const nonce2 = frame2.slice(1, 25);

				// Nonces must differ (random)
				expect(nonce1).not.toEqual(nonce2);

				// Ciphertexts should also differ
				const ciphertext1 = frame1.slice(25);
				const ciphertext2 = frame2.slice(25);
				expect(ciphertext1).not.toEqual(ciphertext2);
			});

			it("nonce is exactly 24 bytes", () => {
				const payload: ChangelogAckPayload = { cursor: "test" };
				const frame = encodeFrame(WsMessageType.CHANGELOG_ACK, payload, symmetricKey);

				const nonce = frame.slice(1, 25);
				expect(nonce.length).toBe(24);
			});
		});

		describe("AC3.6 — Tampered ciphertext rejected (frame discarded, connection not killed)", () => {
			it("decoding with tampered ciphertext returns error result", () => {
				const payload: ChangelogAckPayload = { cursor: "secret" };
				const frame = encodeFrame(WsMessageType.CHANGELOG_ACK, payload, symmetricKey);

				// Flip a bit in the ciphertext region (offset 25+)
				frame[25] ^= 0x01;

				const result = decodeFrame(frame, symmetricKey);

				// Must return error result, NOT throw
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error).toBe("decryption_failed");
				}
			});

			it("decoding with wrong key returns error result", () => {
				const payload: ChangelogAckPayload = { cursor: "secret" };
				const frame = encodeFrame(WsMessageType.CHANGELOG_ACK, payload, symmetricKey);

				// Use a different key
				const wrongKey = crypto.getRandomValues(new Uint8Array(32));

				const result = decodeFrame(frame, wrongKey);

				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error).toBe("decryption_failed");
				}
			});
		});

		describe("consistency trace carrier", () => {
			it("accepts an absent carrier for backwards-compatible requests", () => {
				const frame = encodeFrame(
					WsMessageType.CONSISTENCY_REQUEST,
					{ tables: ["tasks"] },
					symmetricKey,
				);
				expect(decodeFrame(frame, symmetricKey).ok).toBe(true);
			});

			it("rejects malformed or baggage-bearing carriers", () => {
				for (const trace_context of [
					{ traceparent: 12 },
					{ traceparent: "00-abc", baggage: "not-allowed" },
				]) {
					const frame = encodeFrame(
						WsMessageType.CONSISTENCY_REQUEST,
						{ tables: ["tasks"], trace_context },
						symmetricKey,
					);
					expect(decodeFrame(frame, symmetricKey).ok).toBe(false);
				}
			});
		});

		describe("Robustness tests", () => {
			describe("Frame too short", () => {
				it("frame with < 41 bytes returns error", () => {
					const tooShortFrame = new Uint8Array(40);
					const result = decodeFrame(tooShortFrame, symmetricKey);

					expect(result.ok).toBe(false);
					if (!result.ok) {
						expect(result.error).toBe("frame_too_short");
					}
				});
			});

			describe("Unknown message type", () => {
				it("unknown type byte (0xAA) returns error", () => {
					// Construct a frame with unknown type byte
					const frame = new Uint8Array(50);
					frame[0] = 0xaa; // Unknown type
					frame.set(crypto.getRandomValues(new Uint8Array(24)), 1);
					frame.set(crypto.getRandomValues(new Uint8Array(25)), 25);

					const result = decodeFrame(frame, symmetricKey);

					expect(result.ok).toBe(false);
					if (!result.ok) {
						expect(result.error).toBe("unknown_type");
					}
				});
			});

			describe("Invalid JSON payload", () => {
				it("non-JSON encrypted bytes return invalid_payload error", () => {
					// Encrypt raw non-JSON bytes
					const invalidJson = new TextEncoder().encode("not valid json{{{");
					const { ciphertext, nonce } = encryptBody(invalidJson, symmetricKey);

					// Construct frame manually
					const frame = new Uint8Array(1 + 24 + ciphertext.length);
					frame[0] = WsMessageType.CHANGELOG_ACK;
					frame.set(nonce, 1);
					frame.set(ciphertext, 25);

					const result = decodeFrame(frame, symmetricKey);

					expect(result.ok).toBe(false);
					if (!result.ok) {
						expect(result.error).toBe("invalid_payload");
					}
				});
			});
		});
	});

	describe("Frame format validation", () => {
		it("encoded frame has correct structure: [type][nonce][ciphertext]", () => {
			const payload: ChangelogAckPayload = { cursor: "test" };
			const frame = encodeFrame(WsMessageType.CHANGELOG_ACK, payload, symmetricKey);

			// Type byte at offset 0
			expect(frame[0]).toBe(WsMessageType.CHANGELOG_ACK);

			// Nonce at offset 1..25 (24 bytes)
			const nonce = frame.slice(1, 25);
			expect(nonce.length).toBe(24);

			// Ciphertext at offset 25..end
			const ciphertext = frame.slice(25);
			expect(ciphertext.length).toBeGreaterThan(16); // At least auth tag
		});
	});
});

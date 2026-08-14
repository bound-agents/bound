import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
	type InferenceRequestPart,
	InferenceRequestPartAssembler,
	splitInferenceRequest,
} from "../inference-request-parts";

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

const payloadArbitrary = fc
	.array(
		fc.integer({ min: 0, max: 0x10ffff }).filter((cp) => cp < 0xd800 || cp > 0xdfff),
		{
			minLength: 0,
			maxLength: 4000,
		},
	)
	.map((points) => String.fromCodePoint(...points));

const scenarioArbitrary = fc.record({
	payload: payloadArbitrary,
	maxPayloadBytes: fc.integer({ min: 220, max: 1800 }),
	requestId: fc.uuid(),
});

describe("multipart inference request codec", () => {
	it("P1 reassembles arbitrary UTF-8 payloads byte-for-byte", () => {
		fc.assert(
			fc.property(scenarioArbitrary, ({ payload, maxPayloadBytes, requestId }) => {
				const parts = splitInferenceRequest(payload, requestId, maxPayloadBytes);
				const assembler = new InferenceRequestPartAssembler();
				let result: string | null = null;
				for (const part of parts) result = assembler.add(part);
				expect(result).toBe(payload);
			}),
			{ numRuns: 300 },
		);
	});

	it("P2 every serialized part fits the configured byte ceiling", () => {
		fc.assert(
			fc.property(scenarioArbitrary, ({ payload, maxPayloadBytes, requestId }) => {
				for (const part of splitInferenceRequest(payload, requestId, maxPayloadBytes)) {
					expect(utf8Bytes(JSON.stringify(part))).toBeLessThanOrEqual(maxPayloadBytes);
				}
			}),
			{ numRuns: 300 },
		);
	});

	it("P3 arbitrary order and duplicate delivery completes exactly once", () => {
		fc.assert(
			fc.property(
				scenarioArbitrary.chain((scenario) => {
					const parts = splitInferenceRequest(
						scenario.payload,
						scenario.requestId,
						scenario.maxPayloadBytes,
					);
					return fc
						.shuffledSubarray(parts, { minLength: parts.length, maxLength: parts.length })
						.chain((shuffled) =>
							fc
								.array(fc.constantFrom(...parts), { maxLength: Math.min(parts.length * 2, 20) })
								.map((duplicates) => ({ ...scenario, deliveries: [...duplicates, ...shuffled] })),
						);
				}),
				({ payload, deliveries }) => {
					const assembler = new InferenceRequestPartAssembler();
					const completed = deliveries
						.map((part) => assembler.add(part))
						.filter((value): value is string => value !== null);
					expect(completed).toEqual([payload]);
				},
			),
			{ numRuns: 300 },
		);
	});

	it("P4 every strict subset remains incomplete", () => {
		const multipartScenario = fc.record({
			payload: fc
				.array(fc.string({ minLength: 8, maxLength: 24 }), { minLength: 20, maxLength: 40 })
				.map((chunks) => chunks.join("")),
			maxPayloadBytes: fc.integer({ min: 220, max: 260 }),
			requestId: fc.uuid(),
		});
		fc.assert(
			fc.property(multipartScenario, ({ payload, maxPayloadBytes, requestId }) => {
				const parts = splitInferenceRequest(payload, requestId, maxPayloadBytes);
				expect(parts.length).toBeGreaterThan(1);
				const assembler = new InferenceRequestPartAssembler();
				for (const part of parts.slice(0, -1)) expect(assembler.add(part)).toBeNull();
			}),
			{ numRuns: 200 },
		);
	});

	it("P5 conflicting duplicate content fails closed", () => {
		fc.assert(
			fc.property(scenarioArbitrary, ({ payload, maxPayloadBytes, requestId }) => {
				const parts = splitInferenceRequest(payload, requestId, maxPayloadBytes);
				const assembler = new InferenceRequestPartAssembler();
				expect(assembler.add(parts[0])).toBe(parts.length === 1 ? payload : null);
				const conflict: InferenceRequestPart = {
					...parts[0],
					data: parts[0].data === "AA==" ? "AQ==" : "AA==",
				};
				expect(() => assembler.add(conflict)).toThrow();
			}),
			{ numRuns: 200 },
		);
	});
});

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface InferenceRequestPart {
	version: 1;
	request_id: string;
	index: number;
	count: number;
	data: string;
}

function serializedBytes(part: InferenceRequestPart): number {
	return encoder.encode(JSON.stringify(part)).byteLength;
}

function bytesToBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(value: string): Uint8Array {
	return Uint8Array.from(Buffer.from(value, "base64"));
}

function makePart(
	requestId: string,
	index: number,
	count: number,
	bytes: Uint8Array,
): InferenceRequestPart {
	return { version: 1, request_id: requestId, index, count, data: bytesToBase64(bytes) };
}

/** Split a serialized inference request into independently relay-safe JSON envelopes. */
export function splitInferenceRequest(
	payload: string,
	requestId: string,
	maxPayloadBytes: number,
): InferenceRequestPart[] {
	if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
		throw new Error("maxPayloadBytes must be a positive integer");
	}
	const payloadBytes = encoder.encode(payload);
	// Count digits affect envelope size, so find a conservative raw-byte capacity
	// using the largest possible index/count for this payload.
	const upperCount = Math.max(1, payloadBytes.byteLength);
	const emptyEnvelope = serializedBytes(
		makePart(requestId, upperCount - 1, upperCount, new Uint8Array()),
	);
	const availableBase64Bytes = maxPayloadBytes - emptyEnvelope;
	const rawCapacity = Math.floor(availableBase64Bytes / 4) * 3;
	if (rawCapacity < 1) {
		throw new Error(`Relay payload limit ${maxPayloadBytes} is too small for multipart envelope`);
	}
	const count = Math.max(1, Math.ceil(payloadBytes.byteLength / rawCapacity));
	const parts: InferenceRequestPart[] = [];
	for (let index = 0; index < count; index++) {
		const start = index * rawCapacity;
		const part = makePart(requestId, index, count, payloadBytes.slice(start, start + rawCapacity));
		if (serializedBytes(part) > maxPayloadBytes) {
			throw new Error("Multipart inference part exceeded relay payload limit");
		}
		parts.push(part);
	}
	return parts;
}

interface Assembly {
	count: number;
	parts: Map<number, string>;
	completed: boolean;
}

/** In-memory deterministic codec used by the durable relay-inbox assembler. */
export class InferenceRequestPartAssembler {
	private readonly assemblies = new Map<string, Assembly>();

	add(part: InferenceRequestPart): string | null {
		if (
			part.version !== 1 ||
			!part.request_id ||
			!Number.isInteger(part.index) ||
			!Number.isInteger(part.count) ||
			part.count < 1 ||
			part.index < 0 ||
			part.index >= part.count
		) {
			throw new Error("Invalid multipart inference request metadata");
		}
		let assembly = this.assemblies.get(part.request_id);
		if (!assembly) {
			assembly = { count: part.count, parts: new Map(), completed: false };
			this.assemblies.set(part.request_id, assembly);
		}
		if (assembly.count !== part.count) throw new Error("Conflicting multipart part count");
		const existing = assembly.parts.get(part.index);
		if (existing !== undefined && existing !== part.data) {
			throw new Error("Conflicting multipart inference request part");
		}
		if (assembly.completed) return null;
		assembly.parts.set(part.index, part.data);
		if (assembly.parts.size !== assembly.count) return null;
		const chunks: Uint8Array[] = [];
		let length = 0;
		for (let index = 0; index < assembly.count; index++) {
			const data = assembly.parts.get(index);
			if (data === undefined) return null;
			const bytes = base64ToBytes(data);
			chunks.push(bytes);
			length += bytes.byteLength;
		}
		const joined = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			joined.set(chunk, offset);
			offset += chunk.byteLength;
		}
		assembly.completed = true;
		return decoder.decode(joined);
	}
}

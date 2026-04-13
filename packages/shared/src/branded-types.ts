/**
 * Branded (opaque) types for compile-time safety on string identifiers.
 *
 * Branded types prevent mixing up values that share the same runtime
 * representation (e.g. all UUIDs are strings) but have distinct semantic
 * meaning. Passing a ThreadId where a UserId is expected becomes a
 * compile-time error.
 *
 * Usage:
 *   import { ThreadId, threadId, unsafeThreadId } from "@bound/shared";
 *
 *   const id = threadId(userInput);       // validates format, throws on bad input
 *   const id = unsafeThreadId(row.id);    // DB boundary — skip validation
 *   db.query("... WHERE id = ?", [id]);   // branded types are still strings at runtime
 */

declare const brand: unique symbol;

/** Core branding mechanism — zero runtime cost. */
export type Branded<T, B extends string> = T & { readonly [brand]: B };

// ---------------------------------------------------------------------------
// ID Types
// ---------------------------------------------------------------------------

/** Ed25519 public key fingerprint (32 hex lowercase chars). */
export type SiteId = Branded<string, "SiteId">;

/** UUIDv4 — thread identifier. */
export type ThreadId = Branded<string, "ThreadId">;

/** UUIDv4 — message identifier. */
export type MessageId = Branded<string, "MessageId">;

/** UUIDv4 — user identifier. */
export type UserId = Branded<string, "UserId">;

/** UUIDv4 — task identifier (may be deterministic). */
export type TaskId = Branded<string, "TaskId">;

/** UUIDv4 — skill identifier (deterministic from name). */
export type SkillId = Branded<string, "SkillId">;

/** UUIDv4 — advisory identifier. */
export type AdvisoryId = Branded<string, "AdvisoryId">;

/** UUIDv4 — relay stream identifier. */
export type StreamId = Branded<string, "StreamId">;

/** Freeform host name. */
export type HostName = Branded<string, "HostName">;

/** Freeform semantic memory key (may have prefix like `_standing:`). */
export type MemoryKey = Branded<string, "MemoryKey">;

/** Model backend identifier — NOT a logical alias. */
export type ModelId = Branded<string, "ModelId">;

/** Logical model alias (e.g. "opus") — NOT a provider-specific identifier. */
export type ModelAlias = Branded<string, "ModelAlias">;

/** External platform event identifier. */
export type PlatformEventId = Branded<string, "PlatformEventId">;

/** SHA-256-based idempotency key. */
export type IdempotencyKey = Branded<string, "IdempotencyKey">;

/** HLC timestamp string ({ISO}_{counter}_{site_id}). */
export type HLCString = Branded<string, "HLC">;

/** ISO 8601 timestamp string (e.g. 2026-04-12T10:30:00.000Z). */
export type ISOTimestamp = Branded<string, "ISOTimestamp">;

/** SHA-256 hex digest. */
export type SHA256Hash = Branded<string, "SHA256">;

/** SQLite boolean (0 | 1). */
export type SQLBoolean = 0 | 1;

/** Platform connector identifier. */
export type PlatformId = "discord" | "discord-interaction" | "webhook-stub";

/** Thread interface type. */
export type InterfaceType = "web" | "mcp" | "discord" | "discord-interaction";

// ---------------------------------------------------------------------------
// Validated constructors — use at trust boundaries (user input, API calls)
// ---------------------------------------------------------------------------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SITE_ID_REGEX = /^[0-9a-f]{16,64}$/;
const HLC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_[0-9a-f]{4}_[0-9a-f]+$/;
const ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function siteId(raw: string): SiteId {
	if (!SITE_ID_REGEX.test(raw)) throw new Error(`Invalid SiteId format: ${raw}`);
	return raw as SiteId;
}

export function threadId(raw: string): ThreadId {
	if (!UUID_REGEX.test(raw)) throw new Error(`Invalid ThreadId format: ${raw}`);
	return raw as ThreadId;
}

export function messageId(raw: string): MessageId {
	if (!UUID_REGEX.test(raw)) throw new Error(`Invalid MessageId format: ${raw}`);
	return raw as MessageId;
}

export function userId(raw: string): UserId {
	if (!UUID_REGEX.test(raw)) throw new Error(`Invalid UserId format: ${raw}`);
	return raw as UserId;
}

export function taskId(raw: string): TaskId {
	if (!UUID_REGEX.test(raw)) throw new Error(`Invalid TaskId format: ${raw}`);
	return raw as TaskId;
}

export function skillId(raw: string): SkillId {
	if (!UUID_REGEX.test(raw)) throw new Error(`Invalid SkillId format: ${raw}`);
	return raw as SkillId;
}

export function advisoryId(raw: string): AdvisoryId {
	if (!UUID_REGEX.test(raw)) throw new Error(`Invalid AdvisoryId format: ${raw}`);
	return raw as AdvisoryId;
}

export function streamId(raw: string): StreamId {
	if (!UUID_REGEX.test(raw)) throw new Error(`Invalid StreamId format: ${raw}`);
	return raw as StreamId;
}

export function hlcString(raw: string): HLCString {
	if (!HLC_REGEX.test(raw)) throw new Error(`Invalid HLC format: ${raw}`);
	return raw as HLCString;
}

export function isoTimestamp(raw: string): ISOTimestamp {
	if (!ISO_REGEX.test(raw)) throw new Error(`Invalid ISO timestamp: ${raw}`);
	return raw as ISOTimestamp;
}

// Freeform types — no format validation, just branding
export const hostName = (raw: string): HostName => raw as HostName;
export const memoryKey = (raw: string): MemoryKey => raw as MemoryKey;
export const modelId = (raw: string): ModelId => raw as ModelId;
export const modelAlias = (raw: string): ModelAlias => raw as ModelAlias;
export const platformEventId = (raw: string): PlatformEventId => raw as PlatformEventId;
export const idempotencyKey = (raw: string): IdempotencyKey => raw as IdempotencyKey;
export const sha256Hash = (raw: string): SHA256Hash => raw as SHA256Hash;

// ---------------------------------------------------------------------------
// Unsafe constructors — use at DB boundaries where data is already validated
// ---------------------------------------------------------------------------

export const unsafeSiteId = (raw: string): SiteId => raw as SiteId;
export const unsafeThreadId = (raw: string): ThreadId => raw as ThreadId;
export const unsafeMessageId = (raw: string): MessageId => raw as MessageId;
export const unsafeUserId = (raw: string): UserId => raw as UserId;
export const unsafeTaskId = (raw: string): TaskId => raw as TaskId;
export const unsafeSkillId = (raw: string): SkillId => raw as SkillId;
export const unsafeAdvisoryId = (raw: string): AdvisoryId => raw as AdvisoryId;
export const unsafeStreamId = (raw: string): StreamId => raw as StreamId;
export const unsafeHlcString = (raw: string): HLCString => raw as HLCString;
export const unsafeIsoTimestamp = (raw: string): ISOTimestamp => raw as ISOTimestamp;
export const unsafeSHA256Hash = (raw: string): SHA256Hash => raw as SHA256Hash;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export const isSiteId = (v: unknown): v is SiteId => typeof v === "string" && SITE_ID_REGEX.test(v);
export const isThreadId = (v: unknown): v is ThreadId =>
	typeof v === "string" && UUID_REGEX.test(v);
export const isHLCString = (v: unknown): v is HLCString =>
	typeof v === "string" && HLC_REGEX.test(v);
export const isISOTimestamp = (v: unknown): v is ISOTimestamp =>
	typeof v === "string" && ISO_REGEX.test(v);

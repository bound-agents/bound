import { describe, expect, it } from "bun:test";
import {
	advisoryId,
	hlcString,
	hostName,
	idempotencyKey,
	isHLCString,
	isISOTimestamp,
	isSiteId,
	isThreadId,
	isoTimestamp,
	memoryKey,
	messageId,
	modelAlias,
	modelId,
	platformEventId,
	sha256Hash,
	siteId,
	skillId,
	streamId,
	taskId,
	threadId,
	unsafeAdvisoryId,
	unsafeHlcString,
	unsafeIsoTimestamp,
	unsafeMessageId,
	unsafeSHA256Hash,
	unsafeSiteId,
	unsafeSkillId,
	unsafeStreamId,
	unsafeTaskId,
	unsafeThreadId,
	unsafeUserId,
	userId,
} from "../branded-types";

const VALID_UUID = "12345678-1234-1234-1234-123456789abc";
const VALID_SITE = "110ef7e107b038db";
const VALID_HLC = "2026-11-19T06:56:00.000Z_1a2b_7f";
const VALID_ISO = "2026-11-19T06:56:00.000Z";

describe("validated constructors — accept well-formed input", () => {
	it("siteId accepts a 16–64 hex string", () => {
		expect(siteId(VALID_SITE)).toBe(VALID_SITE as ReturnType<typeof siteId>);
	});

	it("UUID-shaped constructors accept a canonical UUID", () => {
		expect(threadId(VALID_UUID)).toBe(VALID_UUID as ReturnType<typeof threadId>);
		expect(messageId(VALID_UUID)).toBe(VALID_UUID as ReturnType<typeof messageId>);
		expect(userId(VALID_UUID)).toBe(VALID_UUID as ReturnType<typeof userId>);
		expect(taskId(VALID_UUID)).toBe(VALID_UUID as ReturnType<typeof taskId>);
		expect(skillId(VALID_UUID)).toBe(VALID_UUID as ReturnType<typeof skillId>);
		expect(advisoryId(VALID_UUID)).toBe(VALID_UUID as ReturnType<typeof advisoryId>);
		expect(streamId(VALID_UUID)).toBe(VALID_UUID as ReturnType<typeof streamId>);
	});

	it("hlcString accepts a well-formed HLC and isoTimestamp a well-formed ISO", () => {
		expect(hlcString(VALID_HLC)).toBe(VALID_HLC as ReturnType<typeof hlcString>);
		expect(isoTimestamp(VALID_ISO)).toBe(VALID_ISO as ReturnType<typeof isoTimestamp>);
	});
});

describe("validated constructors — reject malformed input", () => {
	it("siteId rejects a too-short / non-hex string", () => {
		expect(() => siteId("xyz")).toThrow("Invalid SiteId format");
		expect(() => siteId("gggggggggggggggg")).toThrow("Invalid SiteId format");
	});

	it("UUID constructors reject a non-UUID string with a type-specific message", () => {
		expect(() => threadId("not-a-uuid")).toThrow("Invalid ThreadId format");
		expect(() => messageId("not-a-uuid")).toThrow("Invalid MessageId format");
		expect(() => userId("not-a-uuid")).toThrow("Invalid UserId format");
		expect(() => taskId("not-a-uuid")).toThrow("Invalid TaskId format");
		expect(() => skillId("not-a-uuid")).toThrow("Invalid SkillId format");
		expect(() => advisoryId("not-a-uuid")).toThrow("Invalid AdvisoryId format");
		expect(() => streamId("not-a-uuid")).toThrow("Invalid StreamId format");
	});

	it("hlcString rejects a bare ISO timestamp (missing the _logical_counter suffix)", () => {
		expect(() => hlcString(VALID_ISO)).toThrow("Invalid HLC format");
	});

	it("isoTimestamp rejects a non-ISO string", () => {
		expect(() => isoTimestamp("2026/11/19 06:56")).toThrow("Invalid ISO timestamp");
	});
});

describe("freeform constructors — pass the value through unchanged", () => {
	it("brands without validation", () => {
		expect(hostName("any-host!!")).toBe("any-host!!" as ReturnType<typeof hostName>);
		expect(memoryKey("free:form:key")).toBe("free:form:key" as ReturnType<typeof memoryKey>);
		expect(modelId("gpt-5.6")).toBe("gpt-5.6" as ReturnType<typeof modelId>);
		expect(modelAlias("default")).toBe("default" as ReturnType<typeof modelAlias>);
		expect(platformEventId("evt_1")).toBe("evt_1" as ReturnType<typeof platformEventId>);
		expect(idempotencyKey("idem_1")).toBe("idem_1" as ReturnType<typeof idempotencyKey>);
		expect(sha256Hash("deadbeef")).toBe("deadbeef" as ReturnType<typeof sha256Hash>);
	});
});

describe("unsafe constructors — brand without validating", () => {
	it("accepts values the validated constructor would reject", () => {
		expect(unsafeSiteId("x")).toBe("x" as ReturnType<typeof unsafeSiteId>);
		expect(unsafeThreadId("x")).toBe("x" as ReturnType<typeof unsafeThreadId>);
		expect(unsafeMessageId("x")).toBe("x" as ReturnType<typeof unsafeMessageId>);
		expect(unsafeUserId("x")).toBe("x" as ReturnType<typeof unsafeUserId>);
		expect(unsafeTaskId("x")).toBe("x" as ReturnType<typeof unsafeTaskId>);
		expect(unsafeSkillId("x")).toBe("x" as ReturnType<typeof unsafeSkillId>);
		expect(unsafeAdvisoryId("x")).toBe("x" as ReturnType<typeof unsafeAdvisoryId>);
		expect(unsafeStreamId("x")).toBe("x" as ReturnType<typeof unsafeStreamId>);
		expect(unsafeHlcString("x")).toBe("x" as ReturnType<typeof unsafeHlcString>);
		expect(unsafeIsoTimestamp("x")).toBe("x" as ReturnType<typeof unsafeIsoTimestamp>);
		expect(unsafeSHA256Hash("x")).toBe("x" as ReturnType<typeof unsafeSHA256Hash>);
	});
});

describe("type guards", () => {
	it("isSiteId discriminates hex ids from everything else", () => {
		expect(isSiteId(VALID_SITE)).toBe(true);
		expect(isSiteId("nope")).toBe(false);
		expect(isSiteId(12345)).toBe(false);
		expect(isSiteId(null)).toBe(false);
	});

	it("isThreadId discriminates UUIDs", () => {
		expect(isThreadId(VALID_UUID)).toBe(true);
		expect(isThreadId("nope")).toBe(false);
		expect(isThreadId(undefined)).toBe(false);
	});

	it("isHLCString discriminates HLC strings", () => {
		expect(isHLCString(VALID_HLC)).toBe(true);
		expect(isHLCString(VALID_ISO)).toBe(false);
		expect(isHLCString(42)).toBe(false);
	});

	it("isISOTimestamp discriminates ISO timestamps", () => {
		expect(isISOTimestamp(VALID_ISO)).toBe(true);
		expect(isISOTimestamp("2026/11/19")).toBe(false);
		expect(isISOTimestamp({})).toBe(false);
	});
});

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { SignatureFormat } from "@bound/shared";
import { validateWebhookSignature } from "../webhook-hmac.js";

describe("validateWebhookSignature", () => {
	// ──────────────────────────────────────────────────────────────────
	// AC1.1: GitHub format with valid signature
	// ──────────────────────────────────────────────────────────────────
	test("AC1.1: GitHub format returns valid when signature matches", () => {
		const format: SignatureFormat = "github";
		const secret = "test_secret";
		const body = Buffer.from('{"action":"opened"}');

		// Compute expected HMAC
		const expectedHmac = createHmac("sha256", secret).update(body).digest("hex");

		// Build headers
		const headers = new Headers({
			"X-Hub-Signature-256": `sha256=${expectedHmac}`,
		});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(true);
	});

	// ──────────────────────────────────────────────────────────────────
	// AC1.2: Stripe format with valid signature
	// ──────────────────────────────────────────────────────────────────
	test("AC1.2: Stripe format returns valid when signature matches and timestamp is fresh", () => {
		const format: SignatureFormat = "stripe";
		const secret = "test_secret";
		const body = Buffer.from('{"type":"charge.completed"}');
		const timestamp = Math.floor(Date.now() / 1000).toString();

		// Compute expected HMAC for Stripe (timestamp.body format)
		const payload = `${timestamp}.${body.toString("utf-8")}`;
		const expectedHmac = createHmac("sha256", secret).update(payload).digest("hex");

		// Build headers
		const headers = new Headers({
			"Stripe-Signature": `t=${timestamp},v1=${expectedHmac}`,
		});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(true);
	});

	// ──────────────────────────────────────────────────────────────────
	// AC1.3: Slack format with valid signature and fresh timestamp
	// ──────────────────────────────────────────────────────────────────
	test("AC1.3: Slack format returns valid when signature matches and timestamp is fresh", () => {
		const format: SignatureFormat = "slack";
		const secret = "test_secret";
		const body = Buffer.from('{"type":"url_verification"}');
		const timestamp = Math.floor(Date.now() / 1000).toString();

		// Compute expected HMAC for Slack (v0:timestamp:body format)
		const payload = `v0:${timestamp}:${body.toString("utf-8")}`;
		const expectedHmac = createHmac("sha256", secret).update(payload).digest("hex");

		// Build headers
		const headers = new Headers({
			"X-Slack-Signature": `v0=${expectedHmac}`,
			"X-Slack-Request-Timestamp": timestamp,
		});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(true);
	});

	// ──────────────────────────────────────────────────────────────────
	// AC1.4: Raw format with valid signature
	// ──────────────────────────────────────────────────────────────────
	test("AC1.4: Raw format returns valid when hex signature matches", () => {
		const format: SignatureFormat = "raw";
		const secret = "test_secret";
		const body = Buffer.from("raw payload data");

		// Compute expected HMAC
		const expectedHmac = createHmac("sha256", secret).update(body).digest("hex");

		// Build headers
		const headers = new Headers({
			"X-Webhook-Signature": expectedHmac,
		});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(true);
	});

	// ──────────────────────────────────────────────────────────────────
	// AC1.5: All formats return invalid for incorrect HMAC
	// ──────────────────────────────────────────────────────────────────
	test("AC1.5: GitHub format returns invalid for incorrect HMAC", () => {
		const format: SignatureFormat = "github";
		const secret = "test_secret";
		const body = Buffer.from('{"action":"opened"}');
		const wrongHmac = "0000000000000000000000000000000000000000000000000000000000000000";

		const headers = new Headers({
			"X-Hub-Signature-256": `sha256=${wrongHmac}`,
		});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(false);
	});

	test("AC1.5: Stripe format returns invalid for incorrect HMAC", () => {
		const format: SignatureFormat = "stripe";
		const secret = "test_secret";
		const body = Buffer.from('{"type":"charge.completed"}');
		const timestamp = Math.floor(Date.now() / 1000).toString();
		const wrongHmac = "0000000000000000000000000000000000000000000000000000000000000000";

		const headers = new Headers({
			"Stripe-Signature": `t=${timestamp},v1=${wrongHmac}`,
		});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(false);
	});

	test("AC1.5: Slack format returns invalid for incorrect HMAC", () => {
		const format: SignatureFormat = "slack";
		const secret = "test_secret";
		const body = Buffer.from('{"type":"url_verification"}');
		const timestamp = Math.floor(Date.now() / 1000).toString();
		const wrongHmac = "0000000000000000000000000000000000000000000000000000000000000000";

		const headers = new Headers({
			"X-Slack-Signature": `v0=${wrongHmac}`,
			"X-Slack-Request-Timestamp": timestamp,
		});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(false);
	});

	test("AC1.5: Raw format returns invalid for incorrect HMAC", () => {
		const format: SignatureFormat = "raw";
		const secret = "test_secret";
		const body = Buffer.from("raw payload data");
		const wrongHmac = "0000000000000000000000000000000000000000000000000000000000000000";

		const headers = new Headers({
			"X-Webhook-Signature": wrongHmac,
		});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(false);
	});

	// ──────────────────────────────────────────────────────────────────
	// AC1.6: Missing signature headers return invalid
	// ──────────────────────────────────────────────────────────────────
	test("AC1.6: GitHub format returns invalid when signature header missing", () => {
		const format: SignatureFormat = "github";
		const secret = "test_secret";
		const body = Buffer.from('{"action":"opened"}');

		const headers = new Headers({});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(false);
	});

	test("AC1.6: Stripe format returns invalid when signature header missing", () => {
		const format: SignatureFormat = "stripe";
		const secret = "test_secret";
		const body = Buffer.from('{"type":"charge.completed"}');

		const headers = new Headers({});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(false);
	});

	test("AC1.6: Slack format returns invalid when signature header missing", () => {
		const format: SignatureFormat = "slack";
		const secret = "test_secret";
		const body = Buffer.from('{"type":"url_verification"}');

		const headers = new Headers({});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(false);
	});

	test("AC1.6: Raw format returns invalid when signature header missing", () => {
		const format: SignatureFormat = "raw";
		const secret = "test_secret";
		const body = Buffer.from("raw payload data");

		const headers = new Headers({});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(false);
	});

	// ──────────────────────────────────────────────────────────────────
	// AC1.7: Stripe/Slack timestamps older than 5 minutes return invalid
	// ──────────────────────────────────────────────────────────────────
	test("AC1.7: Stripe format returns invalid for stale timestamp (>5 minutes)", () => {
		const format: SignatureFormat = "stripe";
		const secret = "test_secret";
		const body = Buffer.from('{"type":"charge.completed"}');
		const staleTimestamp = Math.floor((Date.now() - 6 * 60 * 1000) / 1000).toString();

		const payload = `${staleTimestamp}.${body.toString("utf-8")}`;
		const hmac = createHmac("sha256", secret).update(payload).digest("hex");

		const headers = new Headers({
			"Stripe-Signature": `t=${staleTimestamp},v1=${hmac}`,
		});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(false);
	});

	test("AC1.7: Slack format returns invalid for stale timestamp (>5 minutes)", () => {
		const format: SignatureFormat = "slack";
		const secret = "test_secret";
		const body = Buffer.from('{"type":"url_verification"}');
		const staleTimestamp = Math.floor((Date.now() - 6 * 60 * 1000) / 1000).toString();

		const payload = `v0:${staleTimestamp}:${body.toString("utf-8")}`;
		const hmac = createHmac("sha256", secret).update(payload).digest("hex");

		const headers = new Headers({
			"X-Slack-Signature": `v0=${hmac}`,
			"X-Slack-Request-Timestamp": staleTimestamp,
		});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(false);
	});

	// ──────────────────────────────────────────────────────────────────
	// AC1.8: timingSafeEqual is used (wrong-length signatures don't crash)
	// ──────────────────────────────────────────────────────────────────
	test("AC1.8: handles wrong-length signatures without crashing (timingSafeEqual safety)", () => {
		const format: SignatureFormat = "github";
		const secret = "test_secret";
		const body = Buffer.from('{"action":"opened"}');

		// Provide a signature that's too short
		const shortHmac = "0000";

		const headers = new Headers({
			"X-Hub-Signature-256": `sha256=${shortHmac}`,
		});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(false);
	});

	// ──────────────────────────────────────────────────────────────────
	// Additional edge cases
	// ──────────────────────────────────────────────────────────────────
	test("handles empty body", () => {
		const format: SignatureFormat = "github";
		const secret = "test_secret";
		const body = Buffer.alloc(0);

		const expectedHmac = createHmac("sha256", secret).update(body).digest("hex");

		const headers = new Headers({
			"X-Hub-Signature-256": `sha256=${expectedHmac}`,
		});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(true);
	});

	test("handles empty secret", () => {
		const format: SignatureFormat = "github";
		const secret = "";
		const body = Buffer.from("test");

		const expectedHmac = createHmac("sha256", secret).update(body).digest("hex");

		const headers = new Headers({
			"X-Hub-Signature-256": `sha256=${expectedHmac}`,
		});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(true);
	});

	test("Slack format returns invalid when timestamp header is missing", () => {
		const format: SignatureFormat = "slack";
		const secret = "test_secret";
		const body = Buffer.from('{"type":"url_verification"}');
		const timestamp = Math.floor(Date.now() / 1000).toString();

		const payload = `v0:${timestamp}:${body.toString("utf-8")}`;
		const expectedHmac = createHmac("sha256", secret).update(payload).digest("hex");

		// Missing X-Slack-Request-Timestamp header
		const headers = new Headers({
			"X-Slack-Signature": `v0=${expectedHmac}`,
		});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(false);
	});

	test("Stripe format returns invalid when timestamp is missing", () => {
		const format: SignatureFormat = "stripe";
		const secret = "test_secret";
		const body = Buffer.from('{"type":"charge.completed"}');

		// Missing t= in signature
		const headers = new Headers({
			"Stripe-Signature": "v1=0000000000000000000000000000000000000000000000000000000000000000",
		});

		const result = validateWebhookSignature(format, secret, headers, body);
		expect(result.valid).toBe(false);
	});
});

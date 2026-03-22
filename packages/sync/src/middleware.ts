import type { KeyringConfig } from "@bound/shared";
import type { Context, MiddlewareHandler } from "hono";
import { detectClockSkew, verifyRequest } from "./signing.js";

type AppContext = {
	Variables: {
		siteId: string;
		hostName: string;
	};
};

export function createSyncAuthMiddleware(keyring: KeyringConfig): MiddlewareHandler<AppContext> {
	return async (c: Context<AppContext>, next) => {
		const method = c.req.method;
		const path = c.req.path;
		const body = await c.req.text();

		const headers: Record<string, string> = {};
		c.req.raw.headers.forEach((value, key) => {
			headers[key.toLowerCase()] = value;
		});

		const result = await verifyRequest(keyring, method, path, headers, body);

		if (!result.ok) {
			const error = result.error;
			let statusCode: 401 | 403 | 408 | 500 = 500;

			if (error.code === "unknown_site") {
				statusCode = 403;
			} else if (error.code === "invalid_signature") {
				statusCode = 401;
			} else if (error.code === "stale_timestamp") {
				statusCode = 408;
			}

			return c.json({ error: error.message }, statusCode);
		}

		c.set("siteId", result.value.siteId);
		c.set("hostName", result.value.hostName);

		// Check for clock skew
		const remoteTimestamp = headers["x-timestamp"];
		if (remoteTimestamp) {
			const now = new Date().toISOString();
			const skew = detectClockSkew(now, remoteTimestamp);
			if (skew !== null) {
				c.header("X-Clock-Skew", skew.toString());
			}
		}

		await next();
	};
}

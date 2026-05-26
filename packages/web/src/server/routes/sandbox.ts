import { Hono } from "hono";
import type { MountableFs } from "just-bash";

/**
 * Routes for direct read/write access to the sandbox cluster filesystem at
 * arbitrary paths. Used by `boundless_copy` to bridge the host filesystem
 * (where the boundless TUI runs) and the bound runtime sandbox without
 * round-tripping bytes through the LLM context window.
 *
 * The cluster FS is a virtual `MountableFs` from just-bash, distinct from
 * the synced `files` table that `/api/files` exposes — those are an
 * end-of-loop snapshot of selected paths, while these endpoints hit the
 * live sandbox. Bytes are passed as raw octet-stream bodies and converted
 * to/from just-bash's binary-string convention (each char = 1 byte).
 *
 * Security: relies on the same Host-header DNS-rebinding protection as
 * the rest of `/api/*`. No additional auth — the boundless TUI is the
 * intended caller.
 */
export function createSandboxRoutes(clusterFs: MountableFs | null): Hono {
	const app = new Hono();

	app.get("/file", async (c) => {
		if (!clusterFs) {
			return c.json({ error: "Sandbox filesystem not available" }, 503);
		}
		const path = c.req.query("path");
		if (!path) {
			return c.json({ error: "Missing required query parameter: path" }, 400);
		}

		try {
			// just-bash IFileSystem returns string; binary content uses
			// "binary" encoding (each char = 1 byte). Round-trip through Buffer
			// to produce raw octets for the wire.
			const content = await clusterFs.readFile(path);
			const buf = Buffer.from(content, "binary");
			return new Response(buf, {
				status: 200,
				headers: {
					"Content-Type": "application/octet-stream",
					"Content-Length": String(buf.byteLength),
				},
			});
		} catch (err) {
			const e = err as Error & { code?: string };
			const msg = e.message || String(err);
			if (e.code === "ENOENT" || msg.startsWith("ENOENT:")) {
				return c.json({ error: `File not found: ${path}` }, 404);
			}
			if (e.code === "EISDIR" || msg.startsWith("EISDIR:")) {
				return c.json({ error: `Path is a directory: ${path}` }, 400);
			}
			return c.json({ error: "Failed to read sandbox file", details: msg }, 500);
		}
	});

	app.put("/file", async (c) => {
		if (!clusterFs) {
			return c.json({ error: "Sandbox filesystem not available" }, 503);
		}
		const path = c.req.query("path");
		if (!path) {
			return c.json({ error: "Missing required query parameter: path" }, 400);
		}

		try {
			const arrayBuffer = await c.req.arrayBuffer();
			// Convert raw octets to just-bash's binary-string convention.
			const content = Buffer.from(arrayBuffer).toString("binary");
			await clusterFs.writeFile(path, content);
			return c.json({ bytes: arrayBuffer.byteLength });
		} catch (err) {
			const e = err as Error & { code?: string };
			const msg = e.message || String(err);
			if (e.code === "EISDIR" || msg.startsWith("EISDIR:")) {
				return c.json({ error: `Path is a directory: ${path}` }, 400);
			}
			return c.json({ error: "Failed to write sandbox file", details: msg }, 500);
		}
	});

	return app;
}

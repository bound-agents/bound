import { Hono } from "hono";

export function createApp(): Hono {
	const app = new Hono();

	app.get("/", (c) => {
		return c.text("Bound Web Server");
	});

	return app;
}

export const app = createApp();

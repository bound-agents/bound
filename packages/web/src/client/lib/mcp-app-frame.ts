// Commit 3 of the MCP-Apps-in-web-UI feature: see project memory
// project:mcp-apps-web-ui:commit3-sandbox-decision.
//
// Pure helpers for rendering an MCP App inside the bound web UI under the
// hard single-origin (:3001, web router only) constraint. Each app runs in a
// single iframe with sandbox="allow-scripts allow-forms" (NO allow-same-origin)
// => opaque/null origin, isolated from the host page, communicating only over
// the MCP-Apps postMessage protocol. The app HTML is delivered via srcdoc (a
// null-origin frame cannot fetch a served proxy document from :3001), so the
// requested CSP is applied via an injected <meta http-equiv> tag rather than an
// HTTP header. This module is framework-agnostic and DOM-free so it is unit
// tested directly; the AppBridge/iframe wiring lives in mcp-app-bridge.ts.
import {
	type McpUiResourceCsp,
	buildAllowAttribute,
} from "@modelcontextprotocol/ext-apps/app-bridge";

/**
 * Sandbox attribute for the app iframe. `allow-scripts` lets the bundled app
 * run; `allow-forms` lets it submit forms. We deliberately omit
 * `allow-same-origin` so the frame keeps an opaque origin and cannot reach the
 * host page's :3001 cookies, storage, or DOM — the isolation boundary.
 */
export const APP_FRAME_SANDBOX = "allow-scripts allow-forms";

/**
 * Validate CSP domain entries to prevent injection. Rejects entries containing
 * characters that could break out to a new directive (`;`, newlines), inject
 * CSP keywords (quotes), or smuggle multiple sources in one entry (space).
 * Mirrors ext-apps `examples/basic-host/serve.ts#sanitizeCspDomains`.
 */
export function sanitizeCspDomains(domains?: string[]): string[] {
	if (!domains) return [];
	return domains.filter((d) => typeof d === "string" && !/[;\r\n'" ]/.test(d));
}

/**
 * Serialize a requested resource CSP into a policy string suitable for a
 * `<meta http-equiv="Content-Security-Policy">` tag. Mirrors the directive
 * mapping of ext-apps `examples/basic-host/serve.ts#buildCspHeader` (the
 * known-working policy that boots the reference apps): same-origin + inline
 * scripts/styles are always allowed (bundled apps need them), `blob:`/`data:`
 * cover workers and inline assets, and the resource's declared domains widen
 * the network/asset/frame allowances. Omitted lists fall back to secure
 * defaults (`frame-src 'none'`, `base-uri 'none'`).
 */
export function buildCspString(csp?: McpUiResourceCsp): string {
	const resourceDomains = sanitizeCspDomains(csp?.resourceDomains).join(" ");
	const connectDomains = sanitizeCspDomains(csp?.connectDomains).join(" ");
	const frameDomains = sanitizeCspDomains(csp?.frameDomains).join(" ") || null;
	const baseUriDomains = sanitizeCspDomains(csp?.baseUriDomains).join(" ") || null;

	const directives = [
		"default-src 'self' 'unsafe-inline'",
		`script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resourceDomains}`.trim(),
		`style-src 'self' 'unsafe-inline' blob: data: ${resourceDomains}`.trim(),
		`img-src 'self' data: blob: ${resourceDomains}`.trim(),
		`font-src 'self' data: blob: ${resourceDomains}`.trim(),
		`media-src 'self' data: blob: ${resourceDomains}`.trim(),
		`connect-src 'self' ${connectDomains}`.trim(),
		`worker-src 'self' blob: ${resourceDomains}`.trim(),
		frameDomains ? `frame-src ${frameDomains}` : "frame-src 'none'",
		"object-src 'none'",
		baseUriDomains ? `base-uri ${baseUriDomains}` : "base-uri 'none'",
	];
	return directives.join("; ");
}

/**
 * Build the srcdoc HTML for an MCP App iframe. When the resource declares a
 * CSP, a `<meta http-equiv="Content-Security-Policy">` tag is injected into the
 * document head (HTTP headers aren't available for srcdoc content). The CSP
 * string never contains a double quote (sanitizeCspDomains strips them and the
 * literal keywords use single quotes), so embedding it in a double-quoted
 * attribute is safe. With no CSP the app HTML is returned verbatim.
 */
export function buildAppFrameSrcdoc(html: string, csp?: McpUiResourceCsp): string {
	if (!csp) return html;

	const meta = `<meta http-equiv="Content-Security-Policy" content="${buildCspString(csp)}">`;

	const headOpen = /<head[^>]*>/i.exec(html);
	if (headOpen) {
		const at = headOpen.index + headOpen[0].length;
		return html.slice(0, at) + meta + html.slice(at);
	}

	const htmlOpen = /<html[^>]*>/i.exec(html);
	if (htmlOpen) {
		const at = htmlOpen.index + htmlOpen[0].length;
		return `${html.slice(0, at)}<head>${meta}</head>${html.slice(at)}`;
	}

	// No <html>/<head> scaffold: prepend the meta so the policy still applies.
	return meta + html;
}

/**
 * Permission-Policy `allow` attribute value for the app iframe, derived from
 * the resource's requested permissions. Thin re-export of ext-apps
 * `buildAllowAttribute` so the iframe wiring imports a single frame module.
 */
export const frameAllowAttribute = buildAllowAttribute;

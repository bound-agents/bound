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
 * In-memory `localStorage`/`sessionStorage` shim injected into every app frame.
 *
 * The app frame runs at an opaque (null) origin (no `allow-same-origin`), where
 * accessing `window.localStorage` throws a SecurityError. Many app bundles
 * (e.g. anything built on jotai/React state persistence) read storage at import
 * time and crash or log loudly on that throw. We can't grant same-origin
 * without dissolving the isolation boundary, so instead we shadow the throwing
 * native accessors with an own-property in-memory store BEFORE any app code
 * runs. Storage is per-render and non-persistent — which is the correct
 * semantics for a sandboxed app frame anyway. The IIFE is self-contained and
 * contains no characters that need escaping inside a srcdoc document.
 */
const STORAGE_SHIM = `<script>(function(){try{var s={},api={getItem:function(k){return Object.prototype.hasOwnProperty.call(s,String(k))?s[String(k)]:null;},setItem:function(k,v){s[String(k)]=String(v);},removeItem:function(k){delete s[String(k)];},clear:function(){s={};},key:function(i){var ks=Object.keys(s);return i<ks.length?ks[i]:null;},get length(){return Object.keys(s).length;}};Object.defineProperty(window,"localStorage",{value:api,configurable:true});Object.defineProperty(window,"sessionStorage",{value:api,configurable:true});}catch(e){}})();</script>`;

/**
 * Build the srcdoc HTML for an MCP App iframe. Two things are injected into the
 * document head: (1) an in-memory storage shim (always — see STORAGE_SHIM) so
 * the opaque-origin frame doesn't crash on `localStorage` access, and (2) when
 * the resource declares a CSP, a `<meta http-equiv="Content-Security-Policy">`
 * tag (HTTP headers aren't available for srcdoc content). The CSP string never
 * contains a double quote (sanitizeCspDomains strips them and the literal
 * keywords use single quotes), so embedding it in a double-quoted attribute is
 * safe. The CSP allows `'unsafe-inline'` script, so the shim runs under it. The
 * meta precedes the shim so the policy applies to the shim and everything after.
 */
export function buildAppFrameSrcdoc(html: string, csp?: McpUiResourceCsp): string {
	const meta = csp
		? `<meta http-equiv="Content-Security-Policy" content="${buildCspString(csp)}">`
		: "";
	const inject = meta + STORAGE_SHIM;

	const headOpen = /<head[^>]*>/i.exec(html);
	if (headOpen) {
		const at = headOpen.index + headOpen[0].length;
		return html.slice(0, at) + inject + html.slice(at);
	}

	const htmlOpen = /<html[^>]*>/i.exec(html);
	if (htmlOpen) {
		const at = htmlOpen.index + htmlOpen[0].length;
		return `${html.slice(0, at)}<head>${inject}</head>${html.slice(at)}`;
	}

	// No <html>/<head> scaffold: prepend the injected head content so both the
	// shim and (if present) the policy still apply.
	return inject + html;
}

/**
 * Permission-Policy `allow` attribute value for the app iframe, derived from
 * the resource's requested permissions. Thin re-export of ext-apps
 * `buildAllowAttribute` so the iframe wiring imports a single frame module.
 */
export const frameAllowAttribute = buildAllowAttribute;

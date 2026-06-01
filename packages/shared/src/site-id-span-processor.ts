import type { Context } from "@opentelemetry/api";
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * Span attribute carrying the site ID of the host that executed the span (issue #152).
 *
 * It is a *span* attribute rather than a resource attribute deliberately: span
 * attributes survive `serializeReadableSpan` → `reExportSpans` cross-host shipping
 * (the re-export path constructs a fresh `service.name: "bound-client"` resource and
 * drops the origin resource), whereas a resource attribute would be lost the moment a
 * delegated-inference span is re-exported on the requesting spoke. Stamping the
 * executing host's own site ID at span-creation time means a re-exported hub span
 * arrives on the spoke already tagged with the *hub's* site ID — exactly the
 * "which site actually ran this loop" hint the issue asks for.
 */
export const SITE_ID_ATTR = "bound.site_id";

/**
 * A SpanProcessor that stamps {@link SITE_ID_ATTR} onto every span at start.
 *
 * The site ID can be supplied at construction (hub-side scoped collectors know it
 * immediately) or set later via {@link setSiteId} (the global provider is initialized
 * at Phase 0, before bootstrap derives the site ID from the host keypair). Spans created
 * before the site ID is known simply carry no tag — acceptable, since those are
 * startup-infra spans rather than agent loops.
 */
export class SiteIdSpanProcessor implements SpanProcessor {
	private siteId: string | undefined;

	constructor(siteId?: string) {
		this.siteId = siteId;
	}

	setSiteId(siteId: string): void {
		this.siteId = siteId;
	}

	onStart(span: Span, _parentContext: Context): void {
		if (this.siteId) {
			span.setAttribute(SITE_ID_ATTR, this.siteId);
		}
	}

	onEnd(): void {}

	forceFlush(): Promise<void> {
		return Promise.resolve();
	}

	shutdown(): Promise<void> {
		return Promise.resolve();
	}
}

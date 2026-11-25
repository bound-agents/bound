import { type Locator, type Page, expect } from "@playwright/test";

/** Pixel tolerance for subpixel rounding in every geometry check. */
const TOL = 1;

/** Fails unless the element has area and sits fully inside the viewport. */
export async function assertInViewport(locator: Locator): Promise<void> {
	await expect(locator).toBeVisible();
	const r = await locator.evaluate((el) => {
		const b = el.getBoundingClientRect();
		return {
			left: b.left,
			top: b.top,
			right: b.right,
			bottom: b.bottom,
			width: b.width,
			height: b.height,
			vw: window.innerWidth,
			vh: window.innerHeight,
		};
	});
	const where = JSON.stringify(r);
	expect(r.width, `zero width: ${where}`).toBeGreaterThan(0);
	expect(r.height, `zero height: ${where}`).toBeGreaterThan(0);
	expect(r.left, `left edge off-screen: ${where}`).toBeGreaterThanOrEqual(-TOL);
	expect(r.top, `top edge off-screen: ${where}`).toBeGreaterThanOrEqual(-TOL);
	expect(r.right, `right edge off-screen: ${where}`).toBeLessThanOrEqual(r.vw + TOL);
	expect(r.bottom, `bottom edge off-screen: ${where}`).toBeLessThanOrEqual(r.vh + TOL);
}

/**
 * Fails when any clipping ancestor (overflow hidden/clip/scroll/auto) cuts the
 * element. A `position: fixed` element escapes ancestors unless one of them
 * establishes a containing block (transform, filter, contain, backdrop-filter,
 * perspective).
 */
export async function assertNotClipped(locator: Locator): Promise<void> {
	await expect(locator).toBeVisible();
	const failures = await locator.evaluate((el, tol) => {
		const clips = (v: string) => /(hidden|clip|scroll|auto)/.test(v);
		const makesContainingBlock = (s: CSSStyleDeclaration) =>
			(s.transform && s.transform !== "none") ||
			(s.filter && s.filter !== "none") ||
			(s.perspective && s.perspective !== "none") ||
			// biome-ignore lint/suspicious/noExplicitAny: vendor-prefixed property
			((s as any).backdropFilter && (s as any).backdropFilter !== "none") ||
			/(paint|layout|strict|content)/.test(s.contain || "");
		const elRect = el.getBoundingClientRect();
		let escaping = getComputedStyle(el).position === "fixed";
		const out: string[] = [];
		for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
			const s = getComputedStyle(a);
			if (escaping) {
				if (makesContainingBlock(s)) escaping = false;
				else continue;
			}
			if (clips(s.overflow) || clips(s.overflowX) || clips(s.overflowY)) {
				const r = a.getBoundingClientRect();
				const clipX = clips(s.overflowX) || clips(s.overflow);
				const clipY = clips(s.overflowY) || clips(s.overflow);
				const bad =
					(clipX && (elRect.left < r.left - tol || elRect.right > r.right + tol)) ||
					(clipY && (elRect.top < r.top - tol || elRect.bottom > r.bottom + tol));
				if (bad) {
					out.push(
						`${a.tagName.toLowerCase()}.${a.className} [${r.left},${r.top},${r.right},${r.bottom}] clips [${elRect.left},${elRect.top},${elRect.right},${elRect.bottom}]`,
					);
				}
			}
			if (s.position === "fixed") escaping = true;
		}
		return out;
	}, TOL);
	expect(failures, "element clipped by an ancestor").toEqual([]);
}
/** Fails when `action` moves or resizes `container` by more than 1px. */
export async function assertNoLayoutShift(
	container: Locator,
	action: () => Promise<void>,
): Promise<void> {
	const measure = () =>
		container.evaluate((el) => {
			const b = el.getBoundingClientRect();
			return { top: b.top, height: b.height, width: b.width };
		});
	// The conversation column can still be settling (a few px over ~6 frames)
	// right after mount; measuring mid-settle reports that drift as a shift.
	const settle = () =>
		container.evaluate(
			(el) =>
				new Promise<void>((resolve) => {
					let last = Number.NaN;
					let stable = 0;
					let frames = 0;
					const tick = () => {
						const top = el.getBoundingClientRect().top;
						stable = Math.abs(top - last) < 0.01 ? stable + 1 : 0;
						last = top;
						if (stable >= 3 || ++frames > 120) resolve();
						else requestAnimationFrame(tick);
					};
					requestAnimationFrame(tick);
				}),
		);
	await settle();
	const before = await measure();
	await action();
	await settle();
	const after = await measure();
	expect(Math.abs(after.top - before.top), "top shifted").toBeLessThanOrEqual(TOL);
	expect(Math.abs(after.height - before.height), "height shifted").toBeLessThanOrEqual(TOL);
	expect(Math.abs(after.width - before.width), "width shifted").toBeLessThanOrEqual(TOL);
}

/** Fails when the document scrolls horizontally. */
export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
	const r = await page.evaluate(() => {
		let widest = "";
		const vw = window.innerWidth;
		for (const el of document.querySelectorAll("body *")) {
			const b = el.getBoundingClientRect();
			if (b.right > vw + 1 && b.width > 0) {
				widest = `${el.tagName.toLowerCase()}.${(el as HTMLElement).className} right=${b.right}`;
				break;
			}
		}
		return { sw: document.documentElement.scrollWidth, vw, widest };
	});
	expect(r.sw, `horizontal overflow (${r.widest})`).toBeLessThanOrEqual(r.vw + TOL);
}

/** Fails when any visible `<text>` in the SVG extends past the SVG's box. */
export async function assertSvgTextNotClipped(svg: Locator): Promise<void> {
	await expect(svg).toBeVisible();
	const failures = await svg.evaluate((root, tol) => {
		const box = root.getBoundingClientRect();
		const out: string[] = [];
		for (const t of root.querySelectorAll("text")) {
			const s = getComputedStyle(t);
			if (s.display === "none" || s.visibility === "hidden" || !t.textContent?.trim()) continue;
			const r = t.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) continue;
			if (
				r.left < box.left - tol ||
				r.right > box.right + tol ||
				r.top < box.top - tol ||
				r.bottom > box.bottom + tol
			) {
				out.push(
					`"${t.textContent}" [${r.left},${r.top},${r.right},${r.bottom}] outside [${box.left},${box.top},${box.right},${box.bottom}]`,
				);
			}
		}
		return out;
	}, TOL);
	expect(failures, "SVG text clipped").toEqual([]);
}

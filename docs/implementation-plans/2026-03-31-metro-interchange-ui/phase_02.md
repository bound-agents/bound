# Metro Interchange UI — Phase 2: Tokyo Metro Circle Icons

**Goal:** Update all letter-in-circle badge elements to authentic Tokyo Metro signage style: colored outer circle, white inner circle (~65-70% diameter), solid black bold letter.

**Architecture:** Two independent CSS/SVG changes — one in SystemMap.svelte (CSS-based badge) and one in NetworkStatus.svelte (SVG-based badge). Both adopt the same visual pattern but use different rendering techniques matching their existing implementations.

**Tech Stack:** Svelte 5, CSS, SVG

**Scope:** Phase 2 of 4 from original design

**Codebase verified:** 2026-03-31

---

## Acceptance Criteria Coverage

This phase implements and tests:

### metro-interchange-ui.AC4: Tokyo Metro Circle Icons
- **metro-interchange-ui.AC4.1 Success:** SystemMap `.line-badge` shows filled colored circle + white inner circle (~65-70% diameter) + solid black bold letter
- **metro-interchange-ui.AC4.2 Success:** NetworkStatus `.host-badge` shows filled colored circle + white inner circle + solid black bold letter
- **metro-interchange-ui.AC4.3 Success:** White inner circle is proportional (~65-70% of outer diameter) across both components
- **metro-interchange-ui.AC4.4 Edge:** All 10 metro line colors render correctly with the new icon style (no color contrast issues)

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Update SystemMap .line-badge to Tokyo Metro signage style

**Verifies:** metro-interchange-ui.AC4.1, metro-interchange-ui.AC4.3, metro-interchange-ui.AC4.4

**Files:**
- Modify: `packages/web/src/client/views/SystemMap.svelte:169-171` (HTML template)
- Modify: `packages/web/src/client/views/SystemMap.svelte:340-358` (CSS styles)

**Implementation:**

The current `.line-badge` is a simple colored circle with white text:

```html
<!-- Current (line 169-171): -->
<div class="line-badge" style="background: {color}">
    <span class="badge-code">{code}</span>
</div>
```

Add a `<span class="badge-inner">` element between the outer badge and the code text to create the white inner circle:

```html
<!-- Updated: -->
<div class="line-badge" style="background: {color}">
    <span class="badge-inner"></span>
    <span class="badge-code">{code}</span>
</div>
```

Update the CSS:

```css
/* .line-badge stays the same (lines 340-350): */
.line-badge {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    z-index: 1;
}

/* NEW — white inner circle at ~67% diameter (24px / 36px ≈ 67%): */
.badge-inner {
    position: absolute;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: #fff;
}

/* UPDATED .badge-code — change from white to black, add z-index to sit above inner circle: */
.badge-code {
    color: #000;
    font-family: var(--font-display);
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
    position: relative;
    z-index: 1;
}
```

The white inner circle (24px) is ~67% of the outer circle (36px), matching the AC requirement of ~65-70%. The `badge-code` gets `position: relative; z-index: 1` so the text renders above the white inner circle. Text color changes from `#fff` to `#000` for authentic Metro signage.

**Verification:**

Run: `bun run build`
Expected: Build succeeds without errors.

Visual verification: All 10 metro line colors should show colored outer ring, white inner circle, black bold letter. Colors with lower contrast against white (silver/Hibiya #9CAEB7, gold/Yurakucho #C1A470) should still be clearly visible as the outer ring is 6px wide.

**Commit:** `style(web): update SystemMap line badges to Tokyo Metro signage style`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Update NetworkStatus .host-badge SVG to Tokyo Metro signage style

**Verifies:** metro-interchange-ui.AC4.2, metro-interchange-ui.AC4.3, metro-interchange-ui.AC4.4

**Files:**
- Modify: `packages/web/src/client/views/NetworkStatus.svelte:172-189` (SVG template)

**Implementation:**

The current `.host-badge` SVG uses a hollow circle (stroke only, no fill) with colored text:

```html
<!-- Current (lines 173-189): -->
<svg width="36" height="36" viewBox="0 0 36 36">
    <circle cx="18" cy="18" r="16" fill="none"
        stroke={online ? "var(--line-4)" : "var(--alert-disruption)"}
        stroke-width="2.5" />
    {#if isHub}
        <circle cx="18" cy="18" r="10" fill="none"
            stroke={online ? "var(--line-4)" : "var(--alert-disruption)"}
            stroke-width="1.5" opacity="0.4" />
    {/if}
    <text x="18" y="18" font-size="14" font-weight="700"
        fill={online ? "var(--line-4)" : "var(--alert-disruption)"}
        text-anchor="middle" dominant-baseline="central"
        font-family="'Nunito Sans', sans-serif"
    >{isHub ? "H" : String.fromCharCode(65 + idx)}</text>
</svg>
```

Update to filled outer circle + white inner circle + black text:

```html
<!-- Updated: -->
<svg width="36" height="36" viewBox="0 0 36 36">
    <!-- Outer filled circle in metro color -->
    <circle cx="18" cy="18" r="17"
        fill={online ? "var(--line-4)" : "var(--alert-disruption)"} />
    <!-- White inner circle (~65% diameter: 11/17 ≈ 65%) -->
    <circle cx="18" cy="18" r="11" fill="#fff" />
    {#if isHub}
        <!-- Hub indicator: subtle ring inside the white area -->
        <circle cx="18" cy="18" r="10" fill="none"
            stroke={online ? "var(--line-4)" : "var(--alert-disruption)"}
            stroke-width="1" opacity="0.3" />
    {/if}
    <!-- Black bold letter -->
    <text x="18" y="18" font-size="14" font-weight="700"
        fill="#000"
        text-anchor="middle" dominant-baseline="central"
        font-family="'Nunito Sans', sans-serif"
    >{isHub ? "H" : String.fromCharCode(65 + idx)}</text>
</svg>
```

Key changes:
1. Outer `<circle>` changes from `fill="none" stroke=...` to `fill={color}` (filled circle, r=17 to fill the 36px viewBox edge-to-edge)
2. New white inner `<circle>` at r=11 (~65% of r=17 outer, matching AC4.3's ~65-70% spec)
3. Hub indicator ring becomes subtler (stroke-width 1, opacity 0.3) to sit inside the white area
4. `<text>` fill changes from dynamic color to `#000` (solid black)

The host badge now uses the same color regardless of which host — `var(--line-4)` for online, `var(--alert-disruption)` for offline. This matches the existing behavior; the design doesn't change the color assignment logic, only the visual style.

**Verification:**

Run: `bun run build`
Expected: Build succeeds without errors.

Visual verification: Host badges show colored filled circle + white inner circle + black letter. Hub nodes show "H" with a subtle inner ring. Offline hosts show the disruption color (red) instead of green.

**Commit:** `style(web): update NetworkStatus host badges to Tokyo Metro signage style`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

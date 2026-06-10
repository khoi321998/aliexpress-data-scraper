// Product specifications extraction — the name/value table from the AliExpress PDP.
//
// The spec block (`#nav-specification` / `[data-pl="product-specs"]`) is lazy-rendered: it only
// populates once scrolled into view, and by default shows a truncated list behind a "View more"
// button. So we first bring the section into view (the page's own "Specifications" anchor does
// this), expand it, then read every `specification--prop` (a `title` label + `desc` value) pair.
//
// Class names are content-hashed per build, so every selector matches on the stable
// `specification--…` prefix rather than the exact suffixed name.
import type { Log } from 'apify';
import type { Page } from 'playwright';

import type { Specification } from './types.js';

// The section container, the page's nav-bar jump-link to it, the expand button, and the prop
// pieces. The nav anchor is the `comet-v2-anchor-link` in the sticky tab bar — clicking it is
// what scrolls the lazy-rendered section into view.
const SECTION_SELECTOR = '#nav-specification, [data-pl="product-specs"], [class*="specification--wrap"]';
const ANCHOR_SELECTOR = 'a.comet-v2-anchor-link[href="#nav-specification"], a[href="#nav-specification"]';
const VIEW_MORE_SELECTOR = '[class*="specification--btn"]';
const PROP_SELECTOR = '[class*="specification--prop"]';

/**
 * Bring the spec section into view and fully expand it.
 *
 * The section is lazy-rendered: its rows only mount once it actually enters the viewport. So we
 * click the "Specifications" tab in the nav bar, force the section itself into view, and poll —
 * nudging the scroll if needed — until the prop rows appear. Then we click "View more" to reveal
 * the rows hidden by default. Everything is best-effort: a product with few specs has no button.
 */
async function revealSpecifications(page: Page, log: Log): Promise<void> {
    // 1. Click the nav-bar "Specifications" tab (the tab the user wants clicked).
    const anchor = page.locator(ANCHOR_SELECTOR).first();
    if (await anchor.count().catch(() => 0)) {
        await anchor.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
        await anchor.click({ timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(800);
    }

    // 2. Poll for the lazy-rendered rows, nudging the section into view each round.
    const section = page.locator(SECTION_SELECTOR).first();
    for (let attempt = 0; attempt < 6; attempt += 1) {
        if (await page.locator(PROP_SELECTOR).count().catch(() => 0)) {
            break;
        }
        await section.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
        await page.mouse.wheel(0, 400).catch(() => undefined);
        await page.waitForTimeout(600);
    }

    // 3. Expand the truncated list. Only the "View more" state expands; once toggled it becomes
    //    "View less"/hidden.
    const viewMore = page.locator(VIEW_MORE_SELECTOR).first();
    if (await viewMore.count().catch(() => 0)) {
        const label = (await viewMore.textContent().catch(() => ''))?.toLowerCase() ?? '';
        if (label.includes('view more')) {
            await viewMore.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
            await viewMore.click({ timeout: 5_000 }).catch(() => undefined);
            await page.waitForTimeout(500);
            log.debug('expanded specifications via "View more"');
        }
    }
}

const PROP_TITLE_SELECTOR = '[class*="specification--title"]';
const PROP_DESC_SELECTOR = '[class*="specification--desc"]';

/** Collapse whitespace and trim; treats null/undefined as empty. */
function clean(value: string | null | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Locate spec prop rows, retrying until they mount (the rows appear asynchronously after the tab
 * is opened/expanded). Returns the matching locator and its count.
 */
async function waitForProps(page: Page): Promise<{ props: ReturnType<Page['locator']>; count: number }> {
    const props = page.locator(PROP_SELECTOR);
    let count = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        count = await props.count().catch(() => 0);
        if (count > 0) {
            break;
        }
        await page.waitForTimeout(1_000);
    }
    return { props, count };
}

/**
 * Extract the product specifications as name/value pairs.
 *
 * Reveals + expands the section, waits for the rows to mount, then reads each prop with
 * Playwright locators (auto-waiting, no `evaluate` world to silently fail in). Logs the located
 * row count; when it is zero, dumps a snippet of the section markup so the cause is visible.
 * Values prefer the `desc` element's `title` attribute (the full, untruncated text).
 */
export async function extractSpecifications(page: Page, log: Log): Promise<Specification[]> {
    await revealSpecifications(page, log);

    const { props, count } = await waitForProps(page);
    log.info('specification props located', { count });

    if (count === 0) {
        const sectionHtml = await page
            .locator(SECTION_SELECTOR)
            .first()
            .innerHTML()
            .catch(() => null);
        log.warning('no specification rows found — dumping section markup', {
            url: page.url(),
            sectionHtmlSnippet: sectionHtml?.slice(0, 1_500) ?? null,
        });
        return [];
    }

    const seen = new Set<string>();
    const specs: Specification[] = [];
    for (let i = 0; i < count; i += 1) {
        const prop = props.nth(i);
        const name = clean(
            await prop
                .locator(PROP_TITLE_SELECTOR)
                .first()
                .textContent({ timeout: 2_000 })
                .catch(() => ''),
        );
        const desc = prop.locator(PROP_DESC_SELECTOR).first();
        // The `title` attribute carries the full, untruncated value; fall back to text.
        const value = clean(
            (await desc.getAttribute('title').catch(() => null)) ??
                (await desc.textContent({ timeout: 2_000 }).catch(() => '')),
        );
        // De-dup by name (expanding can momentarily leave both truncated + full rows).
        if (name && value && !seen.has(name)) {
            seen.add(name);
            specs.push({ name, value });
        }
    }
    return specs;
}

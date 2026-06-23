// Product description extraction — the rich-text detail block from the AliExpress PDP.
//
// This mirrors `specifications.ts` deliberately: the description shares the same `comet-v2-anchor`
// tab bar and the same lazy-render + "View more" pattern. So the flow is identical — click the
// nav-bar "Description" tab, poll while nudging the section into view, expand "View more", then
// read the content.
//
// The one difference from specs: a spec row (`specification--prop`) only exists once populated, so
// specs can poll on element *count*. The description wrapper (`#product-description`) instead
// mounts early holding an empty `<div></div>` placeholder and streams its body in later — so we
// poll on content *length* rather than presence, otherwise we read the empty stub.
//
// Class names are content-hashed per build, so every selector matches on a stable prefix.
import type { Log } from 'apify';
import type { Page } from 'playwright';

import type { Description } from './types.js';

const SECTION_SELECTOR = '#nav-description, [class*="description--wrap"]';
const ANCHOR_SELECTOR = 'a.comet-v2-anchor-link[href="#nav-description"], a[href="#nav-description"]';
// Scoped to the description section: the Customer Reviews section (earlier on the page) has its
// own "View more" button, so a page-wide match would click the wrong one.
const VIEW_MORE_SELECTOR = '#nav-description [class*="extend--btn"], [class*="description--wrap"] [class*="extend--btn"]';
// The body container. AliExpress renders the description into a declarative **shadow root**
// (`<template shadowrootmode="open">`), so the real content lives in `host.shadowRoot`, invisible
// to a normal `document.querySelectorAll` / `innerHTML` / `textContent`. `detailmodule_html` /
// `detail-desc-decorate-richtext` are the inner content classes; `richTextContainer` /
// `product-description` cover the older light-DOM layouts.
const CONTENT_SELECTOR = [
    '[class*="detailmodule_html"]',
    '[class*="detail-desc-decorate-richtext"]',
    '[class*="richTextContainer"]',
    '#product-description',
    '[class*="description--product-description"]',
].join(', ');

/** Collapse whitespace and trim; treats null/undefined as empty. */
function clean(value: string | null | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** Raw description read out of the page (markup + visible text), before normalization. */
interface RawDescription {
    html: string;
    text: string;
}

/**
 * Read the description body from the main document, piercing any declarative shadow root.
 *
 * The content is mounted inside `host.shadowRoot` (declarative shadow DOM), which `querySelectorAll`
 * does not traverse — so we explicitly collect every shadow root under the description section and
 * search the light DOM *and* those shadow roots for the richest-markup content container.
 */
async function readBody(page: Page): Promise<RawDescription> {
    return page
        .evaluate((sel) => {
            const section = document.querySelector('#nav-description, [class*="description--wrap"]');
            // The body is in a declarative shadow root — which the browser may expose either as a
            // live `el.shadowRoot` (upgraded) or as a literal `<template shadowrootmode>` whose
            // content sits in `template.content` (not upgraded, e.g. set via innerHTML). Collect
            // both kinds of scope under the description section so we read it either way.
            const scopes: (Document | ShadowRoot | DocumentFragment)[] = [document];
            if (section) {
                for (const el of Array.from(section.querySelectorAll<HTMLElement>('*'))) {
                    if (el.shadowRoot) {
                        scopes.push(el.shadowRoot);
                    }
                }
                for (const tpl of Array.from(section.querySelectorAll('template'))) {
                    if ((tpl as HTMLTemplateElement).content) {
                        scopes.push((tpl as HTMLTemplateElement).content);
                    }
                }
            }

            let best = { html: '', text: '' };
            for (const scope of scopes) {
                for (const el of Array.from(scope.querySelectorAll(sel))) {
                    if (el.innerHTML.length > best.html.length) {
                        best = { html: el.innerHTML, text: el.textContent ?? '' };
                    }
                }
            }
            return best;
        }, CONTENT_SELECTOR)
        .catch(() => ({ html: '', text: '' }) as RawDescription);
}

/** The longest content `innerHTML` — our proxy for "is the body there yet?". */
async function descriptionContentLength(page: Page): Promise<number> {
    return readBody(page)
        .then((raw) => raw.html.trim().length)
        .catch(() => 0);
}

/**
 * Whether ANY content-host element exists yet (light DOM or shadow/template scopes), regardless of
 * whether it has streamed its body in. A real description mounts its host early (an empty `<div>`)
 * then streams content — so a *missing* host after we've revealed the section is a strong signal the
 * product simply has no description, letting us bail instead of polling the full wait budget.
 */
async function hasContentHost(page: Page): Promise<boolean> {
    return page
        .evaluate((sel) => {
            const section = document.querySelector('#nav-description, [class*="description--wrap"]');
            const scopes: (Document | ShadowRoot | DocumentFragment)[] = [document];
            if (section) {
                for (const el of Array.from(section.querySelectorAll<HTMLElement>('*'))) {
                    if (el.shadowRoot) {
                        scopes.push(el.shadowRoot);
                    }
                }
                for (const tpl of Array.from(section.querySelectorAll('template'))) {
                    if ((tpl as HTMLTemplateElement).content) {
                        scopes.push((tpl as HTMLTemplateElement).content);
                    }
                }
            }
            return scopes.some((scope) => scope.querySelector(sel) !== null);
        }, CONTENT_SELECTOR)
        .catch(() => false);
}

/**
 * Bring the description section into view and fully expand it. Mirror of `revealSpecifications`.
 */
async function revealDescription(page: Page, log: Log): Promise<void> {
    // 1. Click the nav-bar "Description" tab.
    const anchor = page.locator(ANCHOR_SELECTOR).first();
    if (await anchor.count().catch(() => 0)) {
        await anchor.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
        await anchor.click({ timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(800);
    }

    // 2. Poll for the lazy-rendered body, nudging the section into view each round (same as specs,
    //    but keyed on content length so the empty placeholder doesn't count as "ready").
    const section = page.locator(SECTION_SELECTOR).first();
    for (let attempt = 0; attempt < 6; attempt += 1) {
        if ((await descriptionContentLength(page)) > 60) {
            break;
        }
        await section.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
        await page.mouse.wheel(0, 400).catch(() => undefined);
        await page.waitForTimeout(600);
    }

    // 3. Expand the collapsed block. Only the "View more" state expands.
    const viewMore = page.locator(VIEW_MORE_SELECTOR).first();
    if (await viewMore.count().catch(() => 0)) {
        const label = (await viewMore.textContent().catch(() => ''))?.toLowerCase() ?? '';
        if (label.includes('view more')) {
            await viewMore.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
            await viewMore.click({ timeout: 5_000 }).catch(() => undefined);
            await page.waitForTimeout(500);
            log.debug('expanded description via "View more"');
        }
    }
}

/**
 * Wait for the description body to stream in, retrying until its content grows past the empty
 * placeholder. Mirror of `waitForProps`, but on content length instead of row count.
 */
async function waitForContent(page: Page): Promise<number> {
    let length = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        length = await descriptionContentLength(page);
        if (length > 60) {
            break;
        }
        // Early exit: if not even an empty content host has mounted by now, the body is never going
        // to stream in — this product has no description. Stop instead of burning the full budget.
        if (!(await hasContentHost(page))) {
            break;
        }
        await page.waitForTimeout(700);
    }
    return length;
}

/**
 * Extract the product description as HTML + plain text.
 *
 * Reveals + expands the section (mirroring specifications), waits for the body to stream in, then
 * reads it with {@link readBody}, which pierces the declarative shadow root the body is rendered
 * into (and also covers older light-DOM layouts). HTML-first: an image-only description has rich
 * HTML but empty plain text, which is a valid result.
 */
export async function extractDescription(page: Page, log: Log): Promise<Description> {
    await revealDescription(page, log);
    await waitForContent(page);

    const raw = await readBody(page);
    const plainText = clean(raw.text);

    if (raw.html.trim().length <= 60) {
        const sectionHtml = await page
            .locator(SECTION_SELECTOR)
            .first()
            .innerHTML()
            .catch(() => null);
        log.warning('no description content found — dumping section markup', {
            url: page.url(),
            sectionHtmlSnippet: sectionHtml?.slice(0, 1_500) ?? null,
        });
        return { html: '', plainText: '' };
    }

    // Strip inline <script> the seller markup carries (e.g. `window.adminAccountId=...`).
    const html = raw.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').trim();
    log.info('description content located', { htmlLength: html.length, plainTextLength: plainText.length });
    return { html, plainText };
}

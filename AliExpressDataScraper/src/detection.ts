// Anti-bot / page-state detection — the single source of truth for "what is this page?".
//
// AliExpress fights scrapers several ways at once: it redirects to Alibaba "punish" pages
// (URL carries `x5secdata` / `_____tmd_____`), overlays a reCAPTCHA modal or nocaptcha slider
// on an otherwise-normal `/item/` URL, occasionally shows a Cloudflare interstitial, and
// sometimes serves a 200-OK page that is simply empty. Each needs a different response, so we
// classify into one `PageStatus` and let the caller decide (rotate vs solve vs extract).
//
// The selectors and URL markers live here (not in `antibot.ts`) so detection and solving never
// drift apart.
import type { Page } from 'playwright';

/** Outcome of classifying a freshly-navigated page. */
export type PageStatus =
    | 'ok' // Real product content is present.
    | 'captcha' // reCAPTCHA / slider challenge is on the page.
    | 'punish' // Alibaba anti-bot "punish" redirect.
    | 'blocked' // Cloudflare / access-denied / generic block.
    | 'empty'; // 200 but no product content (soft block or render failure).

// Alibaba "punish" redirects expose these markers in the URL.
export const ANTIBOT_URL_MARKERS = ['/punish', '_____tmd_____', 'x5secdata'];

// reCAPTCHA v2 widget present on the page.
export const RECAPTCHA_SELECTORS = ['iframe[src*="recaptcha"]', '.g-recaptcha[data-sitekey]', '#g-recaptcha-response'];

// Alibaba's slider puzzle challenge. It ships under several skins — the legacy "nc" / nocaptcha
// widget and the newer "baxia" punish dialog — and the challenge iframe can come from x5sec OR a
// generic punish URL. We match all of them so a store-page challenge is recognized regardless of
// which variant Alibaba serves.
export const SLIDER_SELECTORS = [
    '.nc-container',
    '#nc_1_n1z',
    '.btn_slide',
    '.nc_wrapper',
    '#baxia-dialog-content',
    '.baxia-dialog',
    '[class*="baxia"]',
    'iframe[src*="x5sec"]',
    'iframe[src*="punish"]',
];

// Cloudflare interstitial / managed-challenge markers.
const CLOUDFLARE_SELECTORS = ['#cf-challenge-running', '#challenge-form', 'iframe[src*="challenges.cloudflare.com"]'];

// Candidate selectors for the product title, in priority order. AliExpress has shipped several
// PDP layouts, so we fall through older/newer markup before giving up. Exported because both
// detection (`isProductLoaded`) and extraction (`routes.ts`) key off the same list.
export const TITLE_SELECTORS = [
    'h1[data-pl="product-title"]',
    'h1.product-title-text',
    '.title--wrap--UUHae_g h1',
    'div[class*="title--wrap"] h1',
    'h1[class*="title"]',
];

/** Return true if any of the given selectors matches at least one element. */
async function anySelectorPresent(page: Page, selectors: string[]): Promise<boolean> {
    for (const selector of selectors) {
        const count = await page
            .locator(selector)
            .count()
            .catch(() => 0);
        if (count > 0) {
            return true;
        }
    }
    return false;
}

/** True when the current URL itself signals an Alibaba anti-bot ("punish") page. */
export function isPunishUrl(url: string): boolean {
    return ANTIBOT_URL_MARKERS.some((marker) => url.includes(marker));
}

/** True when the page is an Alibaba "punish" redirect (URL-based). */
export function isPunishPage(page: Page): boolean {
    return isPunishUrl(page.url());
}

/** True when a reCAPTCHA or slider challenge is present in the DOM. */
export async function isCaptchaPage(page: Page): Promise<boolean> {
    return (await anySelectorPresent(page, RECAPTCHA_SELECTORS)) || (await anySelectorPresent(page, SLIDER_SELECTORS));
}

/** True when the page is a Cloudflare challenge / generic access-denied block. */
export async function isBlockedPage(page: Page): Promise<boolean> {
    if (await anySelectorPresent(page, CLOUDFLARE_SELECTORS)) {
        return true;
    }
    const title = (await page.title().catch(() => '')).toLowerCase();
    return title.includes('access denied') || title.includes('attention required') || title.includes('just a moment');
}

/**
 * True when real product content has rendered.
 *
 * Two signals together so we do not accept a shell page: a known title selector is present
 * AND the body has a non-trivial amount of text (a blank/anti-bot page has almost none).
 */
export async function isProductLoaded(page: Page): Promise<boolean> {
    if (!(await anySelectorPresent(page, TITLE_SELECTORS))) {
        return false;
    }
    const bodyLen = await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => 0);
    return bodyLen > 200;
}

/**
 * Classify the current page into a single {@link PageStatus}.
 *
 * Priority is deliberate: punish (URL) → captcha (DOM) → blocked (Cloudflare) → product check.
 * Punish/captcha are checked first because AliExpress overlays them on `/item/` URLs, so a URL
 * that "looks like" a product page may still be a challenge.
 */
export async function classifyPage(page: Page): Promise<PageStatus> {
    if (isPunishPage(page)) {
        return 'punish';
    }
    if (await isCaptchaPage(page)) {
        return 'captcha';
    }
    if (await isBlockedPage(page)) {
        return 'blocked';
    }
    return (await isProductLoaded(page)) ? 'ok' : 'empty';
}

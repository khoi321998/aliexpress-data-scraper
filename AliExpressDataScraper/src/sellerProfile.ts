// The reusable "seller pipeline": given a store id and a warm page, scrape the seller's profile
// entirely from the DOM — no MTOP API, no token dance, no `sellerSeq`. Used by BOTH the dedicated
// `seller_only` crawler (`sellerPipeline.ts`) and the `product_and_seller` product flow
// (`routes.ts`), so the seller shape is identical regardless of how it was reached.
//
// Two store pages are read:
//   1. all-items  (`/store/<id>/pages/all-items.html`)  → product previews
//   2. feedback   (`/store/feedback-score/<id>.html`)   → credibility + review counts + reviews
//
// Captcha handling is best-effort and internal (detect → solve via 2captcha → reload, up to 2
// rounds). It never throws: `scrapeSellerData` returns `blocked: true` when a page couldn't be
// cleared, leaving the caller to decide whether to retry on a fresh browser.
import type { Log } from 'apify';
import { chromium } from 'playwright';
import type { Page } from 'playwright';

import type { ScraperConfig } from './config.js';
import { logEgressIp } from './ip.js';
import { detectBlock, trySolveCaptcha } from './sellerCaptcha.js';
import type { SellerFeedback } from './sellerFeedback.js';
import { collectSellerReviewsFromDom, extractSellerFeedback } from './sellerFeedback.js';
import { extractStoreAllItemsPreviews } from './sellerProducts.js';
import type { Seller, SellerProductPreview, SellerReviewSample } from './types.js';
import { storeAllItemsUrl, storeFeedbackUrl } from './url.js';

/**
 * Read the store name from a store-page header. The header is inline-styled (no stable class
 * names), so we key off the store link's `data-href` and skip the sibling links (reviews / follow /
 * contact) that share the `/store/` href fragment.
 */
export async function readStoreName(page: Page): Promise<string | null> {
    return page
        .evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[data-href*="/store/"]'));
            for (const a of anchors) {
                const text = (a.querySelector('span')?.textContent ?? a.textContent ?? '').replace(/\s+/g, ' ').trim();
                if (text && !/positive|review|follow|contact/i.test(text)) {
                    return text;
                }
            }
            return null;
        })
        .catch(() => null);
}

/** Map the DOM-scraped pieces into the shared {@link Seller} DTO (extra fields ride the index signature). */
export function buildSellerDto(
    storeId: string,
    storeName: string | null,
    feedback: SellerFeedback,
    sellerReviews: SellerReviewSample[],
    productPreviews: SellerProductPreview[],
): Seller {
    return {
        platformSellerId: storeId,
        name: storeName ?? feedback.storeName,
        url: `https://www.aliexpress.com/store/${storeId}`,
        positiveFeedbackPercent: feedback.positiveFeedbackPercent,
        feedbackScore: feedback.totalCount,
        countryName: feedback.countryName,
        openedSinceText: feedback.openedSinceText,
        reviewCounts: {
            positive: feedback.positiveCount,
            neutral: feedback.neutralCount,
            negative: feedback.negativeCount,
            total: feedback.totalCount,
        },
        scores: feedback.scores,
        productPreviews,
        sellerReviews,
    };
}

/**
 * Detect → solve → reload the captcha for whatever page is currently loaded, up to 2 rounds.
 * Best-effort: returns `true` if the page is STILL blocked afterwards (caller decides what to do),
 * `false` once the real content is showing. `label` names the page for the logs.
 */
async function passCaptcha(page: Page, config: ScraperConfig, log: Log, label: string): Promise<boolean> {
    for (let attempt = 1; attempt <= 2; attempt++) {
        await page.waitForLoadState('domcontentloaded').catch(() => {});

        // Detect the captcha ASAP — the punish script injects its dialog very early, so polling logs
        // it within ~1s instead of waiting on networkidle.
        let blockSignal: string | null = null;
        for (let i = 0; i < 16; i++) {
            blockSignal = await detectBlock(page);
            if (blockSignal) break;
            await page.waitForTimeout(500);
        }
        if (!blockSignal) {
            return false; // no captcha → ready to extract
        }

        log.warning(`🚧 Captcha / punish page detected on ${label} (attempt ${attempt}, signal: ${blockSignal})`);
        const solved = await trySolveCaptcha(page, page.url(), config.twoCaptchaApiKey, log);
        if (!solved) {
            return true; // couldn't solve — report still-blocked
        }

        // Reload so the SPA renders the real content with the validated cookies.
        log.info(`🔄 Reloading ${label} to load content after passing the captcha...`);
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    // After both rounds, report whether a captcha is still present.
    return Boolean(await detectBlock(page));
}

/**
 * Poll up to 30s for the SPA to render real content (avoid extracting off the loading spinner).
 * Returns `true` once the predicate matches, `false` if the 30s budget runs out — so it never hangs:
 * the worst case is a bounded 30s wait, after which the caller extracts whatever is in the DOM.
 */
async function waitForReady(page: Page, predicate: () => boolean): Promise<boolean> {
    for (let i = 0; i < 30; i++) {
        if (await page.evaluate(predicate).catch(() => false)) return true;
        await page.waitForTimeout(1_000);
    }
    return false;
}

/**
 * Scrape a seller's full DOM profile for `storeId` using the given warm page: product previews from
 * the all-items page, then credibility + review counts + per-star reviews from the feedback page.
 *
 * Returns the built {@link Seller} plus a `blocked` flag (true when either store page stayed behind
 * a captcha that couldn't be solved). Never throws — anti-bot recovery is the caller's call.
 */
export async function scrapeSellerData(
    page: Page,
    storeId: string,
    log: Log,
    config: ScraperConfig,
    opts: { alreadyOnAllItems?: boolean } = {},
): Promise<{ seller: Seller; blocked: boolean }> {
    // tsx/esbuild rewrites the DOM extractors' named inner functions to call a `__name` helper that
    // doesn't exist in the page context → "ReferenceError: __name is not defined". The dedicated
    // seller crawler shims it in a preNavigationHook, but the product crawler does not, so shim it
    // here: once on the current document (covers the already-loaded page) and via addInitScript (covers
    // every navigation this function triggers). The shim itself is a plain arrow, so it's safe to run
    // even before `__name` exists.
    const nameShim = () => {
        const w = window as unknown as { __name?: (fn: unknown) => unknown };
        w.__name = w.__name || ((fn: unknown) => fn);
    };
    await page.evaluate(nameShim).catch(() => {});
    await page.addInitScript(nameShim).catch(() => {});

    // Confirm the seller scrape is leaving via the REAL local/container IP (no proxy) — contrast this
    // line with the "egress IP (product)" line, which should show the residential proxy IP.
    await logEgressIp(page, log, 'seller');

    // --- Page 1: all-items grid → product previews ----------------------------------------------
    // In `seller_only` Crawlee has ALREADY navigated to the all-items page, so the caller passes
    // `alreadyOnAllItems: true` and we must NOT navigate again — a redundant second goto reloads the
    // page right as the punish dialog appears, resetting the captcha mid-solve (the refresh-on-open).
    // The product flow lands on a PDP, so it omits the flag and we navigate here.
    if (!opts.alreadyOnAllItems) {
        log.info(`➡️  Seller: opening all-items page for store ${storeId}`);
        await page.goto(storeAllItemsUrl(storeId), { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    let blocked = await passCaptcha(page, config, log, 'all-items');
    // Wait specifically for a PRODUCT CARD to render — NOT just the store header. The header
    // (followers text / store link) renders well before the product grid, so OR-ing it in here let us
    // break early and extract an empty grid (→ 0 previews). Anchoring solely on the product card means
    // we keep polling until the grid actually hydrates. Bounded to 30s by waitForReady, so a store that
    // genuinely renders no cards just waits out the budget and extracts 0 — it never hangs.
    const gridReady = await waitForReady(page, () => document.querySelector('a[ae_object_type="product"][href*="/item/"]') != null);
    if (!gridReady) {
        log.warning('all-items product grid did not render within 30s — previews may come back empty (page slow/blocked or store truly has no items)');
    }
    const storeName = await readStoreName(page);
    const productPreviews = await extractStoreAllItemsPreviews(page, log, 10);

    // --- Page 2: feedback page → credibility + review counts + reviews --------------------------
    log.info(`➡️  Seller: opening feedback page for store ${storeId}`);
    await page.goto(storeFeedbackUrl(storeId), { waitUntil: 'domcontentloaded' }).catch(() => {});
    blocked = (await passCaptcha(page, config, log, 'feedback')) || blocked;
    await waitForReady(page, () => /store credibility|customer reviews/i.test(document.body?.innerText ?? ''));
    const feedback = await extractSellerFeedback(page, log);
    const sellerReviews = await collectSellerReviewsFromDom(page, log, 5);

    const seller = buildSellerDto(storeId, storeName, feedback, sellerReviews, productPreviews);
    log.info('🏪 seller scraped', {
        storeId,
        name: seller.name,
        previews: productPreviews.length,
        reviews: sellerReviews.length,
        blocked,
    });
    return { seller, blocked };
}

/**
 * Scrape a seller in a FRESH, LOCAL browser — no proxy, no fingerprint spoofing — exactly like the
 * `seller_only` pipeline. Used by `product_and_seller`, where the product page runs behind the US
 * residential proxy + a spoofed fingerprint: the seller scrape must NOT inherit those (seller data is
 * read from the real local IP), so we launch a separate Chrome here instead of reusing the product page.
 *
 * The browser is closed when done. Best-effort: on launch failure it returns an empty (blocked) seller
 * so the product result is unaffected.
 */
export async function scrapeSellerLocal(
    storeId: string,
    log: Log,
    config: ScraperConfig,
): Promise<{ seller: Seller; blocked: boolean }> {
    log.info(`🧭 Seller: launching a local (no-proxy, no-fingerprint) browser for store ${storeId}`);
    const browser = await chromium.launch({
        channel: 'chrome', // real Chrome, matching the seller_only pipeline (useChrome)
        headless: config.headless,
        slowMo: config.headless ? 0 : 250,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage', '--start-maximized'],
        // No `proxy` option → egress on the real local IP.
    });
    try {
        const context = await browser.newContext();
        // Match the seller_only crawler's `navigationTimeoutSecs: 90` (Playwright defaults to 30s, too
        // short for a slow store page behind a punish).
        context.setDefaultNavigationTimeout(90_000);
        // Force English + USD via AliExpress's locale cookie (IP-independent), same as the seller crawler.
        const localeCookieValue = `site=glo&c_tp=${config.currency}&region=${config.proxyCountry}&b_locale=${config.language}&ae_u_p_s=2`;
        await context.addCookies([
            { name: 'aep_usuc_f', value: localeCookieValue, domain: '.aliexpress.com', path: '/' },
            { name: 'intl_locale', value: config.language, domain: '.aliexpress.com', path: '/' },
        ]);
        const page = await context.newPage();
        return await scrapeSellerData(page, storeId, log, config, { alreadyOnAllItems: false });
    } finally {
        await browser.close().catch(() => {});
    }
}

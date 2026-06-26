// The reusable "seller pipeline": given a store path id and a warm page, scrape the seller's profile
// entirely from AliExpress's own APIs — NO DOM scraping. Used by BOTH the dedicated `seller_only`
// crawler (`sellerPipeline.ts`) and the `product_and_seller` product flow (`routes.ts`), so the
// seller shape is identical regardless of how it was reached.
//
// Flow (one lightweight navigation, then pure API):
//   1. navigate the store's all-items page once — this warms the anti-bot cookies (baxia/x5sec) the
//      signed API calls need AND makes the store SPA fire `renderPageData.htm`, which carries the
//      REAL `sellerId` (intercepted; request.get fallback). Captcha here is SOLVED via 2captcha
//      (see `sellerCaptcha.ts`), never rotated — the seller pipeline runs on a real local IP.
//   2. with the sellerId: `mtop.ae.shop.seller.page.info` (credibility/counts/base info),
//      `evaluation.productEvaluation` (store reviews), `productList` (paginated catalog) — all via
//      the page request context, reusing the warm session.
//
// Never throws: returns `blocked: true` when the page stayed behind a captcha or no sellerId could be
// resolved, leaving the caller to decide whether to retry on a fresh browser.
import type { Log } from 'apify';
import type { Page } from 'playwright';
import { chromium } from 'playwright';

import type { ScraperConfig } from './config.js';
import { logEgressIp } from './ip.js';
import type { SellerInfo } from './sellerApi.js';
import { armSellerIdInterceptor, fetchSellerInfo, resolveSellerId } from './sellerApi.js';
import { detectBlock, trySolveCaptcha } from './sellerCaptcha.js';
import { fetchSellerProducts } from './sellerProductsApi.js';
import { fetchSellerReviews } from './sellerReviewsApi.js';
import type { Seller, SellerProductPreview, SellerReviewSample } from './types.js';
import { storeAllItemsUrl } from './url.js';

/** Map the API-fetched pieces into the shared {@link Seller} DTO (extra fields ride the index signature). */
export function buildSellerDto(
    pathId: string,
    sellerId: string | null,
    info: SellerInfo | null,
    sellerReviews: SellerReviewSample[],
    productPreviews: SellerProductPreview[],
): Seller {
    return {
        platformSellerId: sellerId ?? pathId,
        name: info?.storeName ?? null,
        url: `https://www.aliexpress.com/store/${pathId}`,
        countryName: info?.countryName ?? null,
        followersText: info?.followersText ?? null,
        storeLogo: info?.storeLogo ?? null,
        positiveFeedbackPercent: info?.positiveFeedbackPercent ?? null,
        feedbackScore: info?.totalCount ?? null,
        openedSinceText: info?.openedSinceText ?? null,
        reviewCounts: {
            positive: info?.positiveCount ?? null,
            neutral: info?.neutralCount ?? null,
            negative: info?.negativeCount ?? null,
            total: info?.totalCount ?? null,
        },
        scores: info?.scores ?? [],
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
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);

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

        // Reload so the SPA renders the real content (and re-fires renderPageData) with the validated cookies.
        log.info(`🔄 Reloading ${label} to load content after passing the captcha...`);
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    }
    // After both rounds, report whether a captcha is still present.
    return Boolean(await detectBlock(page));
}

/**
 * Scrape a seller's full profile for the store `pathId` (the `/store/<id>` number) using the given
 * warm page, entirely via AliExpress APIs. Resolves the real sellerId from renderPageData, then pulls
 * profile + reviews + product catalog.
 *
 * Returns the built {@link Seller} plus a `blocked` flag (true when the page stayed behind a captcha
 * or no sellerId could be resolved). Never throws — anti-bot recovery is the caller's call.
 */
export async function scrapeSellerData(
    page: Page,
    pathId: string,
    log: Log,
    config: ScraperConfig,
    opts: { alreadyOnAllItems?: boolean; knownSellerId?: string | null } = {},
): Promise<{ seller: Seller; blocked: boolean }> {
    // tsx/esbuild rewrites named functions to call a `__name` helper that doesn't exist in the page
    // context → "ReferenceError: __name is not defined" inside page.evaluate (used by logEgressIp /
    // detectBlock). The seller_only crawler shims it in a preNavigationHook, but scrapeSellerLocal
    // launches a raw browser with no such hook, so shim it here: once on the current document and via
    // addInitScript for every navigation this function triggers.
    const nameShim = () => {
        const w = window as unknown as { __name?: (fn: unknown) => unknown };
        // eslint-disable-next-line no-underscore-dangle -- shimming esbuild's __name helper
        w.__name = w.__name || ((fn: unknown) => fn);
    };
    await page.addInitScript(nameShim).catch(() => undefined);
    await page.evaluate(nameShim).catch(() => undefined);

    // Confirm the seller scrape is leaving via the REAL local/container IP (no proxy).
    await logEgressIp(page, log, 'seller');

    // Arm the renderPageData interceptor (idempotent). For `seller_only` the dedicated crawler arms it
    // in a preNavigationHook (before Crawlee's goto); here we arm before our own goto below.
    armSellerIdInterceptor(page);

    // ONE navigation: the all-items page warms the anti-bot cookies the APIs need and fires
    // renderPageData (→ sellerId). In `seller_only` Crawlee already navigated, so we must NOT navigate
    // again (a second goto would reload mid-captcha). The product flow lands on a PDP, so it navigates.
    if (!opts.alreadyOnAllItems) {
        log.info(`➡️  Seller: opening all-items page for store ${pathId}`);
        await page.goto(storeAllItemsUrl(pathId), { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    }
    const blocked = await passCaptcha(page, config, log, 'all-items');

    // Resolve the REAL sellerId: from the PDP (product flow) if known, else from renderPageData.
    const resolved = opts.knownSellerId ? { sellerId: opts.knownSellerId, shopId: pathId, storeName: null } : await resolveSellerId(page, pathId, log);
    if (!resolved) {
        log.warning('Seller: could not resolve sellerId (likely still blocked) — returning empty seller.');
        return { seller: buildSellerDto(pathId, null, null, [], []), blocked: true };
    }
    const { sellerId } = resolved;

    const apiOpts = { language: config.language, currency: config.currency, country: config.proxyCountry };
    // Profile + reviews (acs.com MTOP) and products (shoprenderview) run concurrently — independent calls.
    const [info, sellerReviews, productPreviews] = await Promise.all([
        fetchSellerInfo(page, sellerId, log, apiOpts),
        fetchSellerReviews(page, sellerId, log, apiOpts, 25),
        fetchSellerProducts(page, sellerId, pathId, log, apiOpts, 10, 10),
    ]);

    const seller = buildSellerDto(pathId, sellerId, info, sellerReviews, productPreviews);
    log.info('🏪 seller scraped (API)', {
        pathId,
        sellerId,
        name: seller.name,
        previews: productPreviews.length,
        reviews: sellerReviews.length,
        positiveFeedbackPercent: info?.positiveFeedbackPercent ?? null,
        blocked,
    });
    return { seller, blocked };
}

/**
 * Fetch the seller profile INLINE on an already-warm page (the product page) using a known sellerId
 * (the PDP's `adminSeq`) — NO navigation, NO captcha, NO separate browser. All three endpoints are
 * pure request.get on the warm session (profile + reviews on `acs.aliexpress.com`; products via
 * ModuleAsyncService, which — unlike shoprenderview — needs no store navigation). Used by
 * `product_and_seller` as the fast path; the caller falls back to {@link scrapeSellerLocal} when this
 * returns `blocked` (e.g. the product's proxy IP is punished on the seller gateway).
 */
export async function scrapeSellerInline(
    page: Page,
    pathId: string,
    sellerId: string,
    log: Log,
    config: ScraperConfig,
): Promise<{ seller: Seller; blocked: boolean }> {
    const apiOpts = { language: config.language, currency: config.currency, country: config.proxyCountry };
    const [info, sellerReviews, productPreviews] = await Promise.all([
        fetchSellerInfo(page, sellerId, log, apiOpts),
        fetchSellerReviews(page, sellerId, log, apiOpts, 25),
        fetchSellerProducts(page, sellerId, pathId, log, apiOpts, 10, 10),
    ]);
    // If everything came back empty, treat as blocked so the caller can fall back to a local browser.
    const blocked = !info && sellerReviews.length === 0 && productPreviews.length === 0;
    const seller = buildSellerDto(pathId, sellerId, info, sellerReviews, productPreviews);
    log.info('🏪 seller scraped (inline API)', {
        pathId,
        sellerId,
        name: seller.name,
        previews: productPreviews.length,
        reviews: sellerReviews.length,
        positiveFeedbackPercent: info?.positiveFeedbackPercent ?? null,
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
 * `knownSellerId` (the PDP's `adminSeq`) lets us skip renderPageData resolution when the product flow
 * already has it. The browser is closed when done. Best-effort: on launch failure it returns an empty
 * (blocked) seller so the product result is unaffected.
 */
export async function scrapeSellerLocal(
    pathId: string,
    log: Log,
    config: ScraperConfig,
    knownSellerId: string | null = null,
): Promise<{ seller: Seller; blocked: boolean }> {
    log.info(`🧭 Seller: launching a local (no-proxy, no-fingerprint) browser for store ${pathId}`);
    const browser = await chromium.launch({
        channel: 'chrome', // real Chrome, matching the seller_only pipeline (useChrome)
        headless: config.headless,
        slowMo: config.headless ? 0 : 250,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage', '--start-maximized'],
        // No `proxy` option → egress on the real local IP.
    });
    try {
        const context = await browser.newContext();
        // Match the seller_only crawler's `navigationTimeoutSecs: 90` (Playwright defaults to 30s, too short).
        context.setDefaultNavigationTimeout(90_000);
        // Force English + USD via AliExpress's locale cookie (IP-independent), same as the seller crawler.
        const localeCookieValue = `site=glo&c_tp=${config.currency}&region=${config.proxyCountry}&b_locale=${config.language}&ae_u_p_s=2`;
        await context.addCookies([
            { name: 'aep_usuc_f', value: localeCookieValue, domain: '.aliexpress.com', path: '/' },
            { name: 'intl_locale', value: config.language, domain: '.aliexpress.com', path: '/' },
        ]);
        const page = await context.newPage();
        return await scrapeSellerData(page, pathId, log, config, { alreadyOnAllItems: false, knownSellerId });
    } finally {
        await browser.close().catch(() => undefined);
    }
}

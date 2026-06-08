// Independent browser pipeline for the `seller_only` mode.
//
// This is a deliberately DIFFERENT strategy from the product crawler in `main.ts`:
//   - NO fingerprint spoofing (`useFingerprints: false`) and NO proxy — it runs on the real
//     local/container IP, so AliExpress sees a genuine (if datacenter) browser.
//   - When AliExpress serves a punish / reCAPTCHA page it SOLVES it via 2captcha (see
//     `sellerCaptcha.ts`) and reloads, rather than rotating to a fresh session.
//
// The actual scraping (all-items previews + feedback credibility/reviews) lives in the shared
// `scrapeSellerData` (`sellerProfile.ts`), reused by the `product_and_seller` flow. This file just
// drives the dedicated crawler and emits the main `ProductSellerResponse` DTO with `product: null`.
import { PlaywrightCrawler, createPlaywrightRouter } from '@crawlee/playwright';
import { Actor, log } from 'apify';

import type { ScraperConfig, ScraperInput } from './config.js';
import { createSellerOnlyResponse } from './response.js';
import { scrapeSellerData } from './sellerProfile.js';
import { normalizeAliExpressStoreUrl } from './url.js';

/** Build the router for the seller pipeline: scrape the seller DOM and push the main DTO. */
function createSellerRouter(config: ScraperConfig) {
    const router = createPlaywrightRouter();

    router.addDefaultHandler(async ({ page, request, log: reqLog, crawler }) => {
        const { storeId } = request.userData as { storeId: string };
        reqLog.info(`🌐 seller_only: scraping store ${storeId}`);

        // Crawlee already navigated to the all-items page for this request — don't re-navigate (that
        // would refresh the page mid-captcha). The feedback page is navigated inside scrapeSellerData.
        const { seller, blocked } = await scrapeSellerData(page, storeId, reqLog, config, { alreadyOnAllItems: true });

        // If a captcha stayed up and we got nothing, retire the browser (the punish state is bound to
        // it) and throw so Crawlee retries this store on a brand-new browser.
        const empty = !seller.productPreviews?.length && seller.positiveFeedbackPercent == null && !seller.sellerReviews?.length;
        if (blocked && empty) {
            try {
                crawler.browserPool?.retireBrowserByPage(page);
            } catch {
                // Best-effort: a thrown error below still triggers the retry even if the browser is gone.
            }
            throw new Error(`Store ${storeId} stayed behind a captcha — retrying with a fresh browser.`);
        }

        // Emit the main DTO with no product (this mode never visits a product page).
        const response = createSellerOnlyResponse(`https://www.aliexpress.com/store/${storeId}`, storeId);
        response.seller = seller;
        if (response.sellerRef) {
            response.sellerRef.name = seller.name;
        }
        await Actor.pushData(response);
    });

    return router;
}

/**
 * Run the independent `seller_only` pipeline: one dedicated, fingerprint-free, proxy-free
 * PlaywrightCrawler over the store URLs from {@link ScraperInput.startUrls}.
 */
export async function runSellerOnly(input: ScraperInput, config: ScraperConfig): Promise<void> {
    // Start URLs are STORE pages. Parse + canonicalize the store id, de-duplicate, and navigate
    // straight to the store's all-items listing page (`/store/<id>/pages/all-items.html`), which the
    // pipeline scrapes directly for the seller's full product grid.
    const seen = new Set<string>();
    const requests = (input.startUrls ?? []).flatMap(({ url }) => {
        const store = normalizeAliExpressStoreUrl(url);
        if (!store) {
            log.warning(`Skipping non-store AliExpress URL (mode=seller_only): ${url}`);
            return [];
        }
        if (seen.has(store.id)) return [];
        seen.add(store.id);
        return [{ url: store.allItemsUrl, userData: { storeId: store.id } }];
    });

    if (!requests.length) {
        throw new Error('No valid AliExpress store URLs found in "startUrls" for mode "seller_only".');
    }

    if (!config.twoCaptchaApiKey) {
        log.warning('No 2captcha API key configured (input.twoCaptchaApiKey / TWOCAPTCHA_API_KEY). Captcha pages cannot be solved.');
    }

    // AliExpress decides language/currency from the `aep_usuc_f` cookie, not the IP. Forcing it
    // keeps the store page in English + USD so the header text/selectors match.
    const localeCookieValue = `site=glo&c_tp=${config.currency}&region=${config.proxyCountry}&b_locale=${config.language}&ae_u_p_s=2`;

    const crawler = new PlaywrightCrawler({
        requestHandler: createSellerRouter(config),

        // One store at a time so the visible window is easy to follow and the IP stays cool.
        maxConcurrency: 1,
        maxRequestsPerCrawl: config.maxRequestsPerCrawl,
        maxRequestRetries: config.maxRequestRetries,

        navigationTimeoutSecs: 90,
        // Solving a captcha via 2captcha can take 1-3 minutes, so the handler must run far longer
        // than the default.
        requestHandlerTimeoutSecs: 360,

        // NO proxy and NO fingerprint spoofing — this pipeline uses the real local IP on purpose.
        browserPoolOptions: {
            useFingerprints: false,
        },
        launchContext: {
            useChrome: true,
            launchOptions: {
                headless: config.headless,
                // slowMo makes the headful browser easier to watch; harmless when headless.
                slowMo: config.headless ? 0 : 250,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-dev-shm-usage',
                    '--start-maximized',
                ],
            },
        },

        preNavigationHooks: [
            async ({ page }) => {
                // Force English + USD via AliExpress's locale cookie (IP-independent).
                await page.context().addCookies([
                    { name: 'aep_usuc_f', value: localeCookieValue, domain: '.aliexpress.com', path: '/' },
                    { name: 'intl_locale', value: config.language, domain: '.aliexpress.com', path: '/' },
                ]);

                // tsx/esbuild wraps named functions with a `__name` helper that does NOT exist
                // inside page.evaluate's browser context, causing "ReferenceError: __name is not
                // defined". Shim it on every document so the DOM extractors' closures run cleanly.
                await page.addInitScript(() => {
                    const w = window as unknown as { __name?: (fn: unknown) => unknown };
                    w.__name = w.__name || ((fn: unknown) => fn);
                });
            },
        ],
    });

    await crawler.run(requests);
    log.info(`seller_only finished. Stores processed: ${requests.length}.`);
}

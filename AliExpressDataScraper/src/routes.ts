import type { PlaywrightCrawlingContext } from '@crawlee/playwright';
import { createPlaywrightRouter } from '@crawlee/playwright';
import type { Log } from 'apify';

import type { ScraperConfig } from './config.js';
import { classifyPage } from './detection.js';
import { collectReviewsViaRequest, fetchDescription, fetchPdpDirect, parsePdpResult, waitForPdpResult } from './productApi.js';
import { createAliExpressResponse } from './response.js';
import { scrapeSellerLocal } from './sellerProfile.js';
import type { Seller } from './types.js';
import { normalizeAliExpressStoreUrl } from './url.js';

/**
 * Per-run tally of how many times we rotated the session because of an anti-bot block, keyed by
 * reason (`captcha`, `punish`, `blocked`, `empty-product`, ...). Each entry counts one actual
 * block-and-retry event — unlike Crawlee's `requestsRetries`, which only counts +1 per request no
 * matter how many times it was retried. Read this after `crawler.run()` for the true captcha tally.
 */
export const rotationStats: Record<string, number> = {};

/**
 * Retire the current session and throw so Crawlee retries the request on a fresh session
 * (which, with the session pool + residential proxy, means a new sticky IP and a new
 * fingerprint). This is the core of the rotate-first anti-bot strategy.
 */
function rotateAndRetry(
    { session, request, log }: Pick<PlaywrightCrawlingContext, 'session' | 'request' | 'log'>,
    reason: string,
): never {
    rotationStats[reason] = (rotationStats[reason] ?? 0) + 1;
    log.warning(`Block detected — rotating session and retrying.`, {
        reason,
        url: request.url,
        sessionId: session?.id,
        retryCount: request.retryCount,
    });
    session?.retire();
    throw new Error(`Anti-bot block (${reason}); rotating to a fresh session/proxy.`);
}

/** Resolve a store id from a {@link SellerRef}: prefer the `/store/<id>` in the URL, else the seller seq. */
function storeIdFromRef(url: string | null, platformSellerId: string | null): string | null {
    const fromUrl = url ? normalizeAliExpressStoreUrl(url)?.id : null;
    return fromUrl ?? platformSellerId ?? null;
}

/**
 * Kick off the (slow, captcha-bound) seller scrape for a product's seller, running it CONCURRENTLY
 * with the rest of product extraction. The scrape uses its own local browser, so it doesn't contend
 * with the product page. Returns the in-flight promise (awaited just before pushData), or `null`
 * when there's no seller, the run is `product_only`, or no store id could be resolved.
 *
 * Caches the PROMISE (not the result) keyed by store id, so concurrent products of the same store
 * share a single scrape instead of each launching their own browser + captcha solve.
 */
function kickoffSellerScrape(
    response: ReturnType<typeof createAliExpressResponse>,
    config: ScraperConfig,
    log: Log,
    sellerCache: Map<string, Promise<Seller | null>>,
): Promise<Seller | null> | null {
    if (!response.sellerRef || config.mode !== 'product_and_seller') {
        return null;
    }
    log.info('seller extracted', {
        name: response.sellerRef.name,
        platformSellerId: response.sellerRef.platformSellerId,
    });
    const storeId = storeIdFromRef(response.sellerRef.url, response.sellerRef.platformSellerId);
    if (!storeId) {
        return null;
    }
    const cached = sellerCache.get(storeId);
    if (cached) {
        return cached;
    }
    log.info(`🚀 Triggering seller scrape for store ${storeId} now (runs while we finish the product)…`);
    const sellerPromise = scrapeSellerLocal(storeId, log, config)
        .then((r) => r.seller)
        .catch((error) => {
            log.warning('Seller DOM scrape failed — skipping seller (product unaffected).', {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        });
    sellerCache.set(storeId, sellerPromise);
    return sellerPromise;
}

/**
 * Build the Playwright router: the product handler extracts everything from the `pdp.pc.query` MTOP
 * JSON (see {@link fetchPdpDirect}) plus the reviews API and description endpoint — no page DOM is
 * scraped. The page is navigated only to bootstrap the anti-bot cookies the signed API call needs.
 *
 * A factory (rather than a module-level singleton) so the handler can read the resolved
 * {@link ScraperConfig} — capture mode, proxy country — without reaching for globals.
 */
export function createRouter(config: ScraperConfig) {
    const router = createPlaywrightRouter();

    // In-flight / resolved seller scrapes this run, keyed by store id, so concurrent products of the
    // same store share a single scrape.
    const sellerCache = new Map<string, Promise<Seller | null>>();

    router.addDefaultHandler(async (ctx) => {
        const { request, page, log, pushData } = ctx;

        // Hard block on arrival → rotate immediately.
        const arrival = await classifyPage(page);
        if (arrival === 'captcha' || arrival === 'punish' || arrival === 'blocked') {
            rotateAndRetry(ctx, arrival);
        }

        const response = createAliExpressResponse(request.url);
        response.captureMode = config.mode;

        // Fire the signed pdp.pc.query ourselves (no bundle wait). Fall back to the page's own
        // intercepted response if the direct call returns nothing. A block means neither yields JSON
        // → rotate cheaply (each attempt is seconds, not a full render).
        let result = await fetchPdpDirect(page, response.product.id, log);
        if (!result) {
            result = await waitForPdpResult(page, 8_000);
        }
        if (!result) {
            const status = await classifyPage(page);
            rotateAndRetry(ctx, status === 'ok' ? 'pdp-timeout' : status);
        }

        log.info('product handler pass', { requestId: request.id, retryCount: request.retryCount, pageUrl: page.url() });

        const parsed = parsePdpResult(result as Record<string, unknown>);
        if (!parsed.title) {
            log.warning('pdp.pc.query JSON had no title — rotating.', { url: page.url() });
            rotateAndRetry(ctx, 'empty-product');
        }

        response.product.title = parsed.title as string;
        response.product.pricing = parsed.pricing;
        response.product.media = parsed.media;
        response.product.specifications = parsed.specifications;
        response.product.stock = parsed.stock;
        response.product.shipping = parsed.shipping;
        response.sellerRef = parsed.sellerRef;
        log.info('product parsed', {
            images: parsed.media.images.length,
            videos: parsed.media.videos.length,
            specs: parsed.specifications.length,
            currency: parsed.pricing.currency,
            priceMin: parsed.pricing.priceMin,
            priceMax: parsed.pricing.priceMax,
            availableQuantity: parsed.stock.availableQuantity,
            deliveryTimeText: parsed.shipping.deliveryTimeText,
        });

        // Seller scrape runs concurrently (uses sellerRef from the JSON). product_only skips it.
        const sellerPromise = kickoffSellerScrape(response, config, log, sellerCache);

        // Description — fetched from the URL embedded in the JSON, then cleaned.
        response.product.description = await fetchDescription(page, parsed.descUrl, log);
        log.info('description extracted', {
            htmlLength: response.product.description.html.length,
            plainTextLength: response.product.description.plainText.length,
        });

        // Reviews — `mtop.aliexpress.review.pc.list`: overall rating, per-star breakdown, samples.
        // Fired in PARALLEL via the request context (the `_m_h5_tk` token is already warm from the
        // pdp.pc.query call). Leaves the empty default if the API yields nothing.
        const sellerSeq = response.sellerRef?.platformSellerId ?? null;
        const apiReviews = response.product.id ? await collectReviewsViaRequest(page, response.product.id, sellerSeq, log, 5) : null;
        if (apiReviews) {
            response.product.reviewsSummary = apiReviews;
        }
        // Reviews API can be empty on some products; fall back to the rating from PC_RATING.
        if (response.product.reviewsSummary.rating == null && parsed.ratingFallback.rating != null) {
            response.product.reviewsSummary.rating = parsed.ratingFallback.rating;
            response.product.reviewsSummary.reviewCount = parsed.ratingFallback.reviewCount;
        }
        log.info('reviews extracted', {
            rating: response.product.reviewsSummary.rating,
            reviewCount: response.product.reviewsSummary.reviewCount,
            samples: response.product.reviewsSummary.reviewSamples.length,
        });

        // Await the seller scrape kicked off earlier; by now it has overlapped extraction + reviews,
        // so it usually resolves immediately. null = scrape failed/skipped.
        if (sellerPromise) {
            const seller = await sellerPromise;
            if (seller) {
                response.seller = seller;
            }
        }

        await pushData(response);
        log.info('extracted successfully', { requestId: request.id, retryCount: request.retryCount });
    });

    return router;
}

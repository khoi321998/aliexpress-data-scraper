// Shared single-product extraction — the one code path used by BOTH the batch crawler
// (`routes.ts` default handler) and the standby warm-pool server (`standbyServer.ts`).
//
// Everything here works on a plain Playwright `Page` via the page's request context
// (`page.request`) — no Crawlee request-handler state. A warm page that has already bootstrapped
// the anti-bot cookies + `_m_h5_tk` token can run this repeatedly for many products with NO
// re-navigation (the standby path); the batch path navigates per product first, then calls in here.
//
// Unlike the old inline handler, this NEVER throws to rotate the session: it RETURNS
// `{ blocked: true, blockReason }` at each block point and lets the caller decide how to rotate
// (Crawlee `session.retire()` for batch; warm-context recycle for standby).
import type { Log } from 'apify';
import type { Page } from 'playwright';

import type { ScraperConfig } from './config.js';
import { collectReviewsViaRequest, fetchDescription, fetchPdpDirect, parsePdpResult, waitForPdpResult } from './productApi.js';
import { createAliExpressResponse } from './response.js';
import { scrapeSellerInline, scrapeSellerLocal } from './sellerProfile.js';
import type { Seller } from './types.js';
import { normalizeAliExpressStoreUrl } from './url.js';

/** How the seller profile is enriched. */
export type SellerStrategy =
    | 'inline-only' // standby: inline API on the warm page only; on block → seller=null (low latency).
    | 'inline-then-local'; // batch: inline first, fall back to a local (no-proxy) browser + 2captcha.

/** Options that differ between the batch and standby callers. */
export interface ExtractOptions {
    sellerStrategy: SellerStrategy;
    /**
     * Whether to fall back to the page's intercepted pdp.pc.query response when the direct call
     * yields nothing. Only useful when the page actually navigated to the PDP (batch). In standby
     * the page sits on the home page (never the PDP), so the interceptor can't help — skipping the
     * fallback avoids an 8s wait before we rotate.
     */
    interceptorFallback: boolean;
}

/** Outcome of one extraction pass. */
export interface ExtractResult {
    response: ReturnType<typeof createAliExpressResponse>;
    /** True ⇒ the page was blocked; caller should rotate and retry on a fresh identity. */
    blocked: boolean;
    blockReason?: string;
}

/** Resolve a store id from a {@link SellerRef}: prefer the `/store/<id>` in the URL, else the seller seq. */
function storeIdFromRef(url: string | null, platformSellerId: string | null): string | null {
    const fromUrl = url ? normalizeAliExpressStoreUrl(url)?.id : null;
    return fromUrl ?? platformSellerId ?? null;
}

/**
 * Kick off the seller scrape for a product's seller, running it CONCURRENTLY with the rest of product
 * extraction. Returns the in-flight promise (awaited just before the result is returned), or `null`
 * when there's no seller, the run is `product_only`, or no store id could be resolved.
 *
 * Fast path: when the PDP gave us the real sellerId (`adminSeq`), fetch the seller INLINE on the
 * product page via APIs — no separate browser, no navigation, no captcha. If that comes back blocked
 * and the strategy allows it, fall back to a dedicated local (no-proxy) browser that solves the
 * captcha. `inline-only` (standby) NEVER takes that slow fallback — it returns null instead, keeping
 * single-call latency low. Caches the PROMISE (not the result) keyed by store id.
 */
function kickoffSellerScrape(
    page: Page,
    response: ReturnType<typeof createAliExpressResponse>,
    config: ScraperConfig,
    log: Log,
    sellerCache: Map<string, Promise<Seller | null>>,
    sellerStrategy: SellerStrategy,
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
    // The PDP's `adminSeq` (sellerRef.platformSellerId) IS the real sellerId the seller APIs need.
    const knownSellerId = response.sellerRef.platformSellerId;
    log.info(`🚀 Triggering seller scrape for store ${storeId} now (runs while we finish the product)…`);
    const sellerPromise = (async (): Promise<Seller | null> => {
        // Fast path: inline on the product page when we already have the sellerId.
        if (knownSellerId) {
            const inline = await scrapeSellerInline(page, storeId, knownSellerId, log, config).catch((error) => {
                log.warning('Inline seller fetch threw — treating as blocked.', {
                    error: error instanceof Error ? error.message : String(error),
                });
                return null;
            });
            if (inline && !inline.blocked) {
                return inline.seller;
            }
            // Standby: never pay the slow local-browser + 2captcha fallback — keep latency low.
            if (sellerStrategy === 'inline-only') {
                log.info('Inline seller fetch blocked/empty — skipping (inline-only strategy).');
                return null;
            }
            log.info('Inline seller fetch blocked/empty — falling back to a local (no-proxy) browser.');
        }
        // Fallback (batch only): dedicated local browser (resolves sellerId via renderPageData + solves captcha).
        const local = await scrapeSellerLocal(storeId, log, config, knownSellerId).catch((error) => {
            log.warning('Seller scrape failed — skipping seller (product unaffected).', {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        });
        return local ? local.seller : null;
    })();
    sellerCache.set(storeId, sellerPromise);
    return sellerPromise;
}

/**
 * Extract one product (title, pricing, media, specs, stock, shipping, description, reviews) plus —
 * in `product_and_seller` mode — the seller profile, all from AliExpress's signed APIs via the
 * given page's request context. The page must already be on (batch) or warm for (standby) the
 * target product. Never throws on a block: returns `{ blocked: true }` for the caller to rotate.
 */
export async function extractProduct(
    page: Page,
    url: string,
    config: ScraperConfig,
    log: Log,
    sellerCache: Map<string, Promise<Seller | null>>,
    opts: ExtractOptions,
): Promise<ExtractResult> {
    const response = createAliExpressResponse(url);
    response.captureMode = config.mode;

    // Fire the signed pdp.pc.query ourselves (no bundle wait). Optionally fall back to the page's own
    // intercepted response (batch only). A block means neither yields JSON → rotate cheaply.
    let result = await fetchPdpDirect(page, response.product.id, log);
    if (!result && opts.interceptorFallback) {
        result = await waitForPdpResult(page, 8_000);
    }
    if (!result) {
        return { response, blocked: true, blockReason: 'pdp-blocked' };
    }

    const parsed = parsePdpResult(result as Record<string, unknown>);
    if (!parsed.title) {
        log.warning('pdp.pc.query JSON had no title — treating as blocked.', { url: page.url() });
        return { response, blocked: true, blockReason: 'empty-product' };
    }

    response.product.title = parsed.title;
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
    const sellerPromise = kickoffSellerScrape(page, response, config, log, sellerCache, opts.sellerStrategy);

    // Description — fetched from the URL embedded in the JSON, then cleaned.
    response.product.description = await fetchDescription(page, parsed.descUrl, log);
    log.info('description extracted', {
        htmlLength: response.product.description.html.length,
        plainTextLength: response.product.description.plainText.length,
    });

    // Reviews — fired in PARALLEL via the request context (token already warm from pdp.pc.query).
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

    // Await the seller scrape kicked off earlier; by now it has overlapped extraction + reviews.
    if (sellerPromise) {
        const seller = await sellerPromise;
        if (seller) {
            response.seller = seller;
        }
    }

    return { response, blocked: false };
}

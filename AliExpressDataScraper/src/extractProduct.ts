// Single-product extraction — the code path behind the batch crawler's default handler
// (`routes.ts`).
//
// Everything here works on a plain Playwright `Page` via the page's request context
// (`page.request`) — no Crawlee request-handler state. The caller navigates to the product first
// (to bootstrap the anti-bot cookies + `_m_h5_tk` token), then calls in here; all data comes from
// AliExpress's signed APIs, never from the page DOM.
//
// This NEVER throws to rotate the session: it RETURNS `{ blocked: true, blockReason }` at each
// block point and lets the caller decide how to rotate (Crawlee `session.retire()`).
import type { Log } from 'apify';
import type { Page } from 'playwright';

import type { ScraperConfig } from './config.js';
import { storefrontForRequest } from './config.js';
import { collectReviewsViaRequest, fetchDescription, fetchPdpDirect, parsePdpResult, pdpUnavailability, waitForPdpResult } from './productApi.js';
import { createAliExpressResponse } from './response.js';
import { scrapeSellerInline, scrapeSellerLocal } from './sellerProfile.js';
import type { RegionAddress } from './storefront.js';
import { addressFromLocaleCookie } from './storefront.js';
import type { Seller } from './types.js';
import { normalizeAliExpressStoreUrl } from './url.js';

/** How the seller profile is enriched. */
export type SellerStrategy =
    | 'inline-only' // inline API on the current page only; on block → seller=null (low latency).
    | 'inline-then-local'; // inline first, fall back to a local (no-proxy) browser + 2captcha.

/** Knobs the caller tunes per extraction pass. */
export interface ExtractOptions {
    sellerStrategy: SellerStrategy;
    /**
     * Whether to fall back to the page's intercepted pdp.pc.query response when the direct call
     * yields nothing. Only useful when the page actually navigated to the PDP.
     */
    interceptorFallback: boolean;
    /**
     * Ship-to country (ISO-3166 alpha-2) for the MTOP payloads. MUST match the `region` already set
     * in the page's `aep_usuc_f` cookie — a mismatch makes AliExpress answer for neither region.
     * Defaults to `US` when the caller has no per-request region.
     */
    shipToCountry?: string;
}

/** Outcome of one extraction pass. */
export interface ExtractResult {
    response: ReturnType<typeof createAliExpressResponse>;
    /** True ⇒ the page was blocked; caller should rotate and retry on a fresh identity. */
    blocked: boolean;
    blockReason?: string;
    /**
     * True ⇒ the storefront answered, and its answer was "we do not sell this here". A FINAL result,
     * not a block: the caller must push the record and must NOT rotate, because no fresh IP changes a
     * merchandising decision. `response.errorCode`/`errorMessage` carry the detail.
     */
    unavailableInRegion?: boolean;
}

/**
 * Read the buyer's resolved delivery address off the session's own `aep_usuc_f` cookie.
 *
 * AliExpress writes the province/city ids there itself during navigation (from the session's IP geo
 * or a saved address); the preNavigationHook in `main.ts` carries them across cookie rewrites. A real
 * browser sends them in every pdp.pc.query, and they narrow availability further than the country
 * alone. Sessions that were never given them fall back to `''` — the value this payload always sent
 * before — rather than to an invented id.
 */
async function resolveAddress(page: Page, shipToCountry: string): Promise<RegionAddress> {
    const cookies = await page.context().cookies('https://www.aliexpress.com').catch(() => []);
    const cookie = cookies.find((c) => c.name === 'aep_usuc_f');
    return addressFromLocaleCookie(shipToCountry, cookie?.value ?? null);
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
 * captcha. `inline-only` NEVER takes that slow fallback — it returns null instead, keeping latency
 * low. Caches the PROMISE (not the result) keyed by store id.
 *
 * `shipToCountry` is the region this product was read under; the seller's catalog module is filtered
 * by ship-to, so the seller call has to ask from the same market (see `sellerApiOpts`). It is part of
 * the cache key for the same reason — the same store yields a different catalog per region.
 */
function kickoffSellerScrape(
    page: Page,
    response: ReturnType<typeof createAliExpressResponse>,
    config: ScraperConfig,
    log: Log,
    sellerCache: Map<string, Promise<Seller | null>>,
    sellerStrategy: SellerStrategy,
    shipToCountry: string,
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
    // Region-scoped key: the catalog module answers per ship-to, so an ES lookup must not be handed
    // back to a US request in a run that mixes storefronts.
    const cacheKey = `${storeId}@${shipToCountry}`;
    const cached = sellerCache.get(cacheKey);
    if (cached) {
        return cached;
    }
    // The PDP's `adminSeq` (sellerRef.platformSellerId) IS the real sellerId the seller APIs need.
    const knownSellerId = response.sellerRef.platformSellerId;
    // `SHOP_CARD_PC.storeName` — kept for `buildSellerDto`'s name fallback, since this flow never
    // fetches renderPageData (the PDP already gave us the sellerId) and so has no other name source
    // when `seller.page.info` answers empty. Read out here: the narrowing is lost inside the closure.
    const knownStoreName = response.sellerRef.name;
    log.info(`🚀 Triggering seller scrape for store ${storeId} now (runs while we finish the product)…`);
    const sellerPromise = (async (): Promise<Seller | null> => {
        // Fast path: inline on the product page when we already have the sellerId.
        if (knownSellerId) {
            const inline = await scrapeSellerInline(page, storeId, knownSellerId, log, config, shipToCountry, knownStoreName).catch((error) => {
                log.warning('Inline seller fetch threw — treating as blocked.', {
                    error: error instanceof Error ? error.message : String(error),
                });
                return null;
            });
            if (inline && !inline.blocked) {
                return inline.seller;
            }
            // `inline-only`: never pay the slow local-browser + 2captcha fallback — keep latency low.
            if (sellerStrategy === 'inline-only') {
                log.info('Inline seller fetch blocked/empty — skipping (inline-only strategy).');
                return null;
            }
            log.info('Inline seller fetch blocked/empty — falling back to a local (no-proxy) browser.');
        }
        // Fallback (batch only): dedicated local browser (resolves sellerId via renderPageData + solves captcha).
        const local = await scrapeSellerLocal(storeId, log, config, knownSellerId, shipToCountry, knownStoreName).catch((error) => {
            log.warning('Seller scrape failed — skipping seller (product unaffected).', {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        });
        return local ? local.seller : null;
    })();
    sellerCache.set(cacheKey, sellerPromise);
    return sellerPromise;
}

/**
 * Extract one product (title, pricing, media, specs, stock, shipping, description, reviews) plus —
 * in `product_and_seller` mode — the seller profile, all from AliExpress's signed APIs via the
 * given page's request context. The page must already be on the target product with its anti-bot
 * cookies warm. Never throws on a block: returns `{ blocked: true }` for the caller to rotate.
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
    const shipToCountry = opts.shipToCountry ?? config.defaultShipToCountry;
    const storefront = storefrontForRequest(shipToCountry, config);
    const address = await resolveAddress(page, shipToCountry);
    response.shipToCountry = shipToCountry;
    response.storefront = storefront.site;
    log.info('storefront identity for this product', {
        site: storefront.site,
        locale: storefront.locale,
        currency: storefront.currency,
        province: address.province || '(none)',
        city: address.city || '(none)',
    });

    // Fire the signed pdp.pc.query ourselves (no bundle wait). Optionally fall back to the page's own
    // intercepted response (batch only). A block means neither yields JSON → rotate cheaply.
    let result = await fetchPdpDirect(page, response.product.id, log, address, storefront);
    if (!result && opts.interceptorFallback) {
        result = await waitForPdpResult(page, 8_000);
    }
    if (!result) {
        return { response, blocked: true, blockReason: 'pdp-blocked' };
    }

    // Checked BEFORE the title: a refused listing carries GLOBAL_DATA and nothing else, so the title
    // is legitimately absent and the "no title ⇒ blocked" rule below would misread the storefront's
    // clear answer as an anti-bot block and burn the whole retry budget on it.
    const refusal = pdpUnavailability(result as Record<string, unknown>);
    if (refusal) {
        response.success = false;
        response.errorCode = 'unavailable_in_region';
        // AliExpress's own code goes in the TEXT, not in `errorCode`: it is one of many such codes and
        // would force a backend to keep up with a vocabulary that is not ours. The three codes stay
        // stable; the specifics stay readable.
        response.errorMessage = [
            refusal.message ?? `The ${storefront.site} storefront does not sell this listing to ${shipToCountry}.`,
            `(${refusal.errorCode})`,
        ].join(' ');
        log.info('storefront does not sell this listing to the requested region — recording as unavailable.', {
            url,
            shipToCountry,
            site: storefront.site,
            reasonCode: refusal.errorCode,
        });
        return { response, blocked: false, unavailableInRegion: true };
    }

    const parsed = parsePdpResult(result as Record<string, unknown>);
    if (!parsed.title) {
        log.warning('pdp.pc.query JSON had no title — treating as blocked.', { url: page.url() });
        return { response, blocked: true, blockReason: 'empty-product' };
    }

    if (!parsed.pricing.currency) {
        // Every rung of the currency ladder came up empty — AliExpress has moved the ISO code again.
        // Worth a line: the extraction audit flags the field, but only this says which listing.
        log.warning('pricing currency empty — no ISO code in PRICE or GLOBAL_DATA.', { url: page.url() });
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
    const sellerPromise = kickoffSellerScrape(page, response, config, log, sellerCache, opts.sellerStrategy, shipToCountry);

    // Description — fetched from the URL embedded in the JSON, then cleaned.
    response.product.description = await fetchDescription(page, parsed.descUrl, log);
    log.info('description extracted', {
        htmlLength: response.product.description.html.length,
        plainTextLength: response.product.description.plainText.length,
    });

    // Reviews — fired in PARALLEL via the request context (token already warm from pdp.pc.query).
    const sellerSeq = response.sellerRef?.platformSellerId ?? null;
    const apiReviews = response.product.id ? await collectReviewsViaRequest(page, response.product.id, sellerSeq, log, 5, shipToCountry, storefront) : null;
    if (apiReviews) {
        response.product.reviewsSummary = apiReviews;
    }
    // Reviews API can be empty on some products; fall back to the rating from PC_RATING.
    //
    // It does NOT signal "empty" by omitting the statistic — it answers with an explicit zeroed one
    // (`evarageStar: 0, totalNum: 0`), which parses to 0, not null. Guarding on `rating == null`
    // alone therefore never fired, and a zeroed API response silently won over a PC_RATING that knew
    // better. That also disarmed the extraction audit, whose review checks are gated on
    // `reviewCount > 0` (see `hasReviews`): the zeros closed the gate on themselves.
    const summary = response.product.reviewsSummary;
    const apiEmpty = (summary.reviewCount ?? 0) === 0 && (summary.rating ?? 0) === 0;
    const fallbackHasData = (parsed.ratingFallback.reviewCount ?? 0) > 0 || (parsed.ratingFallback.rating ?? 0) > 0;
    if (apiEmpty && fallbackHasData) {
        log.warning('reviews API returned an empty statistic — falling back to PC_RATING.', {
            url: page.url(),
            fallbackRating: parsed.ratingFallback.rating,
            fallbackReviewCount: parsed.ratingFallback.reviewCount,
        });
        summary.rating = parsed.ratingFallback.rating;
        summary.reviewCount = parsed.ratingFallback.reviewCount;
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

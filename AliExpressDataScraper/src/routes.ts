import type { PlaywrightCrawlingContext } from '@crawlee/playwright';
import { createPlaywrightRouter } from '@crawlee/playwright';
import type { Log } from 'apify';
import type { Page } from 'playwright';

import type { ScraperConfig } from './config.js';
import { extractDescription } from './description.js';
import { CHALLENGE_SELECTORS, classifyPage, isProductLoaded, TITLE_SELECTORS } from './detection.js';
import { simulateBrowsing } from './humanize.js';
import { logEgressIp } from './ip.js';
import { extractMedia } from './media.js';
import { extractPricing } from './pricing.js';
import { createAliExpressResponse } from './response.js';
import { collectProductReviews } from './reviewsApi.js';
import { extractSellerRef } from './seller.js';
import { primeMtopToken } from './sellerApi.js';
import { scrapeSellerLocal } from './sellerProfile.js';
import { extractShipping } from './shipping.js';
import { extractSpecifications } from './specifications.js';
import { extractStock } from './stock.js';
import type { Seller } from './types.js';
import { normalizeAliExpressStoreUrl } from './url.js';

/** Try each candidate selector; return the first non-empty title text found. */
async function readTitle(page: Page): Promise<string | null> {
    for (const selector of TITLE_SELECTORS) {
        const text = await page
            .locator(selector)
            .first()
            .textContent({ timeout: 2_000 })
            .catch(() => null);
        const title = text?.trim();
        if (title) {
            return title;
        }
    }
    return null;
}

/** Log enough about the current page to tell "not loaded" apart from "selector wrong". */
async function dumpPageDiagnostics(page: Page, log: Log): Promise<void> {
    const docTitle = await page.title().catch(() => '<unavailable>');
    const h1Texts = await page
        .locator('h1')
        .allTextContents()
        .catch(() => [] as string[]);
    const bodyLen = await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => -1);
    log.warning('Title diagnostics', {
        url: page.url(),
        documentTitle: docTitle,
        h1Count: h1Texts.length,
        h1Texts: h1Texts.slice(0, 5),
        bodyTextLength: bodyLen,
    });
}

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
 * Build the Playwright router for a given configuration.
 *
 * A factory (rather than a module-level singleton) so the handler can read the resolved
 * {@link ScraperConfig} — humanization timing, hydration delay — without reaching for globals.
 */
export function createRouter(config: ScraperConfig) {
    const router = createPlaywrightRouter();

    // In-flight / resolved seller scrapes this run, keyed by store id. We cache the PROMISE so a seller
    // shared across many products (even concurrently) triggers a single scrape that all of them await.
    const sellerCache = new Map<string, Promise<Seller | null>>();

    router.addDefaultHandler(async (ctx) => {
        const { request, page, log, pushData } = ctx;

        // 1. Classify the page we landed on. Captcha/punish/blocked all mean this session is
        //    "burned" — we never solve, we rotate to a fresh IP + fingerprint and retry.
        let status = await classifyPage(page);

        if (status === 'captcha' || status === 'punish' || status === 'blocked') {
            rotateAndRetry(ctx, status);
        }

        // 2. Wait for EITHER real product markup OR a challenge to render — whichever appears
        //    first. AliExpress injects its slider/reCAPTCHA a beat after `domcontentloaded`, so a
        //    blind 30s wait for the title would stall on every late challenge before we ever got
        //    to re-classify. Racing the two means a challenge short-circuits the wait the moment
        //    it renders. We never use `networkidle` (AliExpress keeps long-lived connections open,
        //    so it rarely fires); the pre-navigation hook already pinned `domcontentloaded`.
        await Promise.race([
            page.waitForSelector(TITLE_SELECTORS.join(', '), { timeout: 30_000 }).catch(() => null),
            page.waitForSelector(CHALLENGE_SELECTORS.join(', '), { timeout: 30_000 }).catch(() => null),
        ]);

        // 3. Re-classify BEFORE spending the hydration + humanization budget. A hard block
        //    (captcha/punish/blocked) that rendered late is rotated right here, so we never waste
        //    ~5–8s scrolling a challenge page. `empty` is given the benefit of the doubt — a
        //    slow-hydrating real product also looks empty for a moment — and re-checked in step 5.
        status = await classifyPage(page);
        if (status === 'captcha' || status === 'punish' || status === 'blocked') {
            rotateAndRetry(ctx, status);
        }

        // 4. Real product (or a still-empty shell): let the client hydrate, then behave like a
        //    person skimming the page (also forces lazy content to render).
        const { minHydrationDelayMs, maxHydrationDelayMs } = config.humanize;
        await page.waitForTimeout(minHydrationDelayMs + Math.random() * (maxHydrationDelayMs - minHydrationDelayMs));
        await simulateBrowsing(page, config);

        // 5. A late challenge can still appear after hydration + scroll; final check before we
        //    trust the page. `empty` here (after a full load + scroll) is a soft block — rotate.
        status = await classifyPage(page);
        if (status !== 'ok') {
            rotateAndRetry(ctx, status);
        }

        // Confirm the product page is leaving via the residential proxy (expect a proxy IP here).
        // Fire-and-forget: this is pure diagnostics and never throws, so we don't block the handler
        // on it — the IP line just lands a moment later in the log.
        void logEgressIp(page, log, 'product');

        // Diagnostic: tag every pass that gets past the anti-bot gate with its request id + retry count.
        // Two passes sharing the same requestId overlapping in time means the request is being processed
        // concurrently (a premature retry overlapping a still-running attempt) — see `retryOnBlocked`.
        log.info('product handler pass', {
            requestId: request.id,
            retryCount: request.retryCount,
            pageUrl: page.url(),
        });

        // 4b. Proactively mint the MTOP `_m_h5_tk` token now, while the page is warm and settled, so the
        //     product-reviews API call later reads a ready token and succeeds on its first attempt
        //     instead of paying the token-bootstrap dance at that point. Best-effort.
        await primeMtopToken(page, log);

        // 5. Extract. Start from the canonical DTO skeleton and fill what we find. captureMode is a
        //    fixed function of the chosen run mode ('product_only' or 'product_and_seller'), not of
        //    whether a seller happened to be found on the page.
        const response = createAliExpressResponse(request.url);
        response.captureMode = config.mode;
        const title = await readTitle(page);

        if (!title || !(await isProductLoaded(page))) {
            log.warning('Product content missing after load — rotating.', { url: page.url() });
            await dumpPageDiagnostics(page, log);
            rotateAndRetry(ctx, 'empty-product');
        }

        response.product.title = title as string;

        // Seller reference — read it EARLY (right after we know the page is a real product) so we can
        // kick off the slow, captcha-bound seller scrape NOW and let it run CONCURRENTLY with the rest
        // of product extraction + reviews below. The scrape uses its own local browser, so it doesn't
        // contend with the product page. We await the result just before pushData. `product_only` skips it.
        response.sellerRef = await extractSellerRef(page);
        let sellerPromise: Promise<Seller | null> | null = null;
        if (response.sellerRef && config.mode === 'product_and_seller') {
            log.info('seller extracted', {
                name: response.sellerRef.name,
                platformSellerId: response.sellerRef.platformSellerId,
            });
            const storeId = storeIdFromRef(response.sellerRef.url, response.sellerRef.platformSellerId);
            if (storeId) {
                // Cache the PROMISE (not the result) so concurrent products of the same store share a
                // single in-flight scrape instead of each launching their own browser + captcha solve.
                sellerPromise = sellerCache.get(storeId) ?? null;
                if (!sellerPromise) {
                    log.info(`🚀 Triggering seller scrape for store ${storeId} now (runs while we finish the product)…`);
                    sellerPromise = scrapeSellerLocal(storeId, log, config)
                        .then((r) => r.seller)
                        .catch((error) => {
                            log.warning('Seller DOM scrape failed — skipping seller (product unaffected).', {
                                error: error instanceof Error ? error.message : String(error),
                            });
                            return null;
                        });
                    sellerCache.set(storeId, sellerPromise);
                }
            }
        }

        // Media — images + videos from the PDP gallery.
        response.product.media = await extractMedia(page);
        log.info('media extracted', {
            images: response.product.media.images.length,
            videos: response.product.media.videos.length,
        });

        // Pricing — headline price + currency from the PDP price block.
        response.product.pricing = await extractPricing(page);
        log.info('pricing extracted', {
            currency: response.product.pricing.currency,
            price: response.product.pricing.price,
        });

        // Specifications — name/value table (expanded via "View more").
        response.product.specifications = await extractSpecifications(page, log);
        log.info('specifications extracted', { count: response.product.specifications.length });

        // Description — rich-text detail block (Description tab → "View more" → read content).
        response.product.description = await extractDescription(page, log);
        log.info('description extracted', {
            htmlLength: response.product.description.html.length,
            plainTextLength: response.product.description.plainText.length,
        });

        // Buy box & service panel (right column) — stock, shipping, return/service commitments,
        // and the seller reference. All best-effort; absent fields stay at their defaults.
        response.product.stock = await extractStock(page);
        log.info('stock extracted', { availableQuantity: response.product.stock.availableQuantity });

        response.product.shipping = await extractShipping(page);
        log.info('shipping extracted', {
            deliveryTimeText: response.product.shipping.deliveryTimeText,
        });

        // Reviews — fetched from the product reviews API (`mtop.aliexpress.review.pc.list`), which gives
        // the overall rating, per-star breakdown and sample reviews. One call per star (5→1), at most 5
        // sample reviews each. Runs on the product `page` (its warm session + the token primed in 4b),
        // independent of the seller scrape (which uses its own local browser). Leaves the empty default
        // in place if the API yields nothing. Runs in BOTH product modes.
        const productId = response.product.id;
        const sellerSeq = response.sellerRef?.platformSellerId ?? null;
        const apiReviews = productId ? await collectProductReviews(page, productId, sellerSeq, log, { perStar: 5 }) : null;
        if (apiReviews) {
            response.product.reviewsSummary = apiReviews;
        }
        log.info('reviews extracted', {
            rating: response.product.reviewsSummary.rating,
            reviewCount: response.product.reviewsSummary.reviewCount,
            samples: response.product.reviewsSummary.reviewSamples.length,
        });

        // Await the seller scrape kicked off early above. By now its captcha solve has overlapped all of
        // the product extraction + reviews, so this usually resolves immediately. null = scrape failed/skipped.
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

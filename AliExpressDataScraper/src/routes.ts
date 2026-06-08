import type { PlaywrightCrawlingContext } from '@crawlee/playwright';
import { createPlaywrightRouter } from '@crawlee/playwright';
import type { Log } from 'apify';
import type { Page } from 'playwright';

import { extractCondition } from './condition.js';
import type { ScraperConfig } from './config.js';
import { extractDescription } from './description.js';
import { classifyPage, isBlockedPage, isCaptchaPage, isProductLoaded, isPunishPage, TITLE_SELECTORS } from './detection.js';
import { simulateBrowsing } from './humanize.js';
import { extractMedia } from './media.js';
import { extractPricing } from './pricing.js';
import { createAliExpressResponse, createSellerOnlyResponse } from './response.js';
import { collectProductReviews, collectSellerReviews } from './reviewsApi.js';
import { extractSellerRef } from './seller.js';
import type { ParsedSellerInfo } from './sellerApi.js';
import { fetchSellerInfo, parseSellerInfo, primeMtopToken } from './sellerApi.js';
import { extractSellerProductPreviews } from './sellerProducts.js';
import { extractShipping } from './shipping.js';
import { extractSpecifications } from './specifications.js';
import { extractStock } from './stock.js';
import type { Seller, SellerRef, SellerReviewSample } from './types.js';

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
 * Retire the current session and throw so Crawlee retries the request on a fresh session
 * (which, with the session pool + residential proxy, means a new sticky IP and a new
 * fingerprint). This is the core of the rotate-first anti-bot strategy.
 */
function rotateAndRetry(
    { session, request, log }: Pick<PlaywrightCrawlingContext, 'session' | 'request' | 'log'>,
    reason: string,
): never {
    log.warning(`Block detected — rotating session and retrying.`, {
        reason,
        url: request.url,
        sessionId: session?.id,
        retryCount: request.retryCount,
    });
    session?.retire();
    throw new Error(`Anti-bot block (${reason}); rotating to a fresh session/proxy.`);
}

/**
 * Promote a {@link SellerRef} to a full {@link Seller} profile by merging the parsed seller-API
 * fields and (optionally) the collected store reviews. Shared by the product and seller-only
 * handlers so the seller shape stays identical regardless of how it was reached.
 */
function buildSellerProfile(
    sellerRef: SellerRef,
    parsed: ParsedSellerInfo,
    sellerReviews: SellerReviewSample[] | null,
): Seller {
    return {
        ...sellerRef,
        positiveFeedbackPercent: parsed.positiveFeedbackPercent,
        feedbackScore: parsed.totalCount,
        storeNum: parsed.storeNum,
        countryCode: parsed.countryCode,
        countryName: parsed.countryName,
        followersText: parsed.followersText,
        openedSinceText: parsed.openedSinceText,
        storeLogo: parsed.storeLogo,
        reviewCounts: {
            positive: parsed.positiveCount,
            neutral: parsed.neutralCount,
            negative: parsed.negativeCount,
            total: parsed.totalCount,
        },
        scores: parsed.scores,
        sellerReviews: sellerReviews ?? [],
    };
}

/**
 * Build the Playwright router for a given configuration.
 *
 * A factory (rather than a module-level singleton) so the handler can read the resolved
 * {@link ScraperConfig} — humanization timing, hydration delay — without reaching for globals.
 */
export function createRouter(config: ScraperConfig) {
    const router = createPlaywrightRouter();

    // Seller ids whose info we've already fetched this run — a single seller shared across many
    // products is fetched only once. In-memory (per run) is enough; it doesn't need to persist.
    const scrapedSellerIds = new Set<string>();

    router.addDefaultHandler(async (ctx) => {
        const { request, page, log, pushData } = ctx;

        // 1. Classify the page we landed on. Captcha/punish/blocked all mean this session is
        //    "burned" — we never solve, we rotate to a fresh IP + fingerprint and retry.
        let status = await classifyPage(page);

        if (status === 'captcha' || status === 'punish' || status === 'blocked') {
            rotateAndRetry(ctx, status);
        }

        // 2. Wait for real product markup, then let the client hydrate. We never use
        //    `networkidle` (AliExpress keeps long-lived connections open, so it rarely fires);
        //    the pre-navigation hook already pinned `domcontentloaded`.
        await page.waitForSelector(TITLE_SELECTORS.join(', '), { timeout: 30_000 }).catch(() => undefined);
        const { minHydrationDelayMs, maxHydrationDelayMs } = config.humanize;
        await page.waitForTimeout(minHydrationDelayMs + Math.random() * (maxHydrationDelayMs - minHydrationDelayMs));

        // 3. Behave like a person skimming the page (also forces lazy content to render).
        await simulateBrowsing(page, config);

        // 4. A late challenge can appear after hydration; re-classify once before trusting it.
        status = await classifyPage(page);
        if (status !== 'ok') {
            // `empty` after a full load + scroll is a soft block; rotate like a hard one.
            rotateAndRetry(ctx, status);
        }

        // 4b. Proactively mint the MTOP `_m_h5_tk` token now, while the page is warm and settled.
        //     It sets the cookie via a throwaway call so the seller API call later (after all the
        //     product extraction) reads a ready token and succeeds on its first attempt instead of
        //     paying the token-bootstrap dance at that point. Best-effort.
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
            options: response.product.shipping.options.length,
            deliveryTimeText: response.product.shipping.deliveryTimeText,
        });

        response.product.condition = await extractCondition(page);
        log.info('condition extracted', {
            returnPolicySummary: response.product.condition.returnPolicySummary,
            guaranteeLabels: response.product.condition.guaranteeLabels.length,
        });

        // Seller reference — name + store URL + seller id, read from the PDP "Sold By" block. The
        // seller id (sellerSeq) is what the seller API needs.
        response.sellerRef = await extractSellerRef(page);
        // The seller API enrichment + product previews only run in the full `product_and_seller`
        // mode. `product_only` mode keeps the (cheap) `sellerRef` above — it also feeds the
        // `sellerSeq` used by the product-reviews call below — but skips everything seller-specific.
        if (response.sellerRef && config.mode === 'product_and_seller') {
            log.info('seller extracted', {
                name: response.sellerRef.name,
                platformSellerId: response.sellerRef.platformSellerId,
            });

            // Seller info comes from the MTOP `seller.page.info` API, called directly from this warm
            // browser context (same session cookies / sticky IP / fingerprint as the PDP). This
            // replaces the old "Sold By" click-through + store-page DOM scrape — no store tab, no
            // captcha/F5 dance. De-dupe by seller id so a seller shared across products is fetched
            // once. For now we just log the full response; parsing it into the Seller DTO is a
            // follow-up.
            const sellerId = response.sellerRef.platformSellerId;
            if (sellerId && !scrapedSellerIds.has(sellerId)) {
                scrapedSellerIds.add(sellerId);
                try {
                    const apiRes = await fetchSellerInfo(page, sellerId, log);
                    // Store reviews, collected per star (5→1) like the product reviews — at most 5
                    // samples per star, keeping only the display fields shown on the store panel.
                    const sellerReviews = await collectSellerReviews(page, sellerId, log, { perStar: 5 });
                    const parsed = parseSellerInfo(apiRes);
                    log.info('seller API fetched', {
                        sellerId,
                        info: Boolean(parsed),
                        reviews: sellerReviews?.length ?? 0,
                    });
                    if (parsed) {
                        // Promote the seller from a bare reference to a full profile on the response.
                        response.seller = buildSellerProfile(response.sellerRef, parsed, sellerReviews);
                    }
                } catch (error) {
                    log.warning('Seller API call failed — skipping seller (product unaffected).', {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }

            // Product previews come from the PDP DOM ("Recommended from <store>" strip), so they're
            // read on every product page — independent of the (de-duped) seller API call above. Attach
            // them to the seller profile, building a minimal one from the ref if the API yielded none.
            const productPreviews = await extractSellerProductPreviews(page, log);
            if (productPreviews.length) {
                response.seller = response.seller
                    ? { ...response.seller, productPreviews }
                    : { ...response.sellerRef, positiveFeedbackPercent: null, feedbackScore: null, productPreviews };
            }
        }

        // Reviews — fetched from the product reviews API (`mtop.aliexpress.review.pc.list`), which
        // gives the overall rating, per-star breakdown and sample reviews. One call per star (1→5),
        // at most 5 sample reviews each. Leaves the empty default in place if the API yields nothing.
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

        await pushData(response);
        log.info('extracted successfully');
    });

    // `seller_only` mode: each request navigates to the neutral home page (NOT the heavily
    // anti-bot-protected store page) purely to warm cookies + prime the MTOP token, then calls the
    // seller API keyed by the store id parsed from the input URL. There is no product page, so the
    // response carries `product: null` and no product previews.
    router.addHandler('SELLER', async (ctx) => {
        const { request, page, log, pushData } = ctx;
        const { sellerId, sourceUrl } = request.userData as { sellerId: string; sourceUrl: string };

        // Lighter check than `classifyPage`: the home page legitimately has no product title, so
        // `classifyPage` would return 'empty' and trip the product-mode rotate path forever. Here we
        // only rotate on a *real* block (punish redirect / captcha / Cloudflare).
        if (isPunishPage(page) || (await isCaptchaPage(page)) || (await isBlockedPage(page))) {
            rotateAndRetry(ctx, 'seller-home-block');
        }

        // Let the home page settle, then behave like a person before firing the API (warms cookies).
        const { minHydrationDelayMs, maxHydrationDelayMs } = config.humanize;
        await page.waitForTimeout(minHydrationDelayMs + Math.random() * (maxHydrationDelayMs - minHydrationDelayMs));
        await simulateBrowsing(page, config);

        // Mint the `_m_h5_tk` token while the page is warm so the seller call succeeds first try.
        await primeMtopToken(page, log);

        const response = createSellerOnlyResponse(sourceUrl, sellerId);
        // NOTE: in this mode `sellerId` is the public store id (the only identifier the store URL
        // exposes). That is the same fallback the PDP path uses when no `sellerSeq` is present, so
        // it's an exercised key; the parsers degrade gracefully (null/empty) if the API rejects it.
        try {
            const apiRes = await fetchSellerInfo(page, sellerId, log);
            // TEMP DEBUG: dump the full raw seller.page.info response so we can see exactly what the
            // API returns for a store id (ret code + whether `data` is populated or empty).
            log.info('seller_only RAW seller.page.info', { sellerId, raw: JSON.stringify(apiRes) });
            const sellerReviews = await collectSellerReviews(page, sellerId, log, { perStar: 5 });
            const parsed = parseSellerInfo(apiRes);
            log.info('seller API fetched (seller_only)', {
                sellerId,
                info: Boolean(parsed),
                reviews: sellerReviews?.length ?? 0,
            });
            if (parsed) {
                // Fill the store name from the API (the store URL alone doesn't carry it).
                response.sellerRef!.name = parsed.storeName ?? response.sellerRef!.name;
                response.seller = buildSellerProfile(response.sellerRef!, parsed, sellerReviews);
            }
        } catch (error) {
            log.warning('Seller API call failed (seller_only).', {
                error: error instanceof Error ? error.message : String(error),
            });
        }

        await pushData(response);
        log.info('seller_only extracted', { sellerId });
    });

    return router;
}

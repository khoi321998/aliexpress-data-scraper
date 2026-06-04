import type { PlaywrightCrawlingContext } from '@crawlee/playwright';
import { createPlaywrightRouter } from '@crawlee/playwright';
import type { Log } from 'apify';
import type { Page } from 'playwright';

import { extractCondition } from './condition.js';
import type { ScraperConfig } from './config.js';
import { extractDescription } from './description.js';
import { classifyPage, isProductLoaded, TITLE_SELECTORS } from './detection.js';
import { simulateBrowsing } from './humanize.js';
import { extractMedia } from './media.js';
import { extractPricing } from './pricing.js';
import { createAliExpressResponse } from './response.js';
import { extractReviews } from './reviews.js';
import { extractSellerRef } from './seller.js';
import { extractSellerProductPreviews } from './sellerProducts.js';
import { fetchSellerInfo, fetchSellerReviews, parseSellerInfo, primeMtopToken } from './sellerApi.js';
import { extractShipping } from './shipping.js';
import { extractSpecifications } from './specifications.js';
import { extractStock } from './stock.js';

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

        // 5. Extract. Start from the canonical DTO skeleton and fill what we find.
        const response = createAliExpressResponse(request.url);
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
        if (response.sellerRef) {
            // We now carry seller identity alongside the product, so reflect that in the mode.
            response.captureMode = 'product_and_seller';
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
                    const reviewsRes = await fetchSellerReviews(page, sellerId, log);
                    const parsed = parseSellerInfo(apiRes);
                    log.info('seller API fetched', {
                        sellerId,
                        info: Boolean(parsed),
                        reviews: Boolean(reviewsRes),
                    });
                    if (parsed) {
                        // Promote the seller from a bare reference to a full profile on the response.
                        response.seller = {
                            ...response.sellerRef,
                            positiveFeedbackPercent: parsed.positiveFeedbackPercent,
                            feedbackScore: parsed.totalCount,
                            storeNum: parsed.storeNum,
                            countryCode: parsed.countryCode,
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
                            // DEBUG: raw seller feedback/reviews response saved so we can inspect its
                            // full shape in the dataset before writing the review parser.
                            rawReviews: reviewsRes,
                        };
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

        // Reviews — ratings summary + sample reviews (Customer Reviews tab → "View more" → modal).
        response.product.reviewsSummary = await extractReviews(page, log);
        log.info('reviews extracted', {
            rating: response.product.reviewsSummary.rating,
            reviewCount: response.product.reviewsSummary.reviewCount,
            samples: response.product.reviewsSummary.reviewSamples.length,
        });

        await pushData(response);
        log.info('extracted successfully');
    });

    return router;
}

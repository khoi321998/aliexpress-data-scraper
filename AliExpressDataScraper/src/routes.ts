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
import { extractSellerRef } from './seller.js';
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

    // Sellers scraped this run, keyed by store id — a seller shared across many products is scraped
    // once and the built profile reused. In-memory (per run) is enough; it doesn't need to persist.
    const sellerCache = new Map<string, Seller>();

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

        // Seller reference — name + store URL + seller id, read from the PDP "Sold By" block.
        response.sellerRef = await extractSellerRef(page);

        // Seller enrichment runs only in `product_and_seller` mode. `product_only` keeps the cheap
        // `sellerRef` above and skips everything seller-specific. We hand off to the SAME DOM seller
        // pipeline used by `seller_only` (store all-items + feedback pages), de-duped per run so a
        // seller shared across many products is scraped once. This navigates away from the PDP — fine,
        // all product fields are already extracted above.
        if (response.sellerRef && config.mode === 'product_and_seller') {
            log.info('seller extracted', {
                name: response.sellerRef.name,
                platformSellerId: response.sellerRef.platformSellerId,
            });
            const storeId = storeIdFromRef(response.sellerRef.url, response.sellerRef.platformSellerId);
            if (storeId) {
                const cached = sellerCache.get(storeId);
                if (cached) {
                    response.seller = cached;
                } else {
                    try {
                        // Local browser (no proxy / no fingerprint) — the seller scrape must NOT use the
                        // product page's US residential proxy + spoofed fingerprint.
                        const { seller } = await scrapeSellerLocal(storeId, log, config);
                        response.seller = seller;
                        sellerCache.set(storeId, seller);
                    } catch (error) {
                        log.warning('Seller DOM scrape failed — skipping seller (product unaffected).', {
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
            }
        }

        await pushData(response);
        log.info('extracted successfully');
    });

    return router;
}

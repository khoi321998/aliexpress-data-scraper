import type { PlaywrightCrawlingContext } from '@crawlee/playwright';
import { createPlaywrightRouter } from '@crawlee/playwright';
import type { Log } from 'apify';
import type { Page } from 'playwright';

import type { ScraperConfig } from './config.js';
import type { SellerRef } from './types.js';
import { extractCondition } from './condition.js';
import { extractDescription } from './description.js';
import {
    classifyPage,
    isProductLoaded,
    sellerBlockReason,
    TITLE_SELECTORS,
} from './detection.js';
import { simulateBrowsing } from './humanize.js';
import { extractMedia } from './media.js';
import { extractPricing } from './pricing.js';
import { extractReviews } from './reviews.js';
import {
    ensureAbsolute,
    extractPositiveFeedbackPercent,
    extractSellerRef,
    parseStoreId,
    STORE_LINK_SELECTOR,
} from './seller.js';
import { extractShipping } from './shipping.js';
import { extractSpecifications } from './specifications.js';
import { extractStock } from './stock.js';
import { createAliExpressResponse } from './response.js';
import { applyRegionOverrides, applyStealthInitScript, logBrowserIdentity, readBrowserIdentity } from './stealth.js';

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
 * Click the PDP "Sold By" link and return the store tab it opens (or null).
 *
 * The link is `target="_blank"`, so the click opens the store in a NEW tab within the same warm
 * browser context (shared cookies, sticky residential IP, fingerprint) — an organic click-through,
 * the access pattern AliExpress expects, which avoids the login + captcha wall that a cold,
 * standalone deep-link to the store URL trips.
 *
 * Two things go wrong on that first popup load and both look like a cold deep-link to AliExpress's
 * store anti-bot, tripping a captcha even though the product tab is clean:
 *   1. The popup is opened by the browser, NOT navigated by Crawlee, so the preNavigationHooks that
 *      pin US timezone/locale + stealth never fired. `addInitScript` only affects the NEXT
 *      document, and the CDP timezone override lands AFTER the store's anti-bot JS has already read
 *      `Intl` — so the first load leaks the host timezone (e.g. Asia/Bangkok) against the US IP.
 *   2. Depending on the link's `rel`/referrer-policy, the popup navigation may carry no `Referer`,
 *      so the store sees a direct hit with no PDP origin — exactly the cold deep-link pattern.
 * So we apply the region/stealth overrides while the popup is still on its initial document, then
 * explicitly re-navigate it to the store URL with the PDP as `Referer`. The re-goto now runs under
 * the correct timezone + stealth and presents a genuine click-through referer.
 *
 * Kept separate from {@link readSellerFromTab} on purpose: the click touches the MAIN page, so it
 * must complete before reviews start manipulating that same page. Once the popup is open, the
 * extraction below runs on the popup and can overlap reviews on the main page.
 */
async function openStoreTab(
    { page, log }: Pick<PlaywrightCrawlingContext, 'page' | 'log'>,
): Promise<Page | null> {
    const storeLink = page.locator(STORE_LINK_SELECTOR).first();
    if ((await storeLink.count()) === 0) {
        log.warning('PDP "Sold By" link not found — skipping seller (product unaffected).');
        return null;
    }

    // The `href` ATTRIBUTE is only the bare store path (`//.../store/<id>`). The full URL a real
    // click lands on also carries tracking params that AliExpress's JS click handler appends —
    // notably `spm` (which encodes "came from the product detail page"), plus `_gl`/`_ga`. Those
    // params, together with the Referer, are exactly what the store anti-bot reads to tell an
    // organic click-through from a cold deep-link. So we must NOT navigate to the bare href (that
    // strips them); we let the popup's own click navigation stand and only re-load the URL it
    // actually landed on if we need to. Keep the bare href solely as a last-resort fallback.
    const storeHref = await storeLink.getAttribute('href').catch(() => null);
    const bareStoreUrl = storeHref ? ensureAbsolute(storeHref.trim()) : null;
    const productUrl = page.url();

    try {
        const [sellerPage] = await Promise.all([
            page.context().waitForEvent('page', { timeout: 30_000 }),
            storeLink.click(),
        ]);

        // Let the popup's natural click navigation commit so its URL is the FULL tracking URL (with
        // spm/_gl/_ga), not the about:blank it opens on. Best-effort wait.
        await sellerPage.waitForLoadState('domcontentloaded').catch(() => undefined);

        // Apply the region + stealth overrides. `addInitScript` only affects the NEXT document and
        // the CDP timezone override may have missed the first paint, so the re-load below is what
        // actually puts the popup on a clean US fingerprint.
        await applyRegionOverrides(sellerPage);
        await applyStealthInitScript(sellerPage).catch(() => undefined);

        // Re-load the store under the correct timezone/stealth WITH the PDP as Referer — but to the
        // URL the click actually produced (spm + tracking params preserved), falling back to the
        // bare href only if the popup never left about:blank. This keeps the organic click-through
        // signal intact while fixing the fingerprint. Best-effort: on failure we keep the popup
        // as-is and let the caller's block detection / reload loop decide.
        const landedUrl = sellerPage.url();
        const target = landedUrl && !landedUrl.startsWith('about:') ? landedUrl : bareStoreUrl;
        if (target) {
            await sellerPage
                .goto(target, { referer: productUrl, waitUntil: 'domcontentloaded', timeout: 30_000 })
                .catch((error) => {
                    log.warning('Re-navigating the store popup with a Referer failed — using the popup as-is.', {
                        target,
                        error: error instanceof Error ? error.message : String(error),
                    });
                });
        }
        return sellerPage;
    } catch (error) {
        log.warning('Clicking "Sold By" did not open a store tab — skipping seller (product unaffected).', {
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

/**
 * Read the seller's positive-feedback headline from an already-open store tab and push it as its
 * own `seller_only` item, then close the tab.
 *
 * Operates solely on the popup `sellerPage`, so it can run concurrently with reviews extraction on
 * the main page. Best-effort: a block or any error is logged and swallowed so the already-extracted
 * product (and reviews) are never lost.
 */
async function readSellerFromTab(
    sellerPage: Page,
    { log, pushData }: Pick<PlaywrightCrawlingContext, 'log' | 'pushData'>,
    sellerRef: SellerRef,
    config: ScraperConfig,
): Promise<void> {
    try {
        await sellerPage.waitForLoadState('domcontentloaded').catch(() => undefined);

        // DIAGNOSTIC (pre-fix): log the seller tab's reported fingerprint to verify whether the
        // popup inherits the product tab's identity. Compare `timezone` here against the product
        // tab's `logBrowserIdentity` line above — if it leaks the host TZ (e.g. Asia/*) instead of
        // America/New_York, the per-page region/stealth hooks didn't reach this popup.
        const sellerIdentity = await readBrowserIdentity(sellerPage);
        log.info('Seller tab identity (after click-through) — compare timezone vs the product tab.', {
            url: sellerPage.url(),
            ...sellerIdentity,
        });

        // Generic block detection only — a store page has no product title to check.
        //
        // AliExpress's store anti-bot (Alibaba punish / x5sec / baxia) routinely challenges the
        // FIRST hit but sets an anti-bot token cookie on that very response; a plain reload re-sends
        // the token and passes — exactly what a manual F5 does. So when the store tab lands on a
        // challenge we reload a few times (with a short human-like pause) within this warm tab
        // before giving up. Init-script + CDP timezone overrides persist across reloads, so each
        // retry keeps the same clean fingerprint.
        //
        // CRITICAL timing: the slider/punish widget is INJECTED BY JS a beat after
        // `domcontentloaded`, so checking immediately sees a clean DOM and misses it (the captcha
        // then pops up unattended). We settle for the hydration window first — long enough for the
        // challenge to render if it's coming — and re-settle after every reload before re-checking.
        const { minActionDelayMs, maxActionDelayMs, minHydrationDelayMs, maxHydrationDelayMs } = config.humanize;
        const settle = () =>
            sellerPage.waitForTimeout(minHydrationDelayMs + Math.random() * (maxHydrationDelayMs - minHydrationDelayMs));
        const pause = () =>
            sellerPage.waitForTimeout(minActionDelayMs + Math.random() * (maxActionDelayMs - minActionDelayMs));

        await settle();

        // Proactive F5: the store's JS-injected challenge can evade DOM detection (it renders a beat
        // after load, in skins/iframes our selectors may not match), so we don't wait to "see" it.
        // The first hit is the one that gets challenged AND sets the anti-bot token cookie; a plain
        // reload re-sends that token and clears the challenge — so we always reload once up front,
        // regardless of what detection reports. Cheap, and it mirrors the manual F5 that works.
        const ALWAYS_RELOAD_COUNT = 1; // Always F5 once up front to re-send the anti-bot token cookie.
        for (let i = 1; i <= ALWAYS_RELOAD_COUNT; i += 1) {
            const reason = await sellerBlockReason(sellerPage);
            log.info(`Seller store: proactive reload (F5) ${i}/${ALWAYS_RELOAD_COUNT} to clear any token challenge.`, {
                url: sellerPage.url(),
                blockDetected: reason ?? 'none',
            });
            await pause();
            await sellerPage.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
            await settle();
        }

        // After the proactive F5, if a challenge is still detected (slider OR a normal reCAPTCHA,
        // punish redirect, or generic block — `sellerBlockReason` reports which), keep reloading up
        // to this many more times before giving up on the seller. We log the concrete reason on each
        // attempt so the cause of a stubborn block is visible in the run log.
        const MAX_SELLER_RELOADS = 3; // If still challenged after the proactive F5, reload up to 3 more times.
        let reason = await sellerBlockReason(sellerPage);
        let reloadsUsed = 0;
        for (let attempt = 1; reason && attempt <= MAX_SELLER_RELOADS; attempt += 1) {
            log.warning(
                `Seller store blocked — reloading like an F5 (attempt ${attempt}/${MAX_SELLER_RELOADS}).`,
                {
                    url: sellerPage.url(),
                    reason,
                },
            );
            await pause();
            await sellerPage.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
            await settle();
            reloadsUsed = attempt;
            reason = await sellerBlockReason(sellerPage);
        }
        if (reason) {
            log.warning('Seller store page still blocked after reloads — skipping seller (product unaffected).', {
                url: sellerPage.url(),
                reason,
                reloadsUsed,
                maxReloads: MAX_SELLER_RELOADS,
                title: await sellerPage.title().catch(() => '<unavailable>'),
            });
            return;
        }
        if (reloadsUsed > 0) {
            log.info(`Seller store challenge cleared after ${reloadsUsed}/${MAX_SELLER_RELOADS} reload(s).`, {
                url: sellerPage.url(),
            });
        }

        // Wait (best-effort) for the feedback label to render (the header already settled above).
        await sellerPage
            .getByText('positive reviews', { exact: false })
            .first()
            .waitFor({ timeout: 15_000 })
            .catch(() => undefined);

        const positiveFeedbackPercent = await extractPositiveFeedbackPercent(sellerPage);
        log.info('seller positive reviews', {
            url: sellerPage.url(),
            platformSellerId: sellerRef.platformSellerId,
            positiveFeedbackPercent,
        });

        await pushData({
            captureMode: 'seller_only',
            url: sellerPage.url(),
            sellerRef,
            seller: { ...sellerRef, positiveFeedbackPercent },
            capturedAt: new Date().toISOString(),
        });
    } catch (error) {
        log.warning('Seller scrape failed — skipping seller (product unaffected).', {
            error: error instanceof Error ? error.message : String(error),
        });
    } finally {
        await sellerPage.close().catch(() => undefined);
    }
}

/**
 * Build the Playwright router for a given configuration.
 *
 * A factory (rather than a module-level singleton) so the handler can read the resolved
 * {@link ScraperConfig} — humanization timing, hydration delay — without reaching for globals.
 */
export function createRouter(config: ScraperConfig) {
    const router = createPlaywrightRouter();

    // Store ids whose feedback page we've already scraped this run — a single seller shared across
    // many products is fetched only once. In-memory (per run) is enough; it doesn't need to persist.
    const scrapedStoreIds = new Set<string>();

    router.addDefaultHandler(async (ctx) => {
        const { request, page, log, pushData, session } = ctx;

        // 0. Log the fingerprint this session is actually presenting (ground truth from the
        //    page). Lets you confirm each rotation really did mint a new IP + identity.
        await logBrowserIdentity(page, log, session?.id);

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

        // Opened below if a seller is found; read concurrently with reviews further down.
        let sellerTab: Page | null = null;

        response.sellerRef = await extractSellerRef(page);
        if (response.sellerRef) {
            // We now carry seller identity alongside the product, so reflect that in the mode.
            response.captureMode = 'product_and_seller';
            log.info('seller extracted', {
                name: response.sellerRef.name,
                platformSellerId: response.sellerRef.platformSellerId,
            });

            // Seller info. Rather than deep-linking to a store/feedback URL on a cold request
            // (which trips AliExpress's login + captcha wall), we click through the PDP "Sold By"
            // link inside this product's warm context. De-dupe by store id so a seller shared
            // across products is fetched once. The click (on the MAIN page) happens here, BEFORE
            // reviews open their modal on that same page; the extraction is deferred so it can run
            // concurrently with reviews (see Promise.all below).
            const storeId = response.sellerRef.url ? parseStoreId(response.sellerRef.url) : null;
            const dedupeKey = storeId ?? response.sellerRef.url ?? response.sellerRef.name;
            if (dedupeKey && !scrapedStoreIds.has(dedupeKey)) {
                scrapedStoreIds.add(dedupeKey);
                sellerTab = await openStoreTab(ctx);
            }
        }

        // Run the two slow, page-independent tasks concurrently: reading the seller's store tab
        // (popup) and sweeping reviews on the main page (modal + per-star dropdown). The "Sold By"
        // click already completed above, so there's no contention left on the main page.
        const sellerRefForTab = response.sellerRef;
        await Promise.all([
            // Reviews — ratings summary + sample reviews (Customer Reviews tab → "View more" → modal).
            (async () => {
                response.product.reviewsSummary = await extractReviews(page, log);
                log.info('reviews extracted', {
                    rating: response.product.reviewsSummary.rating,
                    reviewCount: response.product.reviewsSummary.reviewCount,
                    samples: response.product.reviewsSummary.reviewSamples.length,
                });
            })(),
            // Seller — read the positive-feedback headline from the already-open store tab.
            sellerTab && sellerRefForTab
                ? readSellerFromTab(sellerTab, ctx, sellerRefForTab, config)
                : Promise.resolve(),
        ]);

        await pushData(response);
        log.info('extracted successfully');
    });

    return router;
}

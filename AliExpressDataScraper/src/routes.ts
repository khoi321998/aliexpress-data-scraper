import type { PlaywrightCrawlingContext } from '@crawlee/playwright';
import { createPlaywrightRouter } from '@crawlee/playwright';
import type { Log } from 'apify';

import type { ScraperConfig } from './config.js';
import { storefrontForRequest } from './config.js';
import { classifyPage, isNotFoundPage } from './detection.js';
import { extractProduct } from './extractProduct.js';
import { pushRecord } from './pushRecord.js';
import { createAliExpressResponse } from './response.js';
import type { Seller } from './types.js';

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

/**
 * Recover the block reason {@link rotateAndRetry} encoded into its error message.
 *
 * The two are a matched pair — change the message above and this pattern with it. Reading the reason
 * back out of the message (rather than threading it through Crawlee's retry machinery) keeps the
 * rotation path free of extra state; `null` simply means the failure was something else entirely,
 * such as a navigation timeout or a proxy error.
 */
export function blockReasonFromError(error: unknown): string | null {
    const message = error instanceof Error ? error.message : String(error);
    return /^Anti-bot block \(([^)]+)\)/.exec(message)?.[1] ?? null;
}

/**
 * Push the record for a URL AliExpress has no listing for.
 *
 * A dataset row rather than a dropped request or a `failedRequestHandler` error: the run asked about
 * this URL and got a definite answer, and "this id does not exist" is a result the caller wants back
 * — especially in a batch, where one bad id must not read like a scrape failure.
 */
async function pushNoListing(url: string, shipToCountry: string, config: ScraperConfig, log: Log): Promise<void> {
    const response = createAliExpressResponse(url);
    response.captureMode = config.mode;
    response.shipToCountry = shipToCountry;
    response.storefront = storefrontForRequest(shipToCountry, config).site;
    response.success = false;
    response.errorCode = 'not_found';
    // AliExpress's 404 page states no reason of its own, so the message is ours.
    response.errorMessage = `AliExpress has no listing with item id ${response.product.id} (it served its 404 page).`;
    await pushRecord(response, log);
}

/**
 * Build the Playwright router for the BATCH crawler. The product handler navigates to bootstrap the
 * anti-bot cookies, then defers to the shared {@link extractProduct} (which extracts everything from
 * the signed `pdp.pc.query` MTOP JSON + reviews + description + seller — no page DOM is scraped).
 *
 * The handler stays thin: it owns the Crawlee-session-specific rotation (`rotateAndRetry`) and defers
 * the rest. It uses the `inline-then-local` seller strategy (slow local fallback allowed) and the
 * interceptor fallback (it navigated to the PDP, so the intercepted response is usable).
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
        const { request, page, log } = ctx;

        // Ship-to was resolved from the raw start URL in `main.ts` and rides on `userData`; the same
        // value already went into the `aep_usuc_f` cookie via the preNavigationHook, and now has to
        // match the `country` we sign into the MTOP payloads.
        const shipToCountry = (request.userData?.shipToCountry as string | undefined) ?? config.defaultShipToCountry;

        // Hard block on arrival → rotate immediately.
        const arrival = await classifyPage(page);
        if (arrival === 'captcha' || arrival === 'punish' || arrival === 'blocked') {
            rotateAndRetry(ctx, arrival);
        }
        // A 404 caught this early means the user pasted an id that does not exist — record it and
        // stop before spending a proxy request on the signed API for a listing that isn't there.
        if (arrival === 'notfound') {
            await pushNoListing(request.url, shipToCountry, config, log);
            log.info('item id does not exist — recorded as not found', { requestId: request.id, url: request.url });
            return;
        }

        log.info('product handler pass', { requestId: request.id, retryCount: request.retryCount, pageUrl: page.url(), shipToCountry });

        const { response, blocked, blockReason, unavailableInRegion } = await extractProduct(page, request.url, config, log, sellerCache, {
            sellerStrategy: 'inline-then-local',
            interceptorFallback: true,
            shipToCountry,
        });
        // The storefront answered "we don't sell this here". That is the ANSWER, not a block — push it
        // and stop. Rotating would spend the whole retry budget on a listing no clean IP can unlock.
        if (unavailableInRegion) {
            await pushRecord(response, log);
            log.info('recorded as unavailable in region', {
                requestId: request.id,
                shipToCountry,
                errorMessage: response.errorMessage,
            });
            return;
        }
        if (blocked) {
            // The signed call came back with nothing. Before treating that as a block, give the 404
            // markers a moment to arrive: navigation resolves at `commit`, so on the first pass the
            // document may not have been parsed far enough for the arrival check above to see them.
            // Paying ~3s HERE is the whole point — the alternative is ten rotations chasing an id
            // that does not exist.
            if (await isNotFoundPage(page, 3_000)) {
                await pushNoListing(request.url, shipToCountry, config, log);
                log.info('item id does not exist — recorded as not found', { requestId: request.id, url: request.url });
                return;
            }
            // `pdp-blocked` may actually be a captcha/punish overlay — reclassify for an accurate tally
            // (an 'ok' classification with no JSON means the signed call timed out, not a hard block).
            let reason = blockReason ?? 'empty-product';
            if (blockReason === 'pdp-blocked') {
                const status = await classifyPage(page);
                reason = status === 'ok' ? 'pdp-timeout' : status;
            }
            rotateAndRetry(ctx, reason);
        }

        await pushRecord(response, log);
        log.info('extracted successfully', { requestId: request.id, retryCount: request.retryCount });
    });

    return router;
}

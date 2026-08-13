import type { PlaywrightCrawlingContext } from '@crawlee/playwright';
import { createPlaywrightRouter } from '@crawlee/playwright';

import type { ScraperConfig } from './config.js';
import { classifyPage } from './detection.js';
import { extractProduct } from './extractProduct.js';
import { pushRecord } from './pushRecord.js';
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

        // Hard block on arrival → rotate immediately.
        const arrival = await classifyPage(page);
        if (arrival === 'captcha' || arrival === 'punish' || arrival === 'blocked') {
            rotateAndRetry(ctx, arrival);
        }

        log.info('product handler pass', { requestId: request.id, retryCount: request.retryCount, pageUrl: page.url() });

        const { response, blocked, blockReason } = await extractProduct(page, request.url, config, log, sellerCache, {
            sellerStrategy: 'inline-then-local',
            interceptorFallback: true,
        });
        if (blocked) {
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

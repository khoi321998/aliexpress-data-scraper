import { createPlaywrightRouter } from '@crawlee/playwright';
import type { PlaywrightCrawlingContext } from '@crawlee/playwright';
import type { Log } from 'apify';
import type { Page } from 'playwright';

import type { ScraperConfig } from './config.js';
import { TITLE_SELECTORS, classifyPage, isProductLoaded } from './detection.js';
import { simulateBrowsing } from './humanize.js';
import { createAliExpressResponse } from './response.js';

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

    router.addDefaultHandler(async (ctx) => {
        const { request, page, log, pushData, session } = ctx;
        const startedAt = Date.now();

        // 1. Classify the page we landed on. Captcha/punish/blocked all mean this session is
        //    "burned" — we never solve, we rotate to a fresh IP + fingerprint and retry.
        let status = await classifyPage(page);
        log.info('Page classified.', { url: page.url(), status, sessionId: session?.id });

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

        // TODO: populate the remaining DTO fields (pricing, media, specifications, reviews, …).

        await pushData(response);
        log.info('Product extracted.', {
            url: page.url(),
            title: response.product.title,
            sessionId: session?.id,
            elapsedMs: Date.now() - startedAt,
        });
    });

    return router;
}

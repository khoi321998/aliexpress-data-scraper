// Standby HTTP server — the real-time, one-product-per-call entry path.
//
// Instead of the batch crawler (navigate-per-product, rotate-on-block), this keeps a small pool of
// WARM browser contexts alive between requests (see `WarmPool` / `warmContext.ts`). A GET request
// carrying an AliExpress product `url` leases a warm context, extracts the product via signed APIs
// (NO navigation), and returns JSON. On a block it rotates that context and retries on another, so
// the caller still gets a clean result without paying a cold browser start.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

import { BrowserPool, PlaywrightPlugin } from '@crawlee/browser-pool';
import { Actor, log } from 'apify';
import { chromium } from 'playwright';

import type { ScraperConfig } from './config.js';
import { extractProduct } from './extractProduct.js';
import { CHROME_LAUNCH_ARGS, FINGERPRINT_OPTIONS } from './stealth.js';
import type { Seller } from './types.js';
import { normalizeAliExpressUrl } from './url.js';
import type { StandbyBrowserPool } from './warmContext.js';
import { WarmPool } from './warmPool.js';

/** Up to how many warm contexts a single request will burn through before giving up with 502. */
const MAX_BLOCK_RETRIES = 2;

/** Send a JSON response with the given status code. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(payload);
}

/**
 * Build the BrowserPool the warm contexts run on. `maxOpenPagesPerBrowser: 1` is the linchpin: with
 * one page per browser, every warm context gets its own browser → its own fingerprint AND its own
 * sticky proxy IP (the per-`newPage` `proxyUrl` is applied at that browser's launch). Auto-retire is
 * effectively disabled so long-lived warm contexts are not reaped — the `WarmPool` controls recycling.
 */
function buildBrowserPool(config: ScraperConfig): StandbyBrowserPool {
    return new BrowserPool({
        browserPlugins: [
            new PlaywrightPlugin(chromium, {
                useIncognitoPages: false,
                launchOptions: { headless: config.headless, channel: 'chrome', args: CHROME_LAUNCH_ARGS },
            }),
        ],
        useFingerprints: true,
        fingerprintOptions: { fingerprintGeneratorOptions: FINGERPRINT_OPTIONS },
        maxOpenPagesPerBrowser: 1,
        retireBrowserAfterPageCount: 10_000,
        // Defaults (300s / 10s) would silently reap our idle warm browsers between sparse calls.
        closeInactiveBrowserAfterSecs: 3_600,
        retireInactiveBrowserAfterSecs: 3_600,
    }) as StandbyBrowserPool;
}

/**
 * Scrape one product on a warm context, rotating + retrying on a block. Returns the response JSON or
 * throws a tagged error the request handler maps to an HTTP status.
 */
async function scrapeOne(warmPool: WarmPool, url: string, config: ScraperConfig): Promise<unknown> {
    // Per-request seller cache (single product, so effectively one entry) — avoids unbounded growth.
    const sellerCache = new Map<string, Promise<Seller | null>>();
    let wc = await warmPool.lease();
    try {
        for (let attempt = 0; attempt <= MAX_BLOCK_RETRIES; attempt += 1) {
            const { response, blocked, blockReason } = await extractProduct(wc.page, url, config, log, sellerCache, {
                sellerStrategy: 'inline-only',
                interceptorFallback: false,
            });
            if (!blocked) {
                return response;
            }
            log.warning('Standby extraction blocked.', { url, attempt, blockReason, sessionId: wc.sessionId });
            if (attempt < MAX_BLOCK_RETRIES) {
                await warmPool.rotate(wc); // recycles wc (no longer in the pool)
                wc = await warmPool.lease();
            }
        }
        const err = new Error('blocked after retries') as Error & { httpStatus?: number };
        err.httpStatus = 502;
        throw err;
    } finally {
        // `wc` is whatever we hold now; a rotated-away context was already recycled, so releasing the
        // current lease is correct. (release of a recycled context is a no-op — it's not in the pool.)
        warmPool.release(wc);
    }
}

/** Build the request handler over the warm pool. */
function makeHandler(warmPool: WarmPool, config: ScraperConfig) {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const parsed = new URL(req.url ?? '/', 'http://localhost');
        const targetUrl = parsed.searchParams.get('url');

        // Apify standby readiness probe — must answer 200 so the platform marks the server live.
        if (req.headers['x-apify-container-server-readiness-probe']) {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('Readiness probe OK\n');
            return;
        }

        if (!targetUrl) {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end(`Actor is ready (warm contexts: ${warmPool.readyCount()})\n`);
            return;
        }

        const normalized = normalizeAliExpressUrl(targetUrl);
        if (!normalized) {
            sendJson(res, 400, { error: 'invalid_url', message: 'Not a recognizable AliExpress product URL.', url: targetUrl });
            return;
        }

        const startedAt = Date.now();
        try {
            const response = await scrapeOne(warmPool, normalized, config);
            log.info('standby request served', { url: normalized, ms: Date.now() - startedAt });
            // Also persist to the dataset for an auditable trail of standby calls.
            await Actor.pushData(response as Record<string, unknown>).catch(() => undefined);
            sendJson(res, 200, response);
        } catch (error) {
            const status = (error as { httpStatus?: number }).httpStatus ?? (error instanceof Error && error.message.includes('Timed out waiting') ? 503 : 500);
            const message = error instanceof Error ? error.message : String(error);
            log.warning('standby request failed', { url: normalized, status, message, ms: Date.now() - startedAt });
            sendJson(res, status, { error: status === 502 ? 'blocked' : status === 503 ? 'busy' : 'error', message, url: normalized });
        }
    };
}

/**
 * Entry point for standby mode: build the residential-proxy browser pool, warm the context pool, and
 * serve product requests over HTTP until the Actor is aborted.
 */
export async function runStandby(config: ScraperConfig): Promise<void> {
    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
        countryCode: config.proxyCountry,
    });
    if (!proxyConfiguration) {
        throw new Error('Standby mode requires a residential proxy configuration (paid Apify Proxy plan).');
    }

    const browserPool = buildBrowserPool(config);
    const warmPool = new WarmPool(browserPool, proxyConfiguration, config, log, {
        size: config.standby.poolSize,
        maxUsageCount: config.standby.maxUsageCount,
        maxAgeMs: 8 * 60_000,
        leaseTimeoutMs: Math.max(config.navigationTimeoutSecs, 60) * 1_000,
    });

    let draining = false;
    Actor.on('aborting', async () => {
        if (draining) return;
        draining = true;
        log.info('Standby aborting — draining warm pool.');
        await warmPool.drainAndClose();
        await Actor.exit();
    });

    await warmPool.start();

    const port = Number(process.env.ACTOR_STANDBY_PORT) || 4321;
    const server = createServer(makeHandler(warmPool, config));
    await new Promise<void>((resolve) => server.listen(port, resolve));
    log.info(`🟢 Standby server listening on :${port} (pool ${warmPool.readyCount()}/${config.standby.poolSize}, residential ${config.proxyCountry}).`);

    // Keep the process alive until aborted; the server handles requests via its callback.
    await new Promise<void>(() => {});
}

// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { setTimeout as sleep } from 'node:timers/promises';

import { PlaywrightCrawler } from '@crawlee/playwright';
// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor, log } from 'apify';

import type { ScraperInput } from './config.js';
// this is an ESM project, so relative imports must include the `.js` extension even from TS.
import { buildConfig } from './config.js';
import { createRouter } from './routes.js';
import { applyRegionOverrides, applyStealthInitScript, CHROME_LAUNCH_ARGS, FINGERPRINT_OPTIONS } from './stealth.js';
import { normalizeAliExpressUrl } from './url.js';

// Load a local `.env` (e.g. TWOCAPTCHA_API_KEY) for local runs. On the Apify platform these
// come from the Actor's environment variables, so a missing file is fine — ignore the error.
try {
    process.loadEnvFile();
} catch {
    // No local .env present (e.g. running on the Apify platform); rely on real env vars.
}

// Every Actor must call init() so the Apify-provided environment (storage, proxy, events) wires up.
await Actor.init();

const input = (await Actor.getInput<ScraperInput>()) ?? ({} as ScraperInput);
const config = buildConfig(input);
log.info('Resolved scraper config.', { ...config });

if (!input.startUrls?.length) {
    throw new Error('Input "startUrls" must contain at least one AliExpress product URL.');
}

// Normalize whatever the user pasted (vi./de./m. subdomains, tracking params, …) to the
// canonical https://www.aliexpress.com/item/<id>.html, dropping anything unrecognizable and
// de-duplicating links that point to the same product.
const requestUrls = [
    ...new Set(
        input.startUrls.flatMap(({ url }) => {
            const normalized = normalizeAliExpressUrl(url);
            if (!normalized) {
                log.warning(`Skipping non-product AliExpress URL: ${url}`);
                return [];
            }
            if (normalized !== url) {
                log.info(`Normalized URL: ${url} -> ${normalized}`);
            }
            return [normalized];
        }),
    ),
];

if (!requestUrls.length) {
    throw new Error('No valid AliExpress product URLs found in "startUrls".');
}

// AliExpress blocks datacenter IPs hard, so we route through Apify residential proxy. `checkAccess`
// is intentionally omitted so a local run (where proxy access can't be verified up front) doesn't
// throw — it just egresses from the local IP if the proxy is unavailable.
const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: config.proxyCountry,
});
log.info(`Using Apify residential proxy (RESIDENTIAL, country ${config.proxyCountry}).`);

// Anti-bot strategy is avoidance + rotation only: a captcha/punish/blocked page retires the
// burned session and retries on a fresh residential IP + fingerprint. We never solve captchas.
log.info('Anti-bot strategy: rotate (blocks retire the session and retry on a fresh IP/fingerprint).');

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    requestHandler: createRouter(config),

    // --- Throughput & retries -------------------------------------------------------------
    // Browser crawlers stay under the radar at low concurrency; rotation needs enough retries
    // to find a clean residential IP.
    maxConcurrency: config.maxConcurrency,
    maxRequestsPerCrawl: config.maxRequestsPerCrawl,
    maxRequestRetries: config.maxRequestRetries,

    // --- Timeouts -------------------------------------------------------------------------
    navigationTimeoutSecs: config.navigationTimeoutSecs,
    requestHandlerTimeoutSecs: config.requestHandlerTimeoutSecs,

    // --- Sessions & proxy rotation --------------------------------------------------------
    // A session is tied to one sticky residential IP *and* (via the fingerprint cache) one
    // fingerprint. Reusing it a few times builds natural cookies; retiring it on a block drops
    // the whole burned identity at once. `retryOnBlocked` adds Crawlee's built-in detection of
    // common block responses on top of our AliExpress-specific checks in `routes.ts`.
    useSessionPool: true,
    persistCookiesPerSession: true,
    retryOnBlocked: true,
    sessionPoolOptions: {
        maxPoolSize: config.sessionPool.maxPoolSize,
        sessionOptions: {
            maxUsageCount: config.sessionPool.maxUsageCount,
            maxErrorScore: config.sessionPool.maxErrorScore,
        },
    },

    // --- Browser & stealth ----------------------------------------------------------------
    launchContext: {
        // Use the real Google Chrome from the base image (a genuine Chrome UA + TLS profile is
        // far less suspicious than bundled Chromium).
        useChrome: true,
        launchOptions: {
            headless: false,
            args: CHROME_LAUNCH_ARGS,
        },
    },
    browserPoolOptions: {
        // The fingerprint injector is the single biggest anti-detection lever: it generates a
        // self-consistent real-Chrome fingerprint (UA, navigator, viewport, headers, webdriver
        // hidden) and ties it to each session via the fingerprint cache.
        useFingerprints: true,
        fingerprintOptions: {
            fingerprintGeneratorOptions: FINGERPRINT_OPTIONS,
        },
        // Recycle the browser every few pages so a fresh fingerprint is minted periodically.
        retireBrowserAfterPageCount: config.retireBrowserAfterPageCount,
    },

    // --- Navigation strategy --------------------------------------------------------------
    preNavigationHooks: [
        async ({ page }, gotoOptions) => {
            // Never wait for `networkidle` on AliExpress — it keeps connections open and the
            // event rarely fires, causing needless navigation timeouts. We wait for real
            // product selectors in the handler instead.
            if (gotoOptions) {
                // eslint-disable-next-line no-param-reassign -- mutating gotoOptions is the documented Crawlee way to set navigation options.
                gotoOptions.waitUntil = 'domcontentloaded';
            }
            // Force US timezone/locale (CDP) so they match the en-US fingerprint + US proxy,
            // then layer the extra stealth patches. Both run before navigation.
            await applyRegionOverrides(page);
            await applyStealthInitScript(page);
        },
    ],

    // --- Give-up handling -----------------------------------------------------------------
    failedRequestHandler: async ({ request, log: reqLog }, error) => {
        reqLog.error('Request failed after all retries — giving up.', {
            url: request.url,
            retries: request.retryCount,
            error: error instanceof Error ? error.message : String(error),
        });
        await Actor.pushData({
            url: request.url,
            error: true,
            reason: error instanceof Error ? error.message : String(error),
            retries: request.retryCount,
            capturedAt: new Date().toISOString(),
        });
    },
});

// Gracefully shut down when the run is aborted, to minimize cost on PPU/PPE billing.
Actor.on('aborting', async () => {
    log.info('Abort received — shutting down gracefully.');
    // Brief pause so in-flight state persistence (session pool, useState) can flush.
    await sleep(1_000);
    await Actor.exit();
});

await crawler.run(requestUrls);

// Surface the total number of retries across the whole run. 0 means every URL succeeded on the
// first attempt (no rotation needed) — a quick health signal for how aggressively AliExpress is
// blocking us.
log.info(`Total retried: ${crawler.stats.state.requestsRetries}`);

// It's recommended to quit every Actor with an explicit exit().
await Actor.exit();

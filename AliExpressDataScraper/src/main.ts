// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { setTimeout as sleep } from 'node:timers/promises';

import { PlaywrightCrawler } from '@crawlee/playwright';
// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor, log } from 'apify';

import type { ScraperInput } from './config.js';
// this is an ESM project, so relative imports must include the `.js` extension even from TS.
import { buildConfig } from './config.js';
import { armPdpInterceptor } from './productApi.js';
import { createRouter, rotationStats } from './routes.js';
import { runSellerOnly } from './sellerPipeline.js';
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
    throw new Error('Input "startUrls" must contain at least one AliExpress URL.');
}

// Gracefully shut down when the run is aborted, to minimize cost on PPU/PPE billing. Registered
// here (before the mode branch) so both pipelines honor it.
Actor.on('aborting', async () => {
    log.info('Abort received — shutting down gracefully.');
    // Brief pause so in-flight state persistence (session pool, useState) can flush.
    await sleep(1_000);
    await Actor.exit();
});

// `seller_only` runs on a completely independent browser pipeline — no fingerprint spoofing, no
// proxy (real local IP), and 2captcha-based captcha solving. It does NOT share the product crawler
// below, so we hand off and exit here. See `sellerPipeline.ts`.
if (config.mode === 'seller_only') {
    await runSellerOnly(input, config);
    await Actor.exit();
}

// Product modes: normalize whatever the user pasted (vi./de./m. subdomains, tracking params, …)
// to the canonical https://www.aliexpress.com/item/<id>.html, dropping anything unrecognizable
// and de-duplicating links that point to the same product.
const productUrls = [
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
if (!productUrls.length) {
    throw new Error('No valid AliExpress product URLs found in "startUrls".');
}
const requests = productUrls.map((url) => ({ url }));

// TEST: Apify DATACENTER proxy (default automatic pool — no groups), matching the rented Actor's
// `proxy: {useApifyProxy: true}`. Datacenter is far lower-latency than residential, so each attempt
// is cheap; we accept a higher block rate and lean on fast rotate-and-retry. Revert to
// `{ groups: ['RESIDENTIAL'], countryCode: config.proxyCountry }` for the clean residential path.
const proxyConfiguration = await Actor.createProxyConfiguration({
    countryCode: config.proxyCountry,
});
log.info(`Using Apify datacenter proxy (auto, country ${config.proxyCountry}).`);

// Anti-bot strategy is avoidance + rotation only: a captcha/punish/blocked page retires the
// burned session and retries on a fresh residential IP + fingerprint. We never solve captchas.
log.info('Anti-bot strategy: rotate (blocks retire the session and retry on a fresh IP/fingerprint).');

// Track which browsers we've already logged a fingerprint for, so `postPageCreateHooks` (which runs
// once per page) emits the identity only on the FIRST page of each browser — i.e. once per browser
// start. A fresh browser means a freshly minted fingerprint (see `retireBrowserAfterPageCount`).
const loggedBrowsers = new WeakSet<object>();

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
    // the whole burned identity at once.
    //
    // `retryOnBlocked` is deliberately OFF: routes.ts already detects AliExpress blocks
    // (captcha/punish/empty) and rotates via `rotateAndRetry`. Layering Crawlee's own block
    // detection on top caused it to reclaim+retry a request while our slow handler was still
    // extracting, so under maxConcurrency=2 the SAME product ran in two passes at once — wasting
    // half the run budget. We own block handling; Crawlee should not second-guess it.
    useSessionPool: true,
    persistCookiesPerSession: true,
    retryOnBlocked: false,
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
            // Respect the resolved config (defaults to true). On production we run headless; the
            // seller pipeline already keys off `config.headless`, so this keeps the product crawler
            // consistent instead of hardcoding a headful browser.
            headless: config.headless,
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
        // Apply the US region overrides once per browser start (the first page created on a browser
        // carries its freshly minted fingerprint). The injector spoofs UA/navigator/headers but not
        // timezone — that comes from `applyRegionOverrides`.
        postPageCreateHooks: [
            async (page, browserController) => {
                if (loggedBrowsers.has(browserController)) {
                    return;
                }
                loggedBrowsers.add(browserController);
                await applyRegionOverrides(page);
            },
        ],
    },

    // --- Navigation strategy --------------------------------------------------------------
    preNavigationHooks: [
        async ({ page }, gotoOptions) => {
            // AliExpress decides the price currency from the `aep_usuc_f` locale cookie (and the proxy
            // IP geo), NOT from the `_currency` field in the pdp.pc.query payload — that field is
            // ignored, so a Swedish residential IP yields SEK prices despite `_currency: 'USD'`. Force
            // the cookie before navigation (same lever the seller pipeline uses) to pin USD regardless
            // of which residential IP we land on. Set on both AliExpress domains we touch (.com for
            // navigation, .us for the acs API host).
            const localeCookieValue = `site=glo&c_tp=${config.currency}&region=${config.proxyCountry}&b_locale=${config.language}&ae_u_p_s=2`;
            await page.context().addCookies([
                { name: 'aep_usuc_f', value: localeCookieValue, domain: '.aliexpress.com', path: '/' },
                { name: 'intl_locale', value: config.language, domain: '.aliexpress.com', path: '/' },
                { name: 'aep_usuc_f', value: localeCookieValue, domain: '.aliexpress.us', path: '/' },
                { name: 'intl_locale', value: config.language, domain: '.aliexpress.us', path: '/' },
            ]);
            // We only navigate to bootstrap the anti-bot cookies the signed `pdp.pc.query` call
            // needs, then fetch the product JSON ourselves — so block the heavy subresources
            // (images, fonts, CSS, media) that would otherwise saturate the residential proxy and
            // slow every request. The HTML document + scripts (which set the cookies) and XHR/fetch
            // are left alone. We also arm the pdp.pc.query interceptor as a fallback to the direct call.
            await page.route('**/*', async (route) => {
                const type = route.request().resourceType();
                if (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') {
                    await route.abort();
                    return;
                }
                await route.continue();
            });
            armPdpInterceptor(page);
            // Wait only for `commit` — navigation resolves the instant the document response is
            // received (headers + Set-Cookie processed), WITHOUT waiting for the heavy SPA to
            // parse/execute. We don't need the rendered DOM: the handler fetches the product JSON via
            // the signed API itself. Never `networkidle` (AliExpress holds connections open).
            if (gotoOptions) {
                // eslint-disable-next-line no-param-reassign -- mutating gotoOptions is the documented Crawlee way to set navigation options.
                gotoOptions.waitUntil = 'commit';
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

await crawler.run(requests);

// Surface how many times we hit an anti-bot block and rotated/retried, broken down by reason.
// This counts every block-and-retry event (e.g. each captcha), not just how many requests were
// retried — a true health signal for how aggressively AliExpress is blocking us. 0 across the
// board means every URL passed on the first attempt.
const captchaRetries = rotationStats.captcha ?? 0;
const totalBlockRetries = Object.values(rotationStats).reduce((sum, n) => sum + n, 0);
log.info(`Captcha retries: ${captchaRetries}`, { byReason: rotationStats, totalBlockRetries });

// It's recommended to quit every Actor with an explicit exit().
await Actor.exit();

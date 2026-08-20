// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { setTimeout as sleep } from 'node:timers/promises';

import { PlaywrightCrawler } from '@crawlee/playwright';
// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor, log } from 'apify';

import type { ScraperInput } from './config.js';
// this is an ESM project, so relative imports must include the `.js` extension even from TS.
import { buildConfig, proxyGroupsFor, resolveShipToCountry, storefrontForRequest } from './config.js';
import { armPdpInterceptor } from './productApi.js';
import { pushRecord } from './pushRecord.js';
import { createAliExpressResponse } from './response.js';
import { blockReasonFromError, createRouter, rotationStats } from './routes.js';
import { runSellerOnly } from './sellerPipeline.js';
import { applyRegionOverrides, applyStealthInitScript, CHROME_LAUNCH_ARGS, FINGERPRINT_OPTIONS } from './stealth.js';
import { buildLocaleCookie, parseLocaleCookie } from './storefront.js';
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
//
// Ship-to is resolved from the RAW url FIRST, because normalization drops the query string those
// signals can live in — and it then decides which storefront host the normalized URL points at, so
// the URL we crawl names the same country as the proxy, the timezone and the region cookie. It
// rides on `userData` so each request carries its own region: a run can legitimately mix `es.` and
// `www.` start URLs, and the same item under two regions is two distinct requests.
const productRequests = new Map<string, { url: string; userData: { shipToCountry: string } }>();
for (const { url } of input.startUrls) {
    const shipToCountry = resolveShipToCountry(url, config);
    const normalized = normalizeAliExpressUrl(url, shipToCountry);
    if (!normalized) {
        log.warning(`Skipping non-product AliExpress URL: ${url}`);
        continue;
    }
    if (normalized !== url) {
        log.info(`Normalized URL: ${url} -> ${normalized}`, { shipToCountry });
    }
    // First occurrence wins, so a duplicated product keeps the region it was first seen with.
    if (!productRequests.has(normalized)) {
        productRequests.set(normalized, { url: normalized, userData: { shipToCountry } });
    }
}
if (!productRequests.size) {
    throw new Error('No valid AliExpress product URLs found in "startUrls".');
}
const requests = [...productRequests.values()];
log.info('Resolved ship-to per product URL.', Object.fromEntries([...productRequests].map(([u, r]) => [u, r.userData.shipToCountry])));

/**
 * The ship-to country a request was tagged with in the loop above. Falls back to the default for
 * anything untagged (e.g. the proxy warm-up call Crawlee makes with no request in hand).
 */
function shipToOf(request?: { userData?: Record<string, unknown> }): string {
    const tagged = request?.userData?.shipToCountry;
    return typeof tagged === 'string' && tagged ? tagged : config.defaultShipToCountry;
}

/**
 * Recover the exit country from an Apify proxy URL, whose username encodes it as `country-ES`
 * (see `ProxyConfiguration._getUsername`). Used where a browser is in scope but its request is not.
 */
function countryFromProxyUrl(proxyUrl?: string): string {
    return proxyUrl?.match(/country-([A-Za-z]{2})/)?.[1]?.toUpperCase() ?? config.defaultShipToCountry;
}

// --- Proxy: exit in the country we ship to ------------------------------------------------------
//
// Ship-to and proxy country MUST agree. Forcing `region=ES` in the locale cookie while exiting from
// a US IP is a combination no real buyer produces, and AliExpress answers it with a wall of
// captchas — so instead of one fixed country, each request leaves through its OWN ship-to country.
//
// Mechanically: `newUrlFunction` is called per request with that request in hand (Crawlee calls
// `newProxyInfo(sessionId, { request })` for every page), and browser-pool keys browsers by proxy
// URL — so a mixed-region run transparently gets one browser per country instead of one shared
// browser on the wrong IP. `newUrlFunction` cannot be combined with `countryCode`, so we delegate
// to a real per-country ProxyConfiguration (which also handles the proxy-password bootstrap).
const proxyByCountry = new Map<string, Awaited<ReturnType<typeof Actor.createProxyConfiguration>>>();
async function proxyForCountry(country: string) {
    if (!proxyByCountry.has(country)) {
        const groups = proxyGroupsFor(country, config);
        proxyByCountry.set(
            country,
            await Actor.createProxyConfiguration({
                countryCode: country,
                ...(groups.length ? { groups } : {}),
            }),
        );
        log.info(`Proxy country added: ${country}`, { groups: groups.length ? groups : ['auto (datacenter)'] });
    }
    return proxyByCountry.get(country);
}

const proxyConfiguration = await Actor.createProxyConfiguration({
    newUrlFunction: async (sessionId, options) => {
        const country = shipToOf(options?.request);
        const perCountry = await proxyForCountry(country);
        // Suffix the session id with the country so one Crawlee session can never be handed the
        // same sticky IP for two different regions.
        return (await perCountry?.newUrl(sessionId ? `${sessionId}_${country}` : undefined)) ?? null;
    },
});

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
        // Apply the region overrides once per browser start (the first page created on a browser
        // carries its freshly minted fingerprint). The injector spoofs UA/navigator/headers but not
        // timezone — that comes from `applyRegionOverrides`.
        //
        // There's no request in scope here, but browser-pool keys each browser by its proxy URL, so
        // the browser's OWN proxy country is the authoritative answer — read it back off the URL.
        postPageCreateHooks: [
            async (page, browserController) => {
                if (loggedBrowsers.has(browserController)) {
                    return;
                }
                loggedBrowsers.add(browserController);
                await applyRegionOverrides(page, countryFromProxyUrl(browserController.proxyUrl));
            },
        ],
    },

    // --- Navigation strategy --------------------------------------------------------------
    preNavigationHooks: [
        async ({ page, request }, gotoOptions) => {
            // AliExpress decides the price currency from the `aep_usuc_f` locale cookie (and the proxy
            // IP geo), NOT from the `_currency` field in the pdp.pc.query payload — that field is
            // ignored, so a Swedish residential IP yields SEK prices despite `_currency: 'USD'`. Force
            // the cookie before navigation (same lever the seller pipeline uses) so the session prices
            // in one predictable currency regardless of which residential IP we land on. Set on both
            // AliExpress domains we touch (.com for navigation, .us for the acs API host).
            //
            // `region` is the ship-to: a listing the seller won't ship to the US comes back
            // blocked/empty for a US region no matter how clean the session is, so we replay the region
            // the start URL came from (see `resolveShipToCountry`).
            //
            // `site`/`c_tp`/`b_locale` come from that region's storefront (see `storefront.ts`), so the
            // cookie, the signed MTOP payloads and the host we navigate to all name ONE market. Under
            // `matchStorefrontLocale: false` they collapse back to the global `glo`/USD/en_US identity
            // this hook used to hard-code.
            const shipToCountry = shipToOf(request);
            const storefront = storefrontForRequest(shipToCountry, config);
            // Preserve any province/city AliExpress has already resolved for this session — they are
            // part of the ship-to address and re-writing the cookie without them would throw away a
            // narrower availability answer than the country alone can give.
            const existing = (await page.context().cookies('https://www.aliexpress.com')).find((c) => c.name === 'aep_usuc_f');
            const carried = existing ? parseLocaleCookie(existing.value) : {};
            const localeCookieValue = buildLocaleCookie({
                site: storefront.site,
                province: carried.province ?? '',
                city: carried.city ?? '',
                c_tp: storefront.currency,
                region: shipToCountry,
                b_locale: storefront.locale,
                ae_u_p_s: '2',
            });
            await page.context().addCookies([
                { name: 'aep_usuc_f', value: localeCookieValue, domain: '.aliexpress.com', path: '/' },
                { name: 'intl_locale', value: storefront.locale, domain: '.aliexpress.com', path: '/' },
                { name: 'aep_usuc_f', value: localeCookieValue, domain: '.aliexpress.us', path: '/' },
                { name: 'intl_locale', value: storefront.locale, domain: '.aliexpress.us', path: '/' },
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
            // Force the timezone/locale (CDP) to match this request's proxy exit country, then layer
            // the extra stealth patches. Both run before navigation.
            await applyRegionOverrides(page, shipToCountry);
            await applyStealthInitScript(page);
        },
    ],

    // --- Give-up handling -----------------------------------------------------------------
    // Giving up still produces a record in the SAME shape as a successful one — same envelope, same
    // fields — with `success: false` carrying the why. A separate `{ error: true, … }` shape used to
    // land here, which forced every consumer to branch on record shape before it could read anything;
    // now one boolean answers "did this work" for every row alike.
    failedRequestHandler: async ({ request, log: reqLog }, error) => {
        const message = error instanceof Error ? error.message : String(error);
        reqLog.error('Request failed after all retries — giving up.', {
            url: request.url,
            retries: request.retryCount,
            error: message,
        });
        const shipToCountry = shipToOf(request);
        const response = createAliExpressResponse(request.url);
        response.captureMode = config.mode;
        response.shipToCountry = shipToCountry;
        response.storefront = storefrontForRequest(shipToCountry, config).site;
        response.success = false;
        response.errorCode = 'blocked';
        // The classified reason and the attempt count ride in the text rather than as fields of their
        // own — they are for a human reading a failure, not something a backend switches on.
        // `retryCount` counts RE-tries, so the first attempt has to be added back in.
        const reason = blockReasonFromError(error);
        response.errorMessage = `${reason ? `${reason}: ` : ''}${message} (gave up after ${request.retryCount + 1} attempts)`;
        await pushRecord(response, reqLog);
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

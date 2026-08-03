// A single "warm" browser context for the standby server.
//
// A warm context is one Playwright page on a DEDICATED browser (the BrowserPool runs with
// `maxOpenPagesPerBrowser: 1`, so one page = one browser = one fingerprint = one sticky residential
// IP). It is bootstrapped ONCE — set the locale cookies, block heavy subresources, arm stealth, and
// navigate to the home page so AliExpress mints the `_m_h5_tk` token + anti-bot cookies — and then
// reused for MANY products via the signed `page.request` API (see `extractProduct`) with NO further
// navigation. This amortizes the expensive browser cold-start + proxy handshake across many calls,
// which is the whole point of standby mode.
import { randomBytes } from 'node:crypto';

import type { BrowserPool, PlaywrightPlugin } from '@crawlee/browser-pool';
import type { Log, ProxyConfiguration  } from 'apify';
import type { Page } from 'playwright';

import type { ScraperConfig } from './config.js';
import { classifyPage } from './detection.js';
import { armPdpInterceptor } from './productApi.js';
import { applyRegionOverrides, applyStealthInitScript, readPublicIp } from './stealth.js';
import { HOME_URL } from './url.js';

/** The BrowserPool type our standby server builds (one Playwright/chromium plugin). Parameterized so
 *  `newPage`/`retireBrowserByPage` resolve to Playwright `Page`, not `never`. */
export type StandbyBrowserPool = BrowserPool<{ browserPlugins: PlaywrightPlugin[] }>;

/** One reusable warm browser context leased per request by the {@link WarmPool}. */
export interface WarmContext {
    page: Page;
    /** Proxy sticky-session id; doubles as the BrowserPool page id. Fixed for the context's life. */
    sessionId: string;
    /** The residential proxy URL minted for this context (one sticky IP). */
    proxyUrl: string;
    /** How many requests this context has served — recycled past `maxUsageCount`. */
    useCount: number;
    /** Epoch ms at bootstrap — recycled once older than the sticky-IP TTL. */
    createdAt: number;
    /** Lease guard so a context serves one request at a time. */
    busy: boolean;
}

/** The 4 locale cookies that pin USD/en-US regardless of which residential IP we land on. */
function localeCookies(config: ScraperConfig): { name: string; value: string; domain: string; path: string }[] {
    const value = `site=glo&c_tp=${config.currency}&region=${config.proxyCountry}&b_locale=${config.language}&ae_u_p_s=2`;
    return [
        { name: 'aep_usuc_f', value, domain: '.aliexpress.com', path: '/' },
        { name: 'intl_locale', value: config.language, domain: '.aliexpress.com', path: '/' },
        { name: 'aep_usuc_f', value, domain: '.aliexpress.us', path: '/' },
        { name: 'intl_locale', value: config.language, domain: '.aliexpress.us', path: '/' },
    ];
}

/**
 * Prepare a freshly-created warm page BEFORE its single bootstrap navigation: pin the locale cookies,
 * block heavy subresources (we only navigate to mint cookies — images/CSS/fonts would just saturate
 * the proxy), arm the pdp interceptor, and apply the region/stealth patches. Mirrors the batch
 * crawler's `preNavigationHooks` in `main.ts`.
 */
async function prepareWarmPage(page: Page, config: ScraperConfig): Promise<void> {
    await page.context().addCookies(localeCookies(config));
    await page.route('**/*', async (route) => {
        const type = route.request().resourceType();
        if (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') {
            await route.abort();
            return;
        }
        await route.continue();
    });
    armPdpInterceptor(page);
    await applyRegionOverrides(page);
    await applyStealthInitScript(page);
}

/**
 * Bootstrap a new warm context: launch a dedicated browser on a fresh sticky residential IP, prepare
 * the page, navigate ONCE to the home page (commit only) to mint the anti-bot cookies + `_m_h5_tk`
 * token, and confirm we didn't land on a challenge. Returns `null` (after retiring the browser) when
 * the bootstrap IP was already blocked — the caller simply tries another.
 */
export async function bootstrapWarmContext(
    pool: StandbyBrowserPool,
    proxyConfiguration: ProxyConfiguration,
    config: ScraperConfig,
    log: Log,
): Promise<WarmContext | null> {
    const sessionId = `standby-${randomBytes(8).toString('hex')}`;
    const proxyUrl = await proxyConfiguration.newUrl(sessionId);
    if (!proxyUrl) {
        log.warning('Warm bootstrap: proxy configuration returned no URL.', { sessionId });
        return null;
    }

    let page: Page;
    try {
        page = await pool.newPage({ id: sessionId, proxyUrl });
    } catch (error) {
        log.warning('Warm bootstrap: newPage failed.', { sessionId, error: error instanceof Error ? error.message : String(error) });
        return null;
    }

    try {
        await prepareWarmPage(page, config);
        await page.goto(HOME_URL, { waitUntil: 'commit', timeout: config.navigationTimeoutSecs * 1_000 });

        const status = await classifyPage(page);
        // The home page legitimately has no product content → 'empty' is fine here; only a real
        // challenge (captcha/punish/blocked) means this IP is burned.
        if (status === 'captcha' || status === 'punish' || status === 'blocked') {
            log.warning('Warm bootstrap landed on a challenge — discarding this IP.', { sessionId, status });
            await retireWarmContext(pool, { page }, log);
            return null;
        }

        const ip = await readPublicIp(page);
        log.info('🔥 Warm context ready.', { sessionId, ip });
        return { page, sessionId, proxyUrl, useCount: 0, createdAt: Date.now(), busy: false };
    } catch (error) {
        log.warning('Warm bootstrap threw — discarding this context.', { sessionId, error: error instanceof Error ? error.message : String(error) });
        await retireWarmContext(pool, { page }, log);
        return null;
    }
}

/**
 * Retire a warm context's browser. Best-effort: closing the page and retiring the browser must never
 * throw (the pool keeps running). `retireBrowserByPage` schedules the browser to close once its page
 * is gone — the same primitive `sellerPipeline.ts` uses.
 */
export async function retireWarmContext(pool: StandbyBrowserPool, wc: Pick<WarmContext, 'page'>, log: Log): Promise<void> {
    try {
        pool.retireBrowserByPage(wc.page);
        await wc.page.close().catch(() => undefined);
    } catch (error) {
        log.debug('Retiring warm context errored (ignored).', { error: error instanceof Error ? error.message : String(error) });
    }
}

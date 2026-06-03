// SPIKE: fetch seller info directly from AliExpress's MTOP H5 API instead of click-through scraping.
//
// Endpoint: GET https://acs.aliexpress.com/h5/mtop.ae.shop.seller.page.info/1.0/
// The call is signed with the Alibaba MTOP H5 scheme:
//
//     sign = MD5(`${token}&${t}&${appKey}&${data}`)
//
// where `token` is the part of the `_m_h5_tk` cookie before the `_`, `t` is a millisecond
// timestamp (also sent as the `t` param), `appKey` is the fixed AliExpress H5 key, and `data` is
// the EXACT JSON string sent as the `data` param. (Verified: the sign in a captured real request
// reproduces byte-for-byte with this formula.)
//
// Token dance: the first call on a session that has no `_m_h5_tk` returns `FAIL_SYS_TOKEN_EMPTY`
// but the response sets the cookie, so we re-read the cookie and retry. We run the actual request
// as JSONP via a `<script>` tag injected INTO the warm page — that reuses the session's cookies,
// sticky residential IP and fingerprint, and JSONP sidesteps cross-origin restrictions.
import { createHash } from 'node:crypto';

import type { Log } from 'apify';
import type { Page } from 'playwright';

const APP_KEY = '24815441'; // Fixed AliExpress H5 appKey.
const API = 'mtop.ae.shop.seller.page.info';
const ACS_BASE = `https://acs.aliexpress.com/h5/${API}/1.0/`;
const CALLBACK = 'mtopjsonp_ae_seller';
const MAX_ATTEMPTS = 3; // The token dance needs at most 2; allow a spare for transient errors.

function md5(input: string): string {
    return createHash('md5').update(input).digest('hex');
}

/** Read the MTOP token (the part of `_m_h5_tk` before the `_`) from the session's cookies. */
async function readToken(page: Page): Promise<string> {
    const cookies = await page.context().cookies('https://acs.aliexpress.com').catch(() => []);
    const tk = cookies.find((c) => c.name === '_m_h5_tk');
    return tk ? tk.value.split('_')[0] : '';
}

/**
 * Run a JSONP request from inside the page: inject a `<script src=url>` whose callback resolves the
 * promise with the parsed object. Cleans up the global + element regardless of outcome.
 *
 * NOTE: the page function is passed as a STRING, not a closure. Under `tsx`/esbuild, a closure here
 * gets `keepNames` wrapping (`__name(...)`) injected into its serialized body, which throws
 * `ReferenceError: __name is not defined` in the browser. A plain string is shipped verbatim, so it
 * sidesteps that transform entirely. `url`/`callback` are interpolated as JSON literals.
 */
async function jsonpInPage(page: Page, url: string): Promise<unknown> {
    const cb = JSON.stringify(CALLBACK);
    const src = JSON.stringify(url);
    const expr = `new Promise(function (resolve, reject) {
        var w = window;
        var script = document.createElement('script');
        function cleanup() {
            try { delete w[${cb}]; } catch (e) { w[${cb}] = undefined; }
            script.remove();
        }
        var timer = window.setTimeout(function () { cleanup(); reject(new Error('jsonp timeout')); }, 20000);
        w[${cb}] = function (data) { window.clearTimeout(timer); cleanup(); resolve(data); };
        script.onerror = function () { window.clearTimeout(timer); cleanup(); reject(new Error('jsonp network error')); };
        script.src = ${src};
        document.body.appendChild(script);
    })`;
    return page.evaluate(expr);
}

export interface SellerApiOptions {
    /** Locale/currency/country sent in the `data` payload. Defaults to US/en. */
    locale?: string;
    currency?: string;
    lang?: string;
    country?: string;
}

/**
 * Fetch the raw seller-page-info payload for `sellerId` using the warm page's session.
 *
 * Returns the parsed MTOP response object, or `null` if every attempt failed. The caller decides
 * what to do with it (this spike just logs it in full).
 */
export async function fetchSellerInfo(
    page: Page,
    sellerId: string | number,
    log: Log,
    opts: SellerApiOptions = {},
): Promise<unknown | null> {
    const { locale = 'en_US', currency = 'USD', lang = 'en', country = 'US' } = opts;
    // Key order must stay stable: `data` is hashed verbatim, so the string we sign must equal the
    // string we send.
    const data = JSON.stringify({
        sellerId: Number(sellerId),
        locale,
        _currency: currency,
        _lang: lang,
        _country: country,
        country,
    });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const token = await readToken(page);
        const t = Date.now().toString();
        const sign = md5(`${token}&${t}&${APP_KEY}&${data}`);
        const params = new URLSearchParams({
            jsv: '2.5.1',
            appKey: APP_KEY,
            t,
            sign,
            api: API,
            v: '1.0',
            type: 'jsonp',
            dataType: 'jsonp',
            callback: CALLBACK,
            data,
        });
        const url = `${ACS_BASE}?${params.toString()}`;
        log.info('Seller API request', { attempt, sellerId, hasToken: Boolean(token), t });

        let res: unknown;
        try {
            res = await jsonpInPage(page, url);
        } catch (error) {
            log.warning('Seller API JSONP failed — retrying.', {
                attempt,
                error: error instanceof Error ? error.message : String(error),
            });
            continue;
        }

        const ret = (res as { ret?: unknown[] })?.ret;
        const retStr = Array.isArray(ret) && typeof ret[0] === 'string' ? (ret[0] as string) : '';
        // A token-empty/expired response just set a fresh `_m_h5_tk` cookie; loop to re-read + re-sign.
        if (/TOKEN_EMPTY|TOKEN_EXOIRED|TOKEN_EXPIRED/i.test(retStr)) {
            log.info('Seller API token not ready — cookie set, retrying with fresh token.', { attempt, ret: retStr });
            continue;
        }
        return res;
    }

    return null;
}

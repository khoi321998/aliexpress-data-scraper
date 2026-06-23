// MTOP H5 API client for AliExpress, used for PRODUCT REVIEWS (and the token-prime that they need).
//
// Endpoint base: https://acs.aliexpress.com/h5/<api>/<version>/
// The call is signed with the Alibaba MTOP H5 scheme:
//
//     sign = MD5(`${token}&${t}&${appKey}&${data}`)
//
// where `token` is the part of the `_m_h5_tk` cookie before the `_`, `t` is a millisecond
// timestamp (also sent as the `t` param), `appKey` is the fixed AliExpress H5 key, and `data` is
// the EXACT JSON string sent as the `data` param.
//
// Token dance: the first call on a session that has no `_m_h5_tk` returns `FAIL_SYS_TOKEN_EMPTY`
// but the response sets the cookie, so we re-read the cookie and retry. We run the actual request
// as JSONP via a `<script>` tag injected INTO the warm page — that reuses the session's cookies,
// sticky residential IP and fingerprint, and JSONP sidesteps cross-origin restrictions.
//
// NOTE: seller info/reviews are now scraped from the DOM (see `sellerProfile.ts`); this module is
// kept only for the per-product buyer reviews API.
import { createHash } from 'node:crypto';

import type { Log } from 'apify';
import type { Page } from 'playwright';

const ACS_BASE = 'https://acs.aliexpress.com/h5';
// Per-PRODUCT reviews (the 1–5 star buyer reviews shown on the PDP). Keyed by productId (+ the
// seller id); the `filter` param selects a single star, e.g. "5" → 5-star reviews only.
const PRODUCT_REVIEWS_API = 'mtop.aliexpress.review.pc.list';
const CALLBACK = 'mtopjsonp_ae_reviews';
const MAX_ATTEMPTS = 3; // The token dance needs at most 2; allow a spare for transient errors.

// appKey is PER-API. The product-reviews endpoint tolerates the standard H5 key (12574478); a
// generic default is kept for any other api name.
const DEFAULT_APP_KEY = '24815441';
const APP_KEY_BY_API: Record<string, string> = {
    [PRODUCT_REVIEWS_API]: '12574478',
};

/** The appKey to sign/send for a given API (falls back to the default AliExpress key). */
function appKeyFor(api: string): string {
    return APP_KEY_BY_API[api] ?? DEFAULT_APP_KEY;
}

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
async function jsonpInPage(page: Page, url: string, timeoutMs = 20_000): Promise<unknown> {
    const cb = JSON.stringify(CALLBACK);
    const src = JSON.stringify(url);
    const ms = JSON.stringify(timeoutMs);
    const expr = `new Promise(function (resolve, reject) {
        var w = window;
        var script = document.createElement('script');
        function cleanup() {
            try { delete w[${cb}]; } catch (e) { w[${cb}] = undefined; }
            script.remove();
        }
        var timer = window.setTimeout(function () { cleanup(); reject(new Error('jsonp timeout')); }, ${ms});
        w[${cb}] = function (data) { window.clearTimeout(timer); cleanup(); resolve(data); };
        script.onerror = function () { window.clearTimeout(timer); cleanup(); reject(new Error('jsonp network error')); };
        script.src = ${src};
        document.body.appendChild(script);
    })`;
    return page.evaluate(expr);
}

interface SignedRequest {
    url: string;
    /** The appKey used for this API (per-API; see {@link appKeyFor}). */
    appKey: string;
    /** The millisecond timestamp used in both the `t` param and the sign. */
    t: string;
    /** The computed MD5 signature. */
    sign: string;
    /** The token (from `_m_h5_tk`) that went into the sign — empty string when priming. */
    token: string;
}

/** Build the signed MTOP request for a given API, version, `data` JSON string and token, exposing
 *  the signing inputs/outputs so callers can log them for debugging. The appKey is chosen per-API.
 *  The URL path uses the LOWERCASED api name + version, matching what the browser emits; the
 *  `api`/`v` query params keep their original case/value. */
function buildRequest(api: string, version: string, data: string, token: string): SignedRequest {
    const appKey = appKeyFor(api);
    const t = Date.now().toString();
    const sign = md5(`${token}&${t}&${appKey}&${data}`);
    const params = new URLSearchParams({
        jsv: '2.5.1',
        appKey,
        t,
        sign,
        api,
        v: version,
        type: 'jsonp',
        dataType: 'jsonp',
        callback: CALLBACK,
        data,
    });
    return { url: `${ACS_BASE}/${api.toLowerCase()}/${version}/?${params.toString()}`, appKey, t, sign, token };
}

/**
 * Sign + run a single MTOP call from the warm page, with the token dance. `dataObj` is stringified
 * ONCE and that exact string is both signed and sent. Returns the parsed response, or `null` if
 * every attempt failed.
 */
async function callMtop(
    page: Page,
    api: string,
    dataObj: Record<string, unknown>,
    log: Log,
    version = '1.0',
): Promise<unknown | null> {
    const data = JSON.stringify(dataObj);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const token = await readToken(page);
        const req = buildRequest(api, version, data, token);

        let res: unknown;
        try {
            res = await jsonpInPage(page, req.url);
        } catch (error) {
            log.warning('MTOP JSONP failed — retrying.', {
                api,
                attempt,
                error: error instanceof Error ? error.message : String(error),
            });
            continue;
        }

        const ret = (res as { ret?: unknown[] })?.ret;
        const retStr = Array.isArray(ret) && typeof ret[0] === 'string' ? (ret[0] as string) : '';
        // A token-empty/expired response just set a fresh `_m_h5_tk` cookie; loop to re-read + re-sign.
        if (/TOKEN_EMPTY|TOKEN_EXOIRED|TOKEN_EXPIRED/i.test(retStr)) {
            log.info('MTOP token not ready — cookie set, retrying with fresh token.', { api, attempt, ret: retStr });
            continue;
        }
        return res;
    }

    return null;
}

/**
 * Proactively mint the `_m_h5_tk` token by firing ONE throwaway MTOP call early (right after the
 * page settles). A request with no valid token returns `FAIL_SYS_TOKEN_EMPTY` but the response
 * sets the `_m_h5_tk` cookie — so afterwards the real reviews call reads a ready token and succeeds
 * on its first attempt instead of paying the in-loop token dance at extraction time.
 *
 * Best-effort and idempotent: if a token already exists we skip, and any error is swallowed (the
 * normal token dance in {@link fetchProductReviews} still covers us).
 */
export async function primeMtopToken(page: Page, log: Log): Promise<boolean> {
    if (await readToken(page)) {
        log.info('MTOP token prime — already present, skipping.');
        return true;
    }
    // A minimal payload is enough; the call fails with TOKEN_EMPTY before the body is validated, and
    // that failing response is exactly what sets the cookie.
    const data = JSON.stringify({ productId: '0', page: 1, pageSize: 1, _lang: 'en_US', filter: '', sort: 'complex_default', country: 'US', clientType: 'web' });
    const req = buildRequest(PRODUCT_REVIEWS_API, '1.0', data, '');
    log.info('MTOP token prime — request', { appKey: req.appKey, token: req.token, t: req.t, sign: req.sign, url: req.url });
    try {
        // Short timeout: priming is best-effort and the reviews call's own token dance covers a miss,
        // so we never want to block the handler for the full JSONP budget just to warm the cookie.
        await jsonpInPage(page, req.url, 6_000);
    } catch (error) {
        log.warning('MTOP token prime — JSONP failed (will fall back to in-loop dance).', {
            error: error instanceof Error ? error.message : String(error),
        });
    }
    const primed = Boolean(await readToken(page));
    log.info('MTOP token prime', { primed });
    return primed;
}

export interface SellerApiOptions {
    /** Locale/currency/country sent in the `data` payload. Defaults to US/en. */
    locale?: string;
    currency?: string;
    lang?: string;
    country?: string;
}

/**
 * Fetch a page of a PRODUCT's buyer reviews (`mtop.aliexpress.review.pc.list`). Keyed by `productId`
 * and the seller id (`sellerAdminSeq`). `filter` selects a single star rating ("1".."5"); pass an
 * empty string (the default) for all stars. Returns the raw MTOP response, or `null` on failure.
 */
export async function fetchProductReviews(
    page: Page,
    productId: string | number,
    sellerAdminSeq: string | number | null,
    log: Log,
    opts: SellerApiOptions & { page?: number; pageSize?: number; filter?: string | number; sort?: string } = {},
): Promise<unknown | null> {
    const {
        locale = 'en_US',
        country = 'US',
        page: pageNum = 1,
        pageSize = 10,
        filter = '',
        sort = 'complex_default',
    } = opts;
    const data: Record<string, unknown> = {
        productId: String(productId),
        page: pageNum,
        pageSize,
        _lang: locale,
        filter: String(filter),
        sort,
        country,
        clientType: 'web',
    };
    // Only include the seller id when we actually have it — some PDPs are scraped before the seller
    // ref is resolved, and the endpoint still returns reviews keyed by productId alone.
    if (sellerAdminSeq != null && sellerAdminSeq !== '') {
        data.sellerAdminSeq = Number(sellerAdminSeq);
    }
    return callMtop(page, PRODUCT_REVIEWS_API, data, log);
}

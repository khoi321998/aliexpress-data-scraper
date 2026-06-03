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

const ACS_BASE = 'https://acs.aliexpress.com/h5';
const SELLER_INFO_API = 'mtop.ae.shop.seller.page.info';
const PRODUCT_GROUP_API = 'mtop.ae.shop.search.product.group';
const EVALUATION_API = 'evaluation.productEvaluation';
const EVALUATION_VERSION = '102'; // This API is versioned 102, not 1.0.
const CALLBACK = 'mtopjsonp_ae_seller';
const MAX_ATTEMPTS = 3; // The token dance needs at most 2; allow a spare for transient errors.

// appKey is PER-API. The lenient "info" endpoints tolerate the current key, but the risk-controlled
// search endpoint (search.product.group) flags a wrong/foreign appKey and responds with an RGV587
// anti-bot challenge — so it MUST use a real AliExpress key (24815441).
const DEFAULT_APP_KEY = '24815441';
const APP_KEY_BY_API: Record<string, string> = {
    [SELLER_INFO_API]: '12574478',
    [PRODUCT_GROUP_API]: '24815441',
    [EVALUATION_API]: '24815441',
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
 *  The URL path uses the LOWERCASED api name + version (e.g. `/h5/evaluation.productevaluation/102/`),
 *  matching what the browser emits; the `api`/`v` query params keep their original case/value. */
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
 * ONCE and that exact string is both signed and sent. Logs the signing inputs/outputs each attempt.
 * Returns the parsed response, or `null` if every attempt failed.
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
        log.info('MTOP request', {
            api,
            attempt,
            hasToken: Boolean(token),
            appKey: req.appKey,
            token: req.token,
            t: req.t,
            sign: req.sign,
            data,
            url: req.url,
        });

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

/** Read a single cookie value by name from the session (e.g. `cna`, used as `cookieId`). Searches
 *  ALL cookies in the context so it finds the value regardless of which `.aliexpress.com` host/path
 *  it was set on. */
async function readCookie(page: Page, name: string): Promise<string> {
    const cookies = await page.context().cookies().catch(() => []);
    return cookies.find((c) => c.name === name)?.value ?? '';
}

/**
 * Proactively mint the `_m_h5_tk` token by firing ONE throwaway MTOP call early (right after the
 * page settles). A request with no valid token returns `FAIL_SYS_TOKEN_EMPTY` but the response
 * sets the `_m_h5_tk` cookie — so afterwards the real seller call reads a ready token and succeeds
 * on its first attempt instead of paying the in-loop token dance at extraction time.
 *
 * Best-effort and idempotent: if a token already exists we skip, and any error is swallowed (the
 * normal token dance in {@link fetchSellerInfo} still covers us).
 */
export async function primeMtopToken(page: Page, log: Log): Promise<boolean> {
    if (await readToken(page)) {
        log.info('MTOP token prime — already present, skipping.');
        return true;
    }
    // A minimal payload is enough; the call fails with TOKEN_EMPTY before the body is validated, and
    // that failing response is exactly what sets the cookie.
    const data = JSON.stringify({ sellerId: 0, locale: 'en_US', _currency: 'USD', _lang: 'en', _country: 'US', country: 'US' });
    const req = buildRequest(SELLER_INFO_API, '1.0', data, '');
    log.info('MTOP token prime — request', { appKey: req.appKey, token: req.token, t: req.t, sign: req.sign, data, url: req.url });
    try {
        await jsonpInPage(page, req.url);
    } catch (error) {
        log.warning('MTOP token prime — JSONP failed (will fall back to in-loop dance).', {
            error: error instanceof Error ? error.message : String(error),
        });
    }
    const primed = Boolean(await readToken(page));
    log.info('MTOP token prime', { primed });
    return primed;
}

/** Coerce a value that may be a number or numeric string (e.g. "94.5") to a number, else null. */
function toNumber(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value.replace('%', '').trim());
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/** Narrow an unknown to a plain object for safe property access; non-objects become `{}`. */
function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** A store-credibility score row, e.g. { title: "store rating", value: 4.9 }. */
export interface SellerScore {
    title: string;
    value: number | null;
}

/** The useful, typed fields parsed out of a raw `seller.page.info` response. */
export interface ParsedSellerInfo {
    /** Positive-feedback percentage, e.g. 94.5. */
    positiveFeedbackPercent: number | null;
    /** 6-month review counts. */
    positiveCount: number | null;
    neutralCount: number | null;
    negativeCount: number | null;
    totalCount: number | null;
    /** Store-credibility scores (store rating / items as described / communication / shipping). */
    scores: SellerScore[];
    storeName: string | null;
    /** The internal store number — this is the `storeId` that `benefit.info` needs. */
    storeNum: string | null;
    countryCode: string | null;
    followersText: string | null;
    openedSinceText: string | null;
    storeLogo: string | null;
}

/**
 * Parse the useful seller fields out of a raw `seller.page.info` response, or `null` if the shape
 * isn't recognized (e.g. an error `ret`). All fields are individually optional — a missing one is
 * `null` rather than throwing.
 */
export function parseSellerInfo(res: unknown): ParsedSellerInfo | null {
    const data = asRecord(asRecord(res).data);
    if (Object.keys(data).length === 0) {
        return null;
    }
    const be = asRecord(data.buyerEvaluationInfo);
    const sb = asRecord(data.sellerBaseInfo);
    const scores = Array.isArray(data.operatingScoreInfoList)
        ? data.operatingScoreInfoList.map((row) => {
              const r = asRecord(row);
              return { title: typeof r.title === 'string' ? r.title : '', value: toNumber(r.value) };
          })
        : [];

    return {
        positiveFeedbackPercent: toNumber(be.positiveFeedBackValue),
        positiveCount: toNumber(be.totalPositiveSixMonths),
        neutralCount: toNumber(be.totalNeutralSixMonths),
        negativeCount: toNumber(be.totalNegativeSixMonths),
        totalCount: toNumber(be.totalNumSixMonths),
        scores,
        storeName: typeof sb.storeName === 'string' ? sb.storeName : null,
        storeNum: typeof sb.storeNum === 'string' ? sb.storeNum : null,
        countryCode: typeof sb.countryCode === 'string' ? sb.countryCode : null,
        followersText: typeof sb.follows === 'string' ? sb.follows : null,
        openedSinceText: typeof sb.since === 'string' ? sb.since : null,
        storeLogo: typeof sb.storeLogo === 'string' ? sb.storeLogo : null,
    };
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
    return callMtop(
        page,
        SELLER_INFO_API,
        { sellerId: Number(sellerId), locale, _currency: currency, _lang: lang, _country: country, country },
        log,
    );
}

/**
 * Fetch a page of the seller's product evaluations / reviews (`evaluation.productEvaluation`, v102).
 * Keyed by `sellerAdminSeq` (= the seller id). Returns the raw MTOP response, or `null` on failure.
 */
export async function fetchProductEvaluation(
    page: Page,
    sellerAdminSeq: string | number,
    log: Log,
    opts: SellerApiOptions & { page?: number; pageSize?: number; filter?: number; sort?: string } = {},
): Promise<unknown | null> {
    const {
        locale = 'en_US',
        currency = 'USD',
        lang = 'en',
        country = 'US',
        page: pageNum = 1,
        pageSize = 20,
        filter = 5,
        sort = 'complex_default',
    } = opts;
    return callMtop(
        page,
        EVALUATION_API,
        {
            page: pageNum,
            pageSize,
            filter,
            sort,
            sellerAdminSeq: Number(sellerAdminSeq),
            locale,
            _currency: currency,
            _lang: lang,
            _country: country,
            country,
            platform: 'web',
        },
        log,
        EVALUATION_VERSION,
    );
}

/** A lightweight preview of one of a seller's products, parsed from `search.product.group`. */
export interface SellerProductPreview {
    productId: string;
    title: string | null;
    url: string | null;
    imageUrl: string | null;
    /** Current (promotion) price as a number, plus the original price and currency. */
    price: number | null;
    originalPrice: number | null;
    currency: string | null;
    /** Pre-formatted price string as shown on the page, e.g. "₫ 28,686". */
    priceText: string | null;
    rating: number | null;
    reviewCount: number | null;
    orders: number | null;
    /** Free-text sales label, e.g. "1,000+". */
    salesText: string | null;
}

/**
 * Fetch a page of the seller's store products (`search.product.group`). Needs the seller id and the
 * store number (`storeNum` from {@link fetchSellerInfo}); `cookieId` (the `cna` cookie) is optional
 * tracking context. Returns the raw MTOP response, or `null` on failure.
 */
export async function fetchSellerProducts(
    page: Page,
    sellerId: string | number,
    storeNumber: string | number,
    log: Log,
    opts: SellerApiOptions & { pageSize?: number; cookieId?: string } = {},
): Promise<unknown | null> {
    const { locale = 'en_US', currency = 'USD', lang = 'en', country = 'US', pageSize = 40 } = opts;
    const cookieId = opts.cookieId ?? (await readCookie(page, 'cna'));
    return callMtop(
        page,
        PRODUCT_GROUP_API,
        {
            locale,
            country,
            currency,
            lang,
            buyerId: 0,
            currentPage: 1,
            productGroupId: '',
            pageSize,
            sellerId: Number(sellerId),
            site: 'glo',
            storeNumber: Number(storeNumber),
            platform: 'pc',
            sortType: 'bestmatch_sort',
            filterType: '',
            searchText: '',
            cookieId,
        },
        log,
    );
}

/** Promote a protocol-relative URL (`//host/…`) to https; pass other strings through, null stays null. */
function toHttps(url: string | null): string | null {
    if (!url) {
        return null;
    }
    return url.startsWith('//') ? `https:${url}` : url;
}

/**
 * Parse up to `limit` product previews out of a raw `search.product.group` response. Returns an
 * empty array if the shape isn't recognized.
 */
export function parseSellerProducts(res: unknown, limit = 10): SellerProductPreview[] {
    const items = asRecord(asRecord(res).data).data;
    if (!Array.isArray(items)) {
        return [];
    }
    return items.slice(0, limit).map((raw) => {
        const p = asRecord(raw);
        const prices = asRecord(p.prices);
        const promo = asRecord(prices.promotionPiecePrice);
        const piece = asRecord(prices.piecePrice);
        const evaluate = asRecord(p.evaluateInfo);
        const id = p.id != null ? String(p.id) : '';
        return {
            productId: id,
            title: typeof p.subject === 'string' ? p.subject : typeof p.seoTitle === 'string' ? p.seoTitle : null,
            url: toHttps(typeof p.pcDetailUrl === 'string' ? p.pcDetailUrl : null),
            imageUrl:
                typeof p.image350Url === 'string'
                    ? p.image350Url
                    : typeof p.scaleImageUrl === 'string'
                      ? p.scaleImageUrl
                      : null,
            price: toNumber(promo.amount) ?? toNumber(piece.amount),
            originalPrice: toNumber(piece.amount),
            currency: typeof piece.currencyCode === 'string' ? piece.currencyCode : null,
            priceText: typeof p.formatedPromotionPiecePriceStr === 'string' ? p.formatedPromotionPiecePriceStr : null,
            rating: toNumber(p.averageStar) ?? toNumber(evaluate.starRating),
            reviewCount: toNumber(p.feedbacks),
            orders: toNumber(p.orders),
            salesText: typeof p.sales === 'string' ? p.sales : null,
        };
    });
}

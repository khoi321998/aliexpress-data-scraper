// API-based seller extraction — the seller counterpart of `productApi.ts`.
//
// The AliExpress store pages (all-items / feedback) are client-side React apps whose data arrives
// over a handful of XHRs. Instead of rendering those SPAs and scraping the DOM, we:
//   1. resolve the REAL seller id (`sellerId` / `sellerAdminSeq`) — it is NOT the `/store/<id>` path
//      id. It rides in `renderPageData.htm`'s `result.pageData.globalData.sellerId`, which the store
//      page fires on load; we intercept that response (armed before navigation), with a request.get
//      fallback once the page's anti-bot cookies are warm.
//   2. fetch the seller profile via `mtop.ae.shop.seller.page.info` (ONE signed MTOP call carries the
//      credibility scores, positive %, review counts, country, "open since", store name + logo).
//
// Signing mirrors the product path (Alibaba MTOP H5): `sign = MD5(token & t & appKey & data)`, where
// `token` is the part of the `_m_h5_tk` cookie before `_`. The seller endpoints live on the
// `acs.aliexpress.com` gateway (the product PDP uses `acs.aliexpress.us`), and each uses its own
// per-API appKey. The first tokenless call returns `FAIL_SYS_TOKEN_EMPTY` but sets the cookie, so we
// re-read it and retry — the same token dance `productApi.ts` uses.
import { createHash } from 'node:crypto';

import type { Log } from 'apify';
import type { Page } from 'playwright';

/** MTOP H5 gateway for the seller endpoints (the `.com` gateway, unlike the PDP's `.us`). */
const ACS_BASE = 'https://acs.aliexpress.com/h5';
/** The store page-data JSONP endpoint that carries `globalData.sellerId`. */
const RENDER_PAGE_DATA_RE = /renderPageData\.htm/i;
/** Per-API H5 appKey for `mtop.ae.shop.seller.page.info`. */
const SHOP_INFO_APP_KEY = '24770048';
const SHOP_INFO_API = 'mtop.ae.shop.seller.page.info';

/** One credibility score row, e.g. { title: "store rating", value: 4.9 }. */
export interface SellerScore {
    title: string;
    value: number | null;
}

/** Seller profile parsed from `mtop.ae.shop.seller.page.info` (mirrors the old DOM feedback shape). */
export interface SellerInfo {
    storeName: string | null;
    countryName: string | null;
    /** "Opened since" text as shown, e.g. "From May 21, 2019". */
    openedSinceText: string | null;
    /** Followers text as shown, e.g. "503.6K followers". */
    followersText: string | null;
    storeLogo: string | null;
    positiveFeedbackPercent: number | null;
    positiveCount: number | null;
    neutralCount: number | null;
    negativeCount: number | null;
    /** Total customer reviews ("Customer reviews (N)"). */
    totalCount: number | null;
    /** Store rating + the three credibility sub-scores, in display order. */
    scores: SellerScore[];
}

/** Narrow an unknown to a plain object; non-objects become `{}`. */
function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** First number (commas stripped) in a string, e.g. "96.7" → 96.7, "1,895" → 1895, "(389)" → 389. */
function num(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value !== 'string') {
        return null;
    }
    const m = value.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
}

/** Trim a string; null/empty/non-string become null. */
function toStr(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Promote `//host/…` / `http://…` URLs to https; non-strings → null. */
export function toHttps(url: unknown): string | null {
    if (typeof url !== 'string' || url.trim() === '') {
        return null;
    }
    const u = url.trim();
    if (u.startsWith('//')) return `https:${u}`;
    if (u.startsWith('http://')) return `https://${u.slice('http://'.length)}`;
    return u;
}

function md5(input: string): string {
    return createHash('md5').update(input).digest('hex');
}

/** Read the MTOP token (part of `_m_h5_tk` before the `_`) from the `.com` gateway cookie jar. */
async function readMtopToken(page: Page): Promise<string> {
    const cookies = await page.context().cookies(ACS_BASE).catch(() => []);
    const tk = cookies.find((c) => c.name === '_m_h5_tk');
    return tk ? tk.value.split('_')[0] : '';
}

/**
 * Sign + fire ONE MTOP H5 call on the seller gateway through the page's request context, with the
 * token dance. `data` is the EXACT JSON string that is both signed and sent. Returns the parsed
 * response object, or `null` on a non-JSON body (a block) / transport failure. Callers inspect
 * `ret` / `data` to tell block from success.
 */
export async function callSellerMtop(
    page: Page,
    api: string,
    appKey: string,
    data: string,
    log: Log,
    version = '1.0',
): Promise<Record<string, unknown> | null> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const token = await readMtopToken(page);
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
            callback: 'mtopjsonp',
            data,
        });
        const url = `${ACS_BASE}/${api}/${version}/?${params.toString()}`;

        let body: string;
        try {
            const res = await page.request.get(url, {
                timeout: 15_000,
                headers: { referer: 'https://www.aliexpress.com/', origin: 'https://www.aliexpress.com' },
            });
            body = await res.text();
        } catch (error) {
            log.warning('seller MTOP request failed — retrying.', { api, attempt, error: error instanceof Error ? error.message : String(error) });
            continue;
        }

        let json: Record<string, unknown>;
        try {
            json = JSON.parse(body.replace(/^\s*\w+\(/, '').replace(/\)\s*;?\s*$/, ''));
        } catch {
            log.warning('seller MTOP non-JSON body (likely block).', { api, attempt, snippet: body.slice(0, 120) });
            return null;
        }

        const { ret } = json as { ret?: unknown[] };
        const retStr = Array.isArray(ret) && typeof ret[0] === 'string' ? (ret[0] as string) : '';
        // Token not ready: the response just set a fresh `_m_h5_tk` cookie; loop to re-read + re-sign.
        if (/TOKEN_EMPTY|TOKEN_EXPIRED|TOKEN_EXOIRED/i.test(retStr)) {
            continue;
        }
        return json;
    }
    return null;
}

// --- sellerId resolution (from renderPageData.htm globalData) ------------------------------------

/** What we lift out of a `renderPageData.htm` payload. */
export interface ResolvedStore {
    sellerId: string;
    /** The `/store/<id>` path id (globalData.shopId), when present. */
    shopId: string | null;
    storeName: string | null;
}

/** Per-page holder for the intercepted renderPageData result (latest valid wins, e.g. post-captcha reload). */
const sellerIdWaiters = new WeakMap<Page, { resolved: ResolvedStore | null }>();

/** Strip the JSONP wrapper, parse, and lift `globalData.sellerId` (+ shopId / storeName). */
export function extractStoreFromRenderPageData(body: string): ResolvedStore | null {
    // Punish/recaptcha bodies have no globalData — bail fast.
    if (/_____tmd_____|x5secdata|getpunishpage/i.test(body.slice(0, 400))) {
        return null;
    }
    try {
        const json = JSON.parse(body.replace(/^\s*\w+\(/, '').replace(/\)\s*;?\s*$/, ''));
        const globalData = asRecord(asRecord(asRecord(asRecord(json).result).pageData).globalData);
        const sellerId = globalData.sellerId ?? globalData.bizId;
        if (sellerId != null && String(sellerId).trim() !== '') {
            return {
                sellerId: String(sellerId),
                shopId: globalData.shopId != null ? String(globalData.shopId) : null,
                storeName: toStr(globalData.storeName),
            };
        }
    } catch {
        // fall through to the regex fallback
    }
    // Regex fallback for a partially-readable / differently-wrapped body.
    const m = body.match(/"sellerId"\s*:\s*"?(\d{6,})/);
    if (m) {
        const name = body.match(/"storeName"\s*:\s*"([^"]{1,80})"/);
        const shop = body.match(/"shopId"\s*:\s*"?(\d{3,})/);
        return { sellerId: m[1], shopId: shop ? shop[1] : null, storeName: name ? name[1] : null };
    }
    return null;
}

/**
 * Arm the renderPageData interceptor on a page BEFORE navigation. Every valid payload overwrites the
 * stored value, so a post-captcha reload's data wins over the punished first load. Idempotent per page.
 */
export function armSellerIdInterceptor(page: Page): void {
    if (sellerIdWaiters.has(page)) {
        return;
    }
    const waiter = { resolved: null as ResolvedStore | null };
    sellerIdWaiters.set(page, waiter);
    page.on('response', async (res) => {
        if (!RENDER_PAGE_DATA_RE.test(res.url())) {
            return;
        }
        let body: string;
        try {
            body = await res.text();
        } catch {
            return;
        }
        const resolved = extractStoreFromRenderPageData(body);
        if (resolved) {
            waiter.resolved = resolved;
        }
    });
}

/** Return the intercepted store info if already captured (no waiting). */
export function getInterceptedSellerId(page: Page): ResolvedStore | null {
    return sellerIdWaiters.get(page)?.resolved ?? null;
}

/**
 * Resolve the seller id for a store. Order:
 *   1. the value intercepted from renderPageData during navigation (polled up to `timeoutMs`),
 *   2. a direct request.get of renderPageData (works once the page's anti-bot cookies are warm).
 * Returns `null` when neither yields an id (caller treats as blocked).
 */
export async function resolveSellerId(page: Page, pathId: string, log: Log, timeoutMs = 8_000): Promise<ResolvedStore | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const hit = getInterceptedSellerId(page);
        if (hit) {
            log.info('sellerId resolved (intercepted renderPageData)', { sellerId: hit.sellerId, shopId: hit.shopId });
            return hit;
        }
        await page.waitForTimeout(500);
    }
    // Fallback: fetch renderPageData ourselves (the store page's baxia cookies are warm by now).
    const url = `https://www.aliexpress.com/store/lego/pc/api/renderPageData.htm?storeId=${pathId}&pageId=0&language=english&currency=USD&country=US&pagePath=index.htm&extParams=null&callback=jsonpCallbackFunction`;
    try {
        const res = await page.request.get(url, {
            timeout: 15_000,
            headers: { referer: `https://www.aliexpress.com/store/${pathId}`, 'sec-fetch-dest': 'script', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'same-origin' },
        });
        const resolved = extractStoreFromRenderPageData(await res.text());
        if (resolved) {
            log.info('sellerId resolved (renderPageData request.get)', { sellerId: resolved.sellerId, shopId: resolved.shopId });
            return resolved;
        }
        log.warning('renderPageData returned no sellerId (likely still behind a captcha).');
    } catch (error) {
        log.warning('renderPageData fetch failed.', { error: error instanceof Error ? error.message : String(error) });
    }
    return null;
}

// --- seller.page.info (credibility + counts + base info) ----------------------------------------

/** Build the `data` payload for `mtop.ae.shop.seller.page.info`. */
function buildShopInfoData(sellerId: string, language: string, currency: string, country: string): string {
    return JSON.stringify({
        sellerId: Number(sellerId),
        locale: language,
        _currency: currency,
        _lang: language.split('_')[0] || 'en',
        _country: country,
        country,
    });
}

/** Map one `seller.page.info` `data` block into our {@link SellerInfo}. */
export function parseSellerInfo(data: Record<string, unknown>): SellerInfo {
    const evalInfo = asRecord(data.buyerEvaluationInfo);
    const base = asRecord(data.sellerBaseInfo);
    const scoreList = Array.isArray(data.operatingScoreInfoList) ? data.operatingScoreInfoList : [];

    return {
        storeName: toStr(base.storeName),
        countryName: toStr(base.countryName),
        openedSinceText: toStr(base.since),
        followersText: toStr(base.follows),
        storeLogo: toHttps(base.storeLogo),
        positiveFeedbackPercent: num(evalInfo.positiveFeedBackValue),
        positiveCount: num(evalInfo.totalPositiveSixMonths),
        neutralCount: num(evalInfo.totalNeutralSixMonths),
        negativeCount: num(evalInfo.totalNegativeSixMonths),
        totalCount: num(evalInfo.totalNumSixMonths),
        scores: scoreList
            .map((s) => {
                const r = asRecord(s);
                return { title: toStr(r.title) ?? '', value: num(r.value) };
            })
            .filter((s) => s.title !== ''),
    };
}

/**
 * Fetch + parse the seller profile via `mtop.ae.shop.seller.page.info`. Returns `null` when the call
 * is blocked / yields no data (caller falls back to whatever else it has).
 */
export async function fetchSellerInfo(
    page: Page,
    sellerId: string,
    log: Log,
    opts: { language: string; currency: string; country: string },
): Promise<SellerInfo | null> {
    const json = await callSellerMtop(page, SHOP_INFO_API, SHOP_INFO_APP_KEY, buildShopInfoData(sellerId, opts.language, opts.currency, opts.country), log);
    const data = asRecord(asRecord(json).data);
    if (!json || Object.keys(data).length === 0 || (!data.buyerEvaluationInfo && !data.sellerBaseInfo)) {
        const { ret } = asRecord(json) as { ret?: unknown[] };
        log.warning('seller.page.info — no data (block/empty).', { ret: Array.isArray(ret) ? ret[0] : null });
        return null;
    }
    const info = parseSellerInfo(data);
    log.info('seller info fetched (API)', { storeName: info.storeName, positiveFeedbackPercent: info.positiveFeedbackPercent, scores: info.scores.length });
    return info;
}

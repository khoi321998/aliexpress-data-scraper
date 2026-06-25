// API-based product extraction — the fast path.
//
// The AliExpress PC product page is a client-side React app: the HTML ships almost no data
// (`window.runParams` is empty, `isCSR=true`), and ALL product fields arrive in a single XHR to
// the MTOP endpoint `mtop.aliexpress.pdp.pc.query`. Rather than render the page, wait for hydration
// and scrape the DOM (40–50s/attempt), we let the page fire that one signed request on load and
// INTERCEPT its response (~6–10s/attempt). The browser computes the sign/token/ext itself, so we
// never replicate the signing scheme — we just parse the JSON it already fetched.
//
// One `result` object carries every module we need:
//   PRODUCT_TITLE.text · PRICE.{skuPriceInfoMap,targetSkuPriceInfo} · HEADER_IMAGE_PC ·
//   PRODUCT_PROP_PC.showedProps · QUANTITY_PC.totalAvailableInventory · PC_RATING ·
//   SHIPPING.deliveryLayoutInfo · SHOP_CARD_PC · DESC.pcDescUrl
// Description HTML lives behind DESC.pcDescUrl (a static signed URL), fetched separately.
import { createHash, randomBytes } from 'node:crypto';

import type { Log } from 'apify';
import type { Page } from 'playwright';

import { parseCurrency, parsePrice } from './pricing.js';
import { parseProductReviews } from './reviewsApi.js';
import type { Description, Media, Pricing, ReviewSample, ReviewsSummary, SellerRef, Shipping, Specification, Stock } from './types.js';

/** The MTOP API that returns the full PC product payload. */
const PDP_QUERY_RE = /mtop\.aliexpress\.pdp\.pc\.query/i;
const PDP_API = 'mtop.aliexpress.pdp.pc.query';
/** Per-product buyer-reviews API (overall rating + per-star samples). */
const REVIEWS_API = 'mtop.aliexpress.review.pc.list';
/** Per-API H5 appKey (the PC product + reviews endpoints share this key). */
const PDP_APP_KEY = '12574478';
/** MTOP H5 endpoint base on the US gateway (matches the `.us` PDP the page redirects to). */
const ACS_BASE = 'https://acs.aliexpress.us/h5';

/** Per-page holder for the intercepted pdp.pc.query JSON, resolved by the response listener. */
interface PdpWaiter {
    promise: Promise<Record<string, unknown> | null>;
    settle: (value: Record<string, unknown> | null) => void;
    settled: boolean;
}
const pdpWaiters = new WeakMap<Page, PdpWaiter>();

/** Narrow an unknown to a plain object; non-objects become `{}`. */
function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Promote `//host/…` / `http://…` URLs to https; non-strings → null. */
function toHttps(url: unknown): string | null {
    if (typeof url !== 'string' || url.trim() === '') {
        return null;
    }
    const u = url.trim();
    if (u.startsWith('//')) return `https:${u}`;
    if (u.startsWith('http://')) return `https://${u.slice('http://'.length)}`;
    return u;
}

/**
 * Arm the pdp.pc.query interceptor on a page BEFORE navigation. The first "full" response (the
 * token-empty retry returns a tiny error body, so we wait for a sizable one) is parsed and resolves
 * {@link waitForPdpResult}. Idempotent per page.
 */
export function armPdpInterceptor(page: Page): void {
    if (pdpWaiters.has(page)) {
        return;
    }
    let settle!: (value: Record<string, unknown> | null) => void;
    const promise = new Promise<Record<string, unknown> | null>((resolve) => {
        settle = resolve;
    });
    const waiter: PdpWaiter = { promise, settle, settled: false };
    pdpWaiters.set(page, waiter);

    page.on('response', async (res) => {
        if (waiter.settled || !PDP_QUERY_RE.test(res.url())) {
            return;
        }
        let body: string;
        try {
            body = await res.text();
        } catch {
            return;
        }
        // The token-empty bootstrap reply is a few hundred bytes; the real payload is tens of KB.
        if (body.length < 5_000) {
            return;
        }
        try {
            const json = JSON.parse(body.replace(/^\s*\w+\(/, '').replace(/\)\s*;?\s*$/, ''));
            const result = asRecord(asRecord(asRecord(json).data).result);
            if (Object.keys(result).length > 0) {
                waiter.settled = true;
                waiter.settle(result);
            }
        } catch {
            // Malformed/partial — ignore and wait for a cleaner one.
        }
    });
}

/**
 * Await the intercepted pdp.pc.query `result` object, or `null` if it doesn't arrive within
 * `timeoutMs` (treated as a block/empty by the caller, which then rotates). Returns `null` if the
 * interceptor was never armed for this page.
 */
export async function waitForPdpResult(page: Page, timeoutMs: number): Promise<Record<string, unknown> | null> {
    const waiter = pdpWaiters.get(page);
    if (!waiter) {
        return null;
    }
    let timer: NodeJS.Timeout;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const result = await Promise.race([waiter.promise, timeout]);
    clearTimeout(timer!);
    return result;
}

function md5(input: string): string {
    return createHash('md5').update(input).digest('hex');
}

/** Read the MTOP token (part of `_m_h5_tk` before the `_`) from the context cookie jar. */
async function readMtopToken(page: Page): Promise<string> {
    const cookies = await page.context().cookies(ACS_BASE).catch(() => []);
    const tk = cookies.find((c) => c.name === '_m_h5_tk');
    return tk ? tk.value.split('_')[0] : '';
}

/** Build the `data` payload the PC page sends for pdp.pc.query (locale/region inline, not cookie). */
function buildPdpData(productId: string | number): string {
    const ext = JSON.stringify({
        foreverRandomToken: randomBytes(16).toString('hex'),
        site: 'usa',
        crawler: false,
        'x-m-biz-bx-region': '',
        signedIn: false,
        host: 'www.aliexpress.us',
    });
    return JSON.stringify({
        productId: String(productId),
        _lang: 'en_US',
        _currency: 'USD',
        country: 'US',
        province: '',
        city: '',
        channel: '',
        pdp_ext_f: '',
        pdpNPI: '',
        sourceType: '',
        clientType: 'pc',
        ext,
    });
}

/**
 * Sign + fire ONE MTOP H5 call through the page's request context, with the token dance.
 *
 * Signing (Alibaba MTOP H5): `sign = MD5(token & t & appKey & data)`, where `token` is the part of
 * the `_m_h5_tk` cookie before `_`. The first call on a tokenless session returns
 * `FAIL_SYS_TOKEN_EMPTY` but sets the cookie, so we re-read it and retry. `data` is the EXACT JSON
 * string that is both signed and sent. Returns the parsed response object, or `null` on a non-JSON
 * body (a block) / transport failure. Callers inspect `ret`/`data.result` to tell block from success.
 */
async function callMtopRequest(page: Page, api: string, data: string, log: Log): Promise<Record<string, unknown> | null> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const token = await readMtopToken(page);
        const t = Date.now().toString();
        const sign = md5(`${token}&${t}&${PDP_APP_KEY}&${data}`);
        const params = new URLSearchParams({
            jsv: '2.5.1',
            appKey: PDP_APP_KEY,
            t,
            sign,
            api,
            v: '1.0',
            type: 'originaljsonp',
            dataType: 'jsonp',
            callback: 'mtopjsonp',
            data,
        });
        const url = `${ACS_BASE}/${api}/1.0/?${params.toString()}`;

        let body: string;
        try {
            const res = await page.request.get(url, {
                timeout: 15_000,
                headers: { referer: 'https://www.aliexpress.us/', origin: 'https://www.aliexpress.us' },
            });
            body = await res.text();
        } catch (error) {
            log.warning('MTOP request failed — retrying.', { api, attempt, error: error instanceof Error ? error.message : String(error) });
            continue;
        }

        let json: Record<string, unknown>;
        try {
            json = JSON.parse(body.replace(/^\s*\w+\(/, '').replace(/\)\s*;?\s*$/, ''));
        } catch {
            log.warning('MTOP non-JSON body (likely block).', { api, attempt, snippet: body.slice(0, 120) });
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

/**
 * Fetch the product modules via `mtop.aliexpress.pdp.pc.query` DIRECTLY (no product-page navigation
 * needed beyond the session bootstrap). Returns the `data.result` module map, or `null` when blocked
 * (e.g. `FAIL_SYS_USER_VALIDATE`) so the caller rotates to a fresh session.
 */
export async function fetchPdpDirect(page: Page, productId: string | number, log: Log): Promise<Record<string, unknown> | null> {
    const json = await callMtopRequest(page, PDP_API, buildPdpData(productId), log);
    if (!json) {
        return null;
    }
    const result = asRecord(asRecord(json.data).result);
    if (Object.keys(result).length > 0) {
        return result;
    }
    const { ret } = json as { ret?: unknown[] };
    log.warning('pdp.pc.query — no result (block).', { ret: Array.isArray(ret) ? ret[0] : null });
    return null;
}

/** Build the `data` payload for one star-filtered page of product reviews. */
function buildReviewData(productId: string | number, sellerSeq: string | number | null, filter: number, pageSize: number): string {
    const data: Record<string, unknown> = {
        productId: String(productId),
        page: 1,
        pageSize,
        _lang: 'en_US',
        filter: String(filter),
        sort: 'complex_default',
        country: 'US',
        clientType: 'web',
    };
    if (sellerSeq != null && sellerSeq !== '') {
        data.sellerAdminSeq = Number(sellerSeq);
    }
    return JSON.stringify(data);
}

/**
 * Collect product reviews via the MTOP API, firing the five per-star calls IN PARALLEL through the
 * request context (the `_m_h5_tk` token is already warm from the pdp.pc.query call, so no per-call
 * token dance). This replaces the sequential JSONP-in-page path used by the DOM flow — it cut the
 * reviews step from ~20s to a few seconds. The overall rating/breakdown is filter-independent, so we
 * keep it from the first usable response; samples accumulate highest-star-first. `null` if all fail.
 */
export async function collectReviewsViaRequest(
    page: Page,
    productId: string | number,
    sellerSeq: string | number | null,
    log: Log,
    perStar = 5,
): Promise<ReviewsSummary | null> {
    const stars = [5, 4, 3, 2, 1];
    const parsed = await Promise.all(
        stars.map(async (star) => parseProductReviews(await callMtopRequest(page, REVIEWS_API, buildReviewData(productId, sellerSeq, star, perStar), log))),
    );

    let summary: ReviewsSummary | null = null;
    const reviewSamples: ReviewSample[] = [];
    for (const r of parsed) {
        if (!r) continue;
        if (!summary) summary = r;
        reviewSamples.push(...r.reviewSamples.slice(0, perStar));
    }
    if (!summary) {
        return null;
    }
    log.info('product reviews collected (parallel)', { perStar, samples: reviewSamples.length });
    return { ...summary, reviewSamples };
}

/** Parsed product fields lifted out of one pdp.pc.query `result`. */
export interface ParsedPdp {
    title: string | null;
    pricing: Pricing;
    media: Media;
    specifications: Specification[];
    stock: Stock;
    shipping: Shipping;
    /** Overall rating/count from PC_RATING — a fallback when the reviews API yields nothing. */
    ratingFallback: { rating: number | null; reviewCount: number | null };
    sellerRef: SellerRef | null;
    /** URL of the description HTML (DESC.pcDescUrl), fetched separately. */
    descUrl: string | null;
}

/** Title — PRODUCT_TITLE.text. */
function parseTitle(result: Record<string, unknown>): string | null {
    const t = asRecord(result.PRODUCT_TITLE).text;
    return typeof t === 'string' && t.trim() !== '' ? t.trim() : null;
}

/**
 * Pricing — currency from the selected SKU, min/max sale price across all SKU variants.
 * `skuPriceInfoMap` holds one entry per variant ({ salePriceString: "$32.49", originalPrice: {...} });
 * a single-SKU product has one entry, so min === max. Falls back to the selected SKU's price.
 */
function parsePricing(result: Record<string, unknown>): Pricing {
    const price = asRecord(result.PRICE);
    const target = asRecord(price.targetSkuPriceInfo);
    const skuMap = asRecord(price.skuPriceInfoMap);

    const targetSale = typeof target.salePriceString === 'string' ? target.salePriceString : '';
    const { currency } = asRecord(target.originalPrice);

    const values = Object.values(skuMap)
        .map((info) => {
            const s = asRecord(info).salePriceString;
            return typeof s === 'string' ? parsePrice(s) : null;
        })
        .filter((n): n is number => n !== null);
    if (values.length === 0 && targetSale) {
        const v = parsePrice(targetSale);
        if (v !== null) values.push(v);
    }

    return {
        currency: (typeof currency === 'string' && currency) || parseCurrency(targetSale) || '',
        priceMin: values.length ? Math.min(...values) : null,
        priceMax: values.length ? Math.max(...values) : null,
    };
}

/** Media — clean image URLs from imagePathList (no size suffix), plus the product video if any. */
function parseMedia(result: Record<string, unknown>): Media {
    const h = asRecord(result.HEADER_IMAGE_PC);
    let rawImages: unknown[] = [];
    if (Array.isArray(h.imagePathList)) {
        rawImages = h.imagePathList;
    } else if (Array.isArray(h.imgList)) {
        rawImages = h.imgList;
    } else if (Array.isArray(h.mainImages)) {
        rawImages = (h.mainImages as unknown[]).map((m) => asRecord(m).imageUrl);
    }
    const images = rawImages
        .map(toHttps)
        .filter((u): u is string => u !== null)
        .map((url) => ({ url }));

    const videos: Media['videos'] = [];
    const video = asRecord(h.productVideo);
    const playInfo = asRecord(video.videoPlayInfo);
    const videoUrl = toHttps(playInfo.webUrl ?? playInfo.iphoneUrl ?? playInfo.androidPhoneUrl);
    if (videoUrl) {
        videos.push({ url: videoUrl, poster: toHttps(video.posterUrl) });
    }
    return { images, videos };
}

/** Specifications — PRODUCT_PROP_PC.showedProps, each `{ attrName, attrValue }`. */
function parseSpecifications(result: Record<string, unknown>): Specification[] {
    const props = asRecord(result.PRODUCT_PROP_PC).showedProps;
    if (!Array.isArray(props)) {
        return [];
    }
    return props
        .map((p) => {
            const r = asRecord(p);
            return {
                name: typeof r.attrName === 'string' ? r.attrName.trim() : '',
                value: typeof r.attrValue === 'string' ? r.attrValue.trim() : '',
            };
        })
        .filter((s) => s.name !== '' && s.value !== '');
}

/** Stock — total inventory across SKUs, plus sold count parsed from PC_RATING.otherText ("236 sold"). */
function parseStock(result: Record<string, unknown>): Stock {
    const qty = asRecord(result.QUANTITY_PC).totalAvailableInventory;
    const { otherText } = asRecord(result.PC_RATING);
    const soldMatch = typeof otherText === 'string' ? otherText.replace(/[,.]/g, '').match(/(\d+)\s*sold/i) : null;
    return {
        availableQuantity: typeof qty === 'number' ? qty : null,
        soldCount: soldMatch ? Number(soldMatch[1]) : null,
    };
}

/**
 * Shipping — the delivery estimate. It lives as HTML inside a layout `content` field, e.g.
 * `<strong>Delivery: Jul 02 - 09</strong>`. We walk the delivery layout, find the entry mentioning
 * "Delivery:", strip tags, and return the date range after the prefix.
 */
function parseShipping(result: Record<string, unknown>): Shipping {
    const shipping = asRecord(result.SHIPPING);
    let layouts: unknown[] = [];
    if (Array.isArray(shipping.deliveryLayoutInfo)) {
        layouts = shipping.deliveryLayoutInfo;
    } else if (Array.isArray(shipping.originalLayoutResultList)) {
        layouts = shipping.originalLayoutResultList;
    }

    let text: string | null = null;
    const walk = (node: unknown): void => {
        if (text || node == null) return;
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        if (typeof node === 'object') {
            const r = node as Record<string, unknown>;
            if (typeof r.content === 'string' && /delivery:/i.test(r.content)) {
                const stripped = r.content.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
                text = stripped.replace(/^.*delivery:\s*/i, '').trim() || stripped;
                return;
            }
            for (const key of Object.keys(r)) walk(r[key]);
        }
    };
    walk(layouts);
    return { deliveryTimeText: text };
}

/** Overall rating + review count from PC_RATING (fallback for the reviews API). */
function parseRating(result: Record<string, unknown>): { rating: number | null; reviewCount: number | null } {
    const r = asRecord(result.PC_RATING);
    let rating: number | null = null;
    if (typeof r.rating === 'string') {
        rating = Number(r.rating);
    } else if (typeof r.rating === 'number') {
        rating = r.rating;
    }
    const count = typeof r.totalValidNum === 'number' ? r.totalValidNum : null;
    return { rating: rating != null && Number.isFinite(rating) ? rating : null, reviewCount: count };
}

/** Seller reference — store name + the seller's admin sequence (used to key the reviews API). */
function parseSellerRef(result: Record<string, unknown>): SellerRef | null {
    const shop = asRecord(result.SHOP_CARD_PC);
    const info = asRecord(shop.sellerInfo);
    const adminSeq = info.adminSeq ?? info.companyId;
    const name = typeof shop.storeName === 'string' ? shop.storeName : null;
    const url = toHttps(info.storeURL);
    if (adminSeq == null && !name && !url) {
        return null;
    }
    return {
        platformSellerId: adminSeq != null ? String(adminSeq) : null,
        name,
        url,
    };
}

/** Map one pdp.pc.query `result` object into our product fields. */
export function parsePdpResult(result: Record<string, unknown>): ParsedPdp {
    return {
        title: parseTitle(result),
        pricing: parsePricing(result),
        media: parseMedia(result),
        specifications: parseSpecifications(result),
        stock: parseStock(result),
        shipping: parseShipping(result),
        ratingFallback: parseRating(result),
        sellerRef: parseSellerRef(result),
        descUrl: (typeof asRecord(result.DESC).pcDescUrl === 'string' ? (asRecord(result.DESC).pcDescUrl as string) : null) || null,
    };
}

/** Decode the handful of HTML entities the description markup carries, plus numeric refs. */
function decodeEntities(text: string): string {
    const named: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
    return text
        .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g, (m) => named[m])
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

/**
 * Fetch + clean the product description HTML from DESC.pcDescUrl.
 *
 * The endpoint returns ready-made HTML (`<div class="detailmodule_html">…`). We strip inline
 * scripts (the seller markup carries `window.adminAccountId=…` etc.) and derive plain text by
 * removing tags and collapsing whitespace. Runs through the page's request context so it reuses the
 * session's cookies + residential IP. Best-effort: any failure yields an empty description.
 */
export async function fetchDescription(page: Page, url: string | null, log: Log): Promise<Description> {
    if (!url) {
        return { html: '', plainText: '' };
    }
    try {
        const res = await page.request.get(url, { timeout: 15_000 });
        if (!res.ok()) {
            log.warning('description fetch non-OK', { status: res.status() });
            return { html: '', plainText: '' };
        }
        const raw = await res.text();
        const html = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').trim();
        const plainText = decodeEntities(html.replace(/<[^>]*>/g, ' '))
            .replace(/\s+/g, ' ')
            .trim();
        return { html, plainText };
    } catch (error) {
        log.warning('description fetch failed', { error: error instanceof Error ? error.message : String(error) });
        return { html: '', plainText: '' };
    }
}

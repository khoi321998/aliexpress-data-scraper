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

import { parsePrice } from './pricing.js';
import { parseProductReviews } from './reviewsApi.js';
import type { RegionAddress, Storefront } from './storefront.js';
import { GLOBAL_STOREFRONT } from './storefront.js';
import type { Description, Media, Pricing, ReviewSample, ReviewsSummary, SellerRef, Shipping, Specification, Stock } from './types.js';
import { storefrontHost } from './url.js';

/** The MTOP API that returns the full PC product payload. */
const PDP_QUERY_RE = /mtop\.aliexpress\.pdp\.pc\.query/i;
const PDP_API = 'mtop.aliexpress.pdp.pc.query';
/** Per-product buyer-reviews API (overall rating + per-star samples). */
const REVIEWS_API = 'mtop.aliexpress.review.pc.list';
/** Per-API H5 appKey (the PC product + reviews endpoints share this key). */
const PDP_APP_KEY = '12574478';

/** Which MTOP gateway (and the site identity that goes with it) a given ship-to must be asked on. */
interface Gateway {
    /** MTOP H5 endpoint base. */
    acsBase: string;
    /** Site origin the signed call claims to come from (referer/origin headers). */
    origin: string;
    /** `ext.site` in the pdp payload — AliExpress's own name for the storefront. */
    site: string;
    /** `ext.host` in the pdp payload. */
    host: string;
}

/**
 * Pick the gateway for a ship-to country.
 *
 * aliexpress.us is a legally separate US storefront with its own catalogue, and `acs.aliexpress.us`
 * only answers for it — asking it about a listing that is only on the global site is exactly the
 * "403 from Spain" symptom. So US keeps the `.us` gateway it has always used (that path works and
 * we don't want to disturb it), and every other ship-to goes to the global `.com` gateway, which is
 * the only one that serves non-US regions.
 *
 * `site` is NOT the gateway. The `.com` gateway answers for every storefront; which CATALOGUE it
 * answers from is decided by `ext.site`, and that comes from the caller's {@link Storefront} — see
 * `storefront.ts` for why sending `glo` from a Spanish session reports availability Spain does not
 * have.
 */
function gatewayFor(shipToCountry: string, storefront: Storefront): Gateway {
    if (shipToCountry.toUpperCase() === 'US') {
        return { acsBase: 'https://acs.aliexpress.us/h5', origin: 'https://www.aliexpress.us', site: 'usa', host: 'www.aliexpress.us' };
    }
    // Claim the same storefront the crawler actually navigated to (`es.aliexpress.com`, ...), so the
    // referer and `ext.host` match the page the signed call is supposed to be coming from.
    const host = storefrontHost(shipToCountry);
    return { acsBase: 'https://acs.aliexpress.com/h5', origin: `https://${host}`, site: storefront.site, host };
}

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

/** Read the MTOP token (part of `_m_h5_tk` before the `_`) from the gateway's cookie jar. */
async function readMtopToken(page: Page, acsBase: string): Promise<string> {
    const cookies = await page.context().cookies(acsBase).catch(() => []);
    const tk = cookies.find((c) => c.name === '_m_h5_tk');
    return tk ? tk.value.split('_')[0] : '';
}

/**
 * Build the `data` payload the PC page sends for pdp.pc.query (locale/region inline, not cookie).
 *
 * `address.country` is the ship-to and it decides whether the listing resolves at all: a seller who
 * does not ship to the requested country answers with an empty `result`, which the caller cannot
 * distinguish from an anti-bot block. It must agree with the `region` in the page's `aep_usuc_f`
 * cookie.
 *
 * `address.province`/`city` are AliExpress's own region ids for the buyer's resolved delivery
 * address. A real browser always carries them and they narrow availability further than the country
 * alone (a seller can serve a country but not an island region). We forward whatever the session was
 * given and send `''` otherwise — never a made-up id.
 */
function buildPdpData(productId: string | number, address: RegionAddress, storefront: Storefront, gateway: Gateway): string {
    const ext = JSON.stringify({
        foreverRandomToken: randomBytes(16).toString('hex'),
        site: gateway.site,
        crawler: false,
        'x-m-biz-bx-region': '',
        signedIn: false,
        host: gateway.host,
    });
    return JSON.stringify({
        productId: String(productId),
        _lang: storefront.locale,
        _currency: storefront.currency,
        country: address.country,
        province: address.province,
        city: address.city,
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
async function callMtopRequest(page: Page, api: string, data: string, log: Log, gateway: Gateway): Promise<Record<string, unknown> | null> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const token = await readMtopToken(page, gateway.acsBase);
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
        const url = `${gateway.acsBase}/${api}/1.0/?${params.toString()}`;

        let body: string;
        try {
            const res = await page.request.get(url, {
                timeout: 15_000,
                headers: { referer: `${gateway.origin}/`, origin: gateway.origin },
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
export async function fetchPdpDirect(
    page: Page,
    productId: string | number,
    log: Log,
    address: RegionAddress = { country: 'US', province: '', city: '' },
    storefront: Storefront = GLOBAL_STOREFRONT,
): Promise<Record<string, unknown> | null> {
    const gateway = gatewayFor(address.country, storefront);
    const json = await callMtopRequest(page, PDP_API, buildPdpData(productId, address, storefront, gateway), log, gateway);
    if (!json) {
        return null;
    }
    const result = asRecord(asRecord(json.data).result);
    if (Object.keys(result).length > 0) {
        return result;
    }
    const { ret } = json as { ret?: unknown[] };
    // An empty result here is ambiguous: an anti-bot block OR a listing the seller simply won't ship
    // to the requested address. Log the region so the second case is diagnosable from the run log.
    log.warning('pdp.pc.query — no result (block or unavailable for ship-to).', {
        ret: Array.isArray(ret) ? ret[0] : null,
        shipToCountry: address.country,
        site: gateway.site,
    });
    return null;
}

/** Why a storefront refuses to sell a listing to the requested address. */
export interface PdpUnavailability {
    /** AliExpress's own code, e.g. `SITEM_BAN_NO_AVAIL_SKU`. */
    errorCode: string;
    /** The shopper-facing sentence AliExpress renders in place of the buy box, in the storefront's language. */
    message: string | null;
}

/**
 * Detect the "this storefront does not sell this item to you" answer.
 *
 * It is NOT an error response: `ret` is `SUCCESS`, HTTP is 200, and `data.result` is a well-formed
 * object — it just holds `GLOBAL_DATA` alone, with every product module (PRODUCT_TITLE, PRICE,
 * HEADER_IMAGE_PC, …) absent and `globalData.bigBossBan: true` in their place.
 *
 * Without this check the caller sees a result object with no title and can only read it as an
 * anti-bot block, which sends the crawler through its full retry-and-rotate budget chasing a listing
 * no fresh IP will ever return. `bigBossBan` is a merchandising decision, not a defence.
 */
export function pdpUnavailability(result: Record<string, unknown>): PdpUnavailability | null {
    const globalData = asRecord(asRecord(result.GLOBAL_DATA).globalData);
    if (globalData.bigBossBan !== true) {
        return null;
    }
    const code = typeof globalData.errorCode === 'string' ? globalData.errorCode.trim() : '';
    const tip = typeof globalData.bigBossBanTip === 'string' ? globalData.bigBossBanTip.trim() : '';
    return { errorCode: code || 'BIG_BOSS_BAN', message: tip || null };
}

/**
 * Build the `data` payload for one star-filtered page of product reviews.
 *
 * `_lang` follows the storefront rather than being pinned to `en_US`: the session's `aep_usuc_f`
 * cookie already claims that locale, and AliExpress serves review content from the cookie regardless
 * of what this field says (the same reason the currency is pinned there and not here). Sending a
 * locale the session contradicts buys nothing and only makes the call look synthetic.
 */
function buildReviewData(
    productId: string | number,
    sellerSeq: string | number | null,
    filter: number,
    pageSize: number,
    shipToCountry: string,
    storefront: Storefront,
): string {
    const data: Record<string, unknown> = {
        productId: String(productId),
        page: 1,
        pageSize,
        _lang: storefront.locale,
        filter: String(filter),
        sort: 'complex_default',
        country: shipToCountry,
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
    shipToCountry = 'US',
    storefront: Storefront = GLOBAL_STOREFRONT,
): Promise<ReviewsSummary | null> {
    const stars = [5, 4, 3, 2, 1];
    // Same gateway as the pdp call — the `_m_h5_tk` token is per-gateway, so switching hosts here
    // would throw away the warm token and re-run the token dance five times over.
    const gateway = gatewayFor(shipToCountry, storefront);
    const parsed = await Promise.all(
        stars.map(async (star) =>
            parseProductReviews(
                await callMtopRequest(page, REVIEWS_API, buildReviewData(productId, sellerSeq, star, perStar, shipToCountry, storefront), log, gateway),
            ),
        ),
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
 * Amount-like sub-objects (`{ currency: 'EUR', value: 21.09, formatedAmount: '€21,09' }`) that carry
 * an ISO code. The first four hang off a per-SKU price info, the last four off `itemRangePriceView`.
 */
const AMOUNT_KEYS = [
    'originalPrice',
    'salePrice',
    'skuAmount',
    'skuActivityAmount',
    'minDisPrice',
    'maxDisPrice',
    'minOriginalPrice',
    'maxOriginalPrice',
] as const;

/** Read the ISO code off one amount-like object; `null` when absent or not a non-empty string. */
function amountCurrency(value: unknown): string | null {
    const code = asRecord(value).currency;
    return typeof code === 'string' && code.trim() !== '' ? code.trim() : null;
}

/**
 * Currency — resolved in a strict priority order over the price infos the PRICE module carries.
 *
 * `infos[0]` is ALWAYS the selected SKU (`targetSkuPriceInfo`), so the ladder is:
 *   1. selected SKU → ISO code off an amount object   (what the original code used — unchanged)
 *   2. each variant in `skuPriceInfoMap` → ISO code
 *   3. `itemRangePriceView` → ISO code off its min/max amounts
 *   4. `GLOBAL_DATA.globalData.currencyCode` — the currency the whole page is priced in
 *
 * Rung 4 exists because a PRICE module can carry NO amount object whatsoever: a multi-variant US
 * listing (item 3256811581312282) ships `targetSkuPriceInfo` and six `skuPriceInfoMap` entries that
 * each hold only `salePriceString: '$7.74'` — no `originalPrice`, no `itemRangePriceView`. The ISO
 * code for that page lives one module over, in GLOBAL_DATA.
 *
 * Rung 1 keeps every listing that already worked resolving from exactly the same field as before.
 * Rungs 2–3 only ever run when rung 1 yields nothing — the case that produced an empty currency:
 * a single-variant ES listing arrives with NO `targetSkuPriceInfo` at all (verified against the raw
 * payload of item 1005012553882069), so prices came from `skuPriceInfoMap` while the currency lookup
 * had nowhere to read from.
 *
 * Every rung is an ISO code the API states outright — we deliberately do NOT guess one from the
 * currency symbol in a formatted price. That guess is lossy (`$` is as much CAD/AUD/MXN as USD) and
 * a silently wrong code is worse than an empty one: an empty currency is flagged by the extraction
 * audit and logged with the raw module, a wrong one just looks like data.
 */
function parseCurrencyCode(infos: Record<string, unknown>[], globalData: Record<string, unknown>): string {
    for (const info of infos) {
        for (const key of AMOUNT_KEYS) {
            const code = amountCurrency(info[key]);
            if (code) return code;
        }
    }
    const pageCode = globalData.currencyCode;
    return typeof pageCode === 'string' && pageCode.trim() !== '' ? pageCode.trim() : '';
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
    const skuInfos = Object.values(skuMap).map(asRecord);
    const rangeView = asRecord(price.itemRangePriceView);

    const targetSale = typeof target.salePriceString === 'string' ? target.salePriceString : '';

    const values = skuInfos
        .map((info) => {
            const s = info.salePriceString;
            return typeof s === 'string' ? parsePrice(s) : null;
        })
        .filter((n): n is number => n !== null);
    if (values.length === 0 && targetSale) {
        const v = parsePrice(targetSale);
        if (v !== null) values.push(v);
    }

    return {
        currency: parseCurrencyCode([target, ...skuInfos, rangeView], asRecord(asRecord(result.GLOBAL_DATA).globalData)),
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

/**
 * Some sellers put markup in a prop value — most often a `<ul><li>…</li></ul>` bullet list of
 * marketing copy. Flatten it to plain text: block/line breaks become `; ` separators, every other
 * tag is dropped, entities are decoded and whitespace is collapsed. Text without tags is untouched
 * beyond trimming.
 */
function propValueToText(value: string): string {
    if (!value.includes('<')) {
        return decodeEntities(value).replace(/\s+/g, ' ').trim();
    }
    return decodeEntities(
        value
            .replace(/<\s*(?:br|\/li|\/p|\/div|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
            .replace(/<[^>]*>/g, ' '),
    )
        .split('\n')
        .map((part) => part.replace(/\s+/g, ' ').trim())
        .filter((part) => part !== '')
        .join('; ')
        // Items that already end in sentence punctuation don't need the separator.
        .replace(/([.;:!?])\s*;\s*/g, '$1 ')
        .trim();
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
                name: typeof r.attrName === 'string' ? propValueToText(r.attrName) : '',
                value: typeof r.attrValue === 'string' ? propValueToText(r.attrValue) : '',
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

/** One renderable entry of a delivery layout: HTML text plus the key that says what it is. */
interface DeliveryBlock {
    content: string;
    /** AliExpress's own id for the block's template, e.g. `eta_content_Local_Plus_2`. */
    medusaKey: string;
}

/** Flatten a delivery layout tree into its `content` blocks (title, freight, addition, …). */
function collectDeliveryBlocks(node: unknown, out: DeliveryBlock[]): void {
    if (node == null || out.length >= 50) {
        return;
    }
    if (Array.isArray(node)) {
        node.forEach((child) => collectDeliveryBlocks(child, out));
        return;
    }
    if (typeof node !== 'object') {
        return;
    }
    const r = node as Record<string, unknown>;
    if (typeof r.content === 'string') {
        out.push({ content: r.content, medusaKey: typeof r.medusaKey === 'string' ? r.medusaKey : '' });
    }
    for (const key of Object.keys(r)) {
        collectDeliveryBlocks(r[key], out);
    }
}

/** Strip tags/entities from one layout block and collapse it to a single line. */
function blockToText(content: string): string {
    return decodeEntities(content.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Drop a short leading `<label>:` from an ETA line, keeping the estimate itself.
 *
 * "Delivery: Jul 02 - 09" → "Jul 02 - 09"; "Entrega estimada: antes del viernes 28 de AGO." →
 * "antes del viernes 28 de AGO.". The 40-char ceiling keeps a colon that is part of the estimate
 * (or a sentence) from swallowing the value.
 */
function stripEtaLabel(text: string): string {
    const stripped = text.replace(/^[^:]{1,40}:\s*/, '').trim();
    return stripped || text;
}

/**
 * Template keys of the block that holds the ETA VALUE, across the layouts AliExpress ships:
 * `eta_content_Local_Plus_2` (es/global) and `TimeAB_US_DeliveryRangeTime@deliveryTime` (us).
 */
const ETA_BLOCK_KEY_RE = /^eta|deliveryrangetime|deliverydate/i;

/**
 * Shipping — the delivery estimate shown under the buy box.
 *
 * Two things make this harder than reading one field. The estimate is LOCALIZED (`Delivery:` on the
 * global site, `Entrega estimada:` on `es.aliexpress.com`, `Livraison…` on the French one), AND the
 * storefronts disagree on how the line is cut into blocks: ES renders label and value as one block
 * (`Entrega estimada: antes del viernes 28 de AGO.`), while US splits them —
 * `Global_Version_DeliveryTitle@deliveryTime` holds a bare `Delivery:` and
 * `TimeAB_US_DeliveryRangeTime@deliveryTime` holds `Aug. 31 - Sep. 08`. Matching the word
 * "delivery" therefore yielded nothing on ES and the naked label `"Delivery:"` on US.
 *
 * So the layout text is the FALLBACK, not the source. In order:
 *
 *   1. `bizData.displayEtaMinDate`/`displayEtaMaxDate` — the dates AliExpress's own ETA engine
 *      produced, which every storefront carries and no storefront wraps in prose. They render the
 *      same range the page shows (`Aug. 31` + `Sep. 08` → `Aug. 31 - Sep. 08`), so the field reads
 *      alike in every market instead of following each locale's sentence structure.
 *   2. the ETA block by template key ({@link ETA_BLOCK_KEY_RE}), label stripped — for payloads whose
 *      bizData omits the dates.
 *   3. a block reading `…delivery: <value>` — the older global-site shape. Blocks that are ONLY the
 *      label are skipped rather than returned, which is what produced the bare `"Delivery:"`.
 *
 * All of it is read off the delivery option the page has SELECTED. A listing routinely offers
 * several, and the cheapest option's date is not the one the buyer is being shown.
 */
function parseShipping(result: Record<string, unknown>): Shipping {
    const shipping = asRecord(result.SHIPPING);
    let layouts: unknown[] = [];
    if (Array.isArray(shipping.deliveryLayoutInfo)) {
        layouts = shipping.deliveryLayoutInfo;
    } else if (Array.isArray(shipping.originalLayoutResultList)) {
        layouts = shipping.originalLayoutResultList;
    }
    const selectedCode = shipping.selectedDeliveryOptionCode;
    const selected = layouts.find((l) => selectedCode != null && asRecord(asRecord(l).bizData).deliveryOptionCode === selectedCode) ?? layouts[0];

    // 1 — the ETA engine's own dates.
    const bizData = asRecord(asRecord(selected).bizData);
    const min = typeof bizData.displayEtaMinDate === 'string' ? bizData.displayEtaMinDate.trim() : '';
    const max = typeof bizData.displayEtaMaxDate === 'string' ? bizData.displayEtaMaxDate.trim() : '';
    if (min || max) {
        return { deliveryTimeText: min && max && min !== max ? `${min} - ${max}` : min || max };
    }

    const blocks: DeliveryBlock[] = [];
    collectDeliveryBlocks(selected ?? layouts, blocks);

    // 2 — the ETA block, found by its template key rather than by its words.
    const eta = blocks.find((b) => ETA_BLOCK_KEY_RE.test(b.medusaKey) && blockToText(b.content) !== '');
    if (eta) {
        return { deliveryTimeText: stripEtaLabel(blockToText(eta.content)) };
    }

    // 3 — legacy English shape. A block holding nothing but the label carries no estimate, so it
    // must not end the search the way it used to.
    for (const block of blocks) {
        if (!/delivery:/i.test(block.content)) {
            continue;
        }
        const value = blockToText(block.content).replace(/^.*delivery:\s*/i, '').trim();
        if (value !== '') {
            return { deliveryTimeText: value };
        }
    }

    return { deliveryTimeText: null };
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

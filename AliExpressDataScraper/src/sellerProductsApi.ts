// Seller product listing via `mtop.alibaba.alisite.ae.server.ModuleAsyncService` — the API-based
// replacement for scraping the all-items grid DOM.
//
// This is the MTOP twin of the store page's `productList` / `allitems_choice` component. Unlike the
// `shoprenderview.aliexpress.com` endpoint (which is baxia/x5sec protected per host and so needs a
// prior store-page navigation), ModuleAsyncService lives on the signed `acs.aliexpress.com` gateway
// and works from any warm session — NO store navigation, NO baxia. It returns `data.products.data[]`,
// the same rich shape (price money object, sold count, rating, detail URL) and paginates, so we can
// pull the seller's whole catalog. The `componentKey` differs by store type: regular stores use
// `productList`, fully-managed ("choice") stores use `allitems_choice` — we probe both on page 1.
import type { Log } from 'apify';
import type { Page } from 'playwright';

import { callSellerMtop } from './sellerApi.js';
import type { SellerProductPreview } from './types.js';
import { extractAliExpressItemId } from './url.js';

/** API + appKey for the store product-list module. */
const PRODUCTS_API = 'mtop.alibaba.alisite.ae.server.ModuleAsyncService';
const PRODUCTS_APP_KEY = '12574478';
/** componentKey candidates, in probe order: regular store, then fully-managed ("choice") store. */
const COMPONENT_KEYS = ['productList', 'allitems_choice'];

/** Narrow an unknown to a plain object; non-objects become `{}`. */
function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Trim a string; null/empty/non-string become null. */
function toStr(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
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

/** Coerce a number / numeric string to a finite number, else null. */
function toNumber(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value.replace(/[^\d.]/g, ''));
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/** Pull the best price (number) from a product entry: promotion price first, then list price. */
function pickPrice(p: Record<string, unknown>): number | null {
    const promo = toNumber(asRecord(p.promotionPiecePriceMoney).amount);
    if (promo != null) return promo;
    const piece = toNumber(asRecord(p.piecePriceMoney).amount);
    if (piece != null) return piece;
    // Fall back to the formatted string ("US $265.51").
    return toNumber(p.formatedPromotionPiecePriceStr ?? p.formatedPiecePriceStr);
}

/** Map one `products.data[]` entry to a {@link SellerProductPreview}. */
export function parseSellerProduct(raw: unknown): SellerProductPreview {
    const p = asRecord(raw);
    const id = p.id != null ? String(p.id) : null;
    // `pcDetailUrl` often carries tracking query params — keep only the canonical /item/<id>.html.
    const detailUrl = toHttps(p.pcDetailUrl);
    const cleanDetail = detailUrl ? detailUrl.replace(/\?.*$/, '') : null;
    const url = cleanDetail ?? (id ? `https://www.aliexpress.com/item/${id}.html` : null);
    return {
        productId: id ?? (url ? extractAliExpressItemId(url) : null),
        title: toStr(p.subject) ?? toStr(p.seoTitle),
        url,
        imageUrl: toHttps(p.image350Url) ?? toHttps(p.skuImageUrl) ?? toHttps(p.scaleImageUrl) ?? toHttps(p.summImageUrl),
        price: pickPrice(p),
    };
}

/** Read the `data.products.data[]` array from a ModuleAsyncService response (empty when absent). */
function readProductArray(json: Record<string, unknown> | null): unknown[] {
    const { data } = asRecord(asRecord(asRecord(json).data).products);
    return Array.isArray(data) ? data : [];
}

/**
 * Fetch up to `limit` of the seller's products via ModuleAsyncService, paging until the catalog is
 * exhausted or the limit is reached. Probes both componentKeys on page 1 (store type varies), then
 * sticks with whichever returned items. De-duplicated by product id. Best-effort: returns whatever it
 * collected and never throws.
 */
export async function fetchSellerProducts(
    page: Page,
    sellerId: string,
    pathId: string,
    log: Log,
    opts: { language: string; currency: string; country: string },
    limit = 60,
    pageSize = 20,
): Promise<SellerProductPreview[]> {
    const buildData = (componentKey: string, p: number): string =>
        JSON.stringify({
            componentKey,
            params: JSON.stringify({
                country: opts.country,
                site: 'glo',
                sellerId: Number(sellerId),
                groupId: -1,
                currency: opts.currency,
                locale: opts.language,
                buyerId: 0,
                page: p,
                pageSize,
                order: 'orders_desc',
                selectType: 'auto',
            }),
        });

    const seen = new Set<string>();
    const previews: SellerProductPreview[] = [];
    let componentKey: string | null = null;

    for (let p = 1; p <= 20 && previews.length < limit; p += 1) {
        let entries: unknown[] = [];
        if (componentKey) {
            entries = readProductArray(await callSellerMtop(page, PRODUCTS_API, PRODUCTS_APP_KEY, buildData(componentKey, p), log));
        } else {
            // Page 1: probe componentKeys until one yields products, then lock it in for later pages.
            for (const ck of COMPONENT_KEYS) {
                const arr = readProductArray(await callSellerMtop(page, PRODUCTS_API, PRODUCTS_APP_KEY, buildData(ck, p), log));
                if (arr.length > 0) {
                    componentKey = ck;
                    entries = arr;
                    break;
                }
            }
            if (!componentKey) {
                log.warning('productList — no products from any componentKey (block/empty store).', { sellerId, pathId });
                break;
            }
        }

        if (entries.length === 0) {
            break;
        }
        for (const entry of entries) {
            const preview = parseSellerProduct(entry);
            if (preview.productId) {
                if (seen.has(preview.productId)) continue;
                seen.add(preview.productId);
            }
            previews.push(preview);
            if (previews.length >= limit) break;
        }
    }

    log.info('seller products fetched (API)', { count: previews.length, componentKey });
    return previews;
}

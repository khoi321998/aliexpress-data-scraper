// Seller store reviews via the `evaluation.productEvaluation` MTOP API — the API-based replacement
// for clicking the feedback page's per-star tabs and scraping the review cards.
//
// One call with `filter:"all"` returns a mixed page of the store's latest reviews; each entry carries
// its own `buyerEval` (a 0–100 score in steps of 20 → divide by 20 to recover the star value), so we
// never need the per-star tab sweep the DOM path used. The endpoint lives on the seller gateway and
// is signed via the same token dance as `seller.page.info` (see `callSellerMtop` in `sellerApi.ts`).
import type { Log } from 'apify';
import type { Page } from 'playwright';

import { callSellerMtop } from './sellerApi.js';
import type { SellerReviewSample } from './types.js';

/** Per-API H5 appKey + version for `evaluation.productEvaluation`. */
const REVIEWS_APP_KEY = '24815441';
const REVIEWS_API = 'evaluation.productEvaluation';
const REVIEWS_VERSION = '102';

/** Narrow an unknown to a plain object; non-objects become `{}`. */
function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Trim a string; null/empty/non-string become null. */
function toStr(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Promote `//host/…` / `http://…` image URLs to https; non-strings are dropped. */
function toHttps(url: unknown): string | null {
    if (typeof url !== 'string' || url.trim() === '') {
        return null;
    }
    const u = url.trim();
    if (u.startsWith('//')) return `https:${u}`;
    if (u.startsWith('http://')) return `https://${u.slice('http://'.length)}`;
    return u;
}

/** Map a maybe-array of image URLs to a clean https list. */
function toImageList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map(toHttps).filter((u): u is string => u !== null);
}

/** Build the `data` payload for one page of store reviews. */
function buildReviewData(sellerId: string, page: number, pageSize: number, language: string, currency: string, country: string): string {
    return JSON.stringify({
        page,
        pageSize,
        filter: 'all',
        sort: 'complex_default',
        sellerAdminSeq: Number(sellerId),
        locale: language,
        _currency: currency,
        _lang: language.split('_')[0] || 'en',
        _country: country,
        country,
        platform: 'web',
    });
}

/** Map one `evaViewList` entry to a {@link SellerReviewSample}, defensive about field naming. */
export function parseSellerReview(raw: unknown): SellerReviewSample {
    const r = asRecord(raw);
    // `buyerEval` is a 0–100 score in steps of 20 (100 → 5 stars).
    const eval100 = typeof r.buyerEval === 'number' ? r.buyerEval : Number(r.buyerEval);
    const fbType = asRecord(r.buyerFbType);
    const user = toStr(r.buyerName) ?? toStr(fbType.crowdSourcingPersonName) ?? (r.anonymous ? 'Anonymous' : '');
    return {
        user,
        rating: Number.isFinite(eval100) ? Math.round(eval100 / 20) : null,
        commentDate: toStr(r.evalDate) ?? toStr(r.gmtCreate) ?? toStr(r.date) ?? '',
        comment: toStr(r.buyerFeedback) ?? '',
        commentTranslated: toStr(r.buyerTranslationFeedback) ?? toStr(r.buyerFeedbackTranslation),
        images: [...toImageList(r.images), ...toImageList(r.buyerAddFbImages)],
    };
}

/**
 * Fetch up to `limit` of the seller's most recent store reviews via `evaluation.productEvaluation`,
 * paging until the list is exhausted or the limit is reached. Best-effort: returns whatever it
 * collected (possibly empty) and never throws.
 */
export async function fetchSellerReviews(
    page: Page,
    sellerId: string,
    log: Log,
    opts: { language: string; currency: string; country: string },
    limit = 25,
    pageSize = 20,
): Promise<SellerReviewSample[]> {
    const reviews: SellerReviewSample[] = [];
    for (let p = 1; p <= 10 && reviews.length < limit; p += 1) {
        const json = await callSellerMtop(page, REVIEWS_API, REVIEWS_APP_KEY, buildReviewData(sellerId, p, pageSize, opts.language, opts.currency, opts.country), log, REVIEWS_VERSION);
        const list = asRecord(asRecord(json).data).evaViewList;
        if (!Array.isArray(list) || list.length === 0) {
            break;
        }
        reviews.push(...list.map(parseSellerReview));
    }
    const trimmed = reviews.slice(0, limit);
    log.info('seller reviews fetched (API)', { count: trimmed.length });
    return trimmed;
}

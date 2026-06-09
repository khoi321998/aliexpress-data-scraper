// Parse the product-reviews MTOP response (`mtop.aliexpress.review.pc.list`) into our
// {@link ReviewsSummary} DTO — the API-based source for the PDP's buyer reviews.
//
// Shape (the bits we use):
//   data.productEvaluationStatistic  → overall rating + per-star counts (always present, even when
//                                       the request filtered to a single star).
//   data.evaViewList[]               → the page of individual reviews (buyer, comment + translation,
//                                       date, star = buyerEval/20, sku, photos).
//   data.impressionDTOList[]         → review "impression" keywords, e.g. "elegant appearance".
//   data.filterInfo.filterStatistic  → counts per filter; the `image` code = reviews carrying photos.
import type { Log } from 'apify';
import type { Page } from 'playwright';

import { fetchProductReviews } from './sellerApi.js';
import type { RatingBreakdown, ReviewSample, ReviewsSummary } from './types.js';

/** Narrow an unknown to a plain object for safe property access; non-objects become `{}`. */
function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Coerce a number or numeric string to a number, else null. */
function toNumber(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value.trim());
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/** Trim a string; null/empty/non-string become null. */
function toStr(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Promote `//host/…` and `http://…` image URLs to https; non-strings are dropped. */
function toHttps(url: unknown): string | null {
    if (typeof url !== 'string' || url.trim() === '') {
        return null;
    }
    const u = url.trim();
    if (u.startsWith('//')) {
        return `https:${u}`;
    }
    if (u.startsWith('http://')) {
        return `https://${u.slice('http://'.length)}`;
    }
    return u;
}

/** Map an array of maybe-string image URLs to a clean https list. */
function toImageList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map(toHttps).filter((u): u is string => u !== null);
}

/** Map one `evaViewList` entry to a {@link ReviewSample}. */
function toSample(raw: unknown): ReviewSample {
    const r = asRecord(raw);
    // `buyerEval` is a 0–100 score in steps of 20 (100 → 5 stars), so divide to recover the star value.
    const eval100 = toNumber(r.buyerEval);
    return {
        user: toStr(r.buyerName) ?? '',
        userFeedbackScore: null,
        comment: toStr(r.buyerFeedback) ?? '',
        commentTranslated: toStr(r.buyerTranslationFeedback),
        country: toStr(r.buyerCountry),
        commentDate: toStr(r.evalDate) ?? '',
        rating: eval100 != null ? Math.round(eval100 / 20) : null,
        // AliExpress only surfaces reviews from confirmed buyers; `reviewType === 'REVIEW'` flags those.
        verifiedPurchase: r.reviewType === 'REVIEW',
        sku: toStr(r.skuInfo),
        // Main photos plus any attached to a later "additional" feedback edit.
        images: [...toImageList(r.images), ...toImageList(r.buyerAddFbImages)],
    };
}

/**
 * Parse a raw `mtop.aliexpress.review.pc.list` response into a {@link ReviewsSummary}, or `null` when
 * the shape isn't recognized (e.g. an error `ret`).
 */
export function parseProductReviews(res: unknown): ReviewsSummary | null {
    const data = asRecord(asRecord(res).data);
    if (Object.keys(data).length === 0) {
        return null;
    }

    const stat = asRecord(data.productEvaluationStatistic);
    const ratingBreakdown: RatingBreakdown = {
        '1': toNumber(stat.oneStarNum) ?? 0,
        '2': toNumber(stat.twoStarNum) ?? 0,
        '3': toNumber(stat.threeStarNum) ?? 0,
        '4': toNumber(stat.fourStarNum) ?? 0,
        '5': toNumber(stat.fiveStarNum) ?? 0,
    };

    const reviewSamples = Array.isArray(data.evaViewList) ? data.evaViewList.map(toSample) : [];

    const authenticityKeywords = Array.isArray(data.impressionDTOList)
        ? data.impressionDTOList.map((i) => toStr(asRecord(i).content)).filter((s): s is string => s !== null)
        : [];

    // "reviews carrying photos" count, read from the `image` filter bucket.
    const filterStats = asRecord(data.filterInfo).filterStatistic;
    const imageStat = Array.isArray(filterStats)
        ? filterStats.find((f) => asRecord(f).filterCode === 'image')
        : undefined;
    const buyerImageCount = imageStat ? toNumber(asRecord(imageStat).filterCount) : null;

    return {
        rating: toNumber(stat.evarageStar),
        reviewCount: toNumber(stat.totalNum),
        ratingBreakdown,
        reviewSamples,
        authenticityKeywords,
        buyerMediaCounts: { images: buyerImageCount ?? 0, videos: 0 },
    };
}

/**
 * Build a {@link ReviewsSummary} by fetching reviews per star rating: one API call per star (1→5),
 * keeping at most `perStar` sample reviews from each. The overall rating, per-star breakdown and
 * keywords are filter-independent, so they're taken from the first call that returns a usable shape.
 *
 * The MTOP calls share a single JSONP callback name, so they MUST run sequentially. Returns `null`
 * when no star call yielded a recognizable response.
 */
export async function collectProductReviews(
    page: Page,
    productId: string | number,
    sellerAdminSeq: string | number | null,
    log: Log,
    opts: { perStar?: number } = {},
): Promise<ReviewsSummary | null> {
    const perStar = opts.perStar ?? 5;
    let summary: ReviewsSummary | null = null;
    const reviewSamples: ReviewSample[] = [];

    // Highest stars first so the most positive reviews lead the sample list.
    for (let star = 5; star >= 1; star -= 1) {
        const res = await fetchProductReviews(page, productId, sellerAdminSeq, log, { filter: star, pageSize: perStar });
        const parsed = parseProductReviews(res);
        if (!parsed) {
            continue;
        }
        // The statistic block is overall (not affected by `filter`); keep the first one we obtain.
        if (!summary) {
            summary = parsed;
        }
        reviewSamples.push(...parsed.reviewSamples.slice(0, perStar));
    }

    if (!summary) {
        return null;
    }
    log.info('product reviews collected', { perStar, samples: reviewSamples.length });
    return { ...summary, reviewSamples };
}

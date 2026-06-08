// Seller feedback — scraped straight from the store "Feedback" page DOM
// (`/store/feedback-score/<id>.html`), so `seller_only` mode needs neither the MTOP seller API nor a
// `sellerSeq`. The panel mirrors the fields the API path parses into `ParsedSellerInfo`:
//   - store header: shop name + "China | From Feb 09, 2026"
//   - "Store Credibility": an overall "store rating" (big 48px number) + three sub-scores
//     ("Items as description" / "Communication" / "Shipping speed"), each a label/value pair split
//     across two sibling columns (zip by index).
//   - "Customer reviews (N)": the positive-reviews percentage plus Positive / Neutral / Negative
//     counts (each a label span followed by its count span).
//
// The panel is fully inline-styled (class names are content-hashed), so we anchor on the stable
// English text labels and on the one distinctive inline-style fragment for the shop name.
import type { Log } from 'apify';
import type { Page } from 'playwright';

import type { SellerReviewSample } from './types.js';

/** One credibility score row, e.g. { title: "store rating", value: 4.8 }. Mirrors `SellerScore`. */
export interface FeedbackScore {
    title: string;
    value: number | null;
}

/** Seller feedback parsed from the store feedback page, using the same field names as the API path. */
export interface SellerFeedback {
    storeName: string | null;
    countryName: string | null;
    /** "Opened since" text as shown, e.g. "From Feb 09, 2026". */
    openedSinceText: string | null;
    positiveFeedbackPercent: number | null;
    positiveCount: number | null;
    neutralCount: number | null;
    negativeCount: number | null;
    /** Total customer reviews, from the "Customer reviews (N)" heading. */
    totalCount: number | null;
    /** Store rating + the three credibility sub-scores, in display order. */
    scores: FeedbackScore[];
}

/** The raw, unparsed strings read from the feedback panel before number coercion. */
interface RawFeedback {
    storeName: string | null;
    locationText: string | null;
    positivePercentText: string | null;
    totalText: string | null;
    positiveCountText: string | null;
    neutralCountText: string | null;
    negativeCountText: string | null;
    scores: { title: string; valueText: string | null }[];
}

/** First number (with optional decimals; commas stripped) in a string, e.g. "99.2%" → 99.2, "(389)" → 389. */
function num(text: string | null): number | null {
    if (!text) {
        return null;
    }
    const match = text.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
}

/** Collapse whitespace and trim; empty becomes null. */
function clean(value: string | null | undefined): string | null {
    const text = (value ?? '').replace(/\s+/g, ' ').trim();
    return text || null;
}

/**
 * Extract the seller's feedback from the store feedback page DOM. Every field is best-effort: a
 * panel that's missing a row still yields what it has, and a missing panel yields all-null / empty
 * scores rather than throwing.
 */
export async function extractSellerFeedback(page: Page, log?: Log): Promise<SellerFeedback> {
    const raw = await page
        .evaluate(() => {
            const textOf = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
            // The first element whose exact trimmed text equals `text` (labels are unique here).
            const findByText = (text: string): Element | undefined =>
                Array.from(document.querySelectorAll('span, div, p')).find((e) => textOf(e) === text);

            // Shop name — the one span styled at 20px in the header.
            const nameEl = document.querySelector('[style*="font-size: 20px"]');

            // "China | From Feb 09, 2026" — the span carrying the country/since line.
            const locEl = Array.from(document.querySelectorAll('span')).find((e) => /\|\s*From\s+/i.test(textOf(e)));

            // Store rating + sub-scores. The overall rating sits next to its "store rating" label; the
            // three sub-scores live as a label column followed by a sibling value column (zip by index).
            const scores: { title: string; valueText: string | null }[] = [];
            const ratingLabel = findByText('store rating');
            if (ratingLabel?.previousElementSibling) {
                scores.push({ title: 'store rating', valueText: textOf(ratingLabel.previousElementSibling) });
            }
            const itemsLabel = findByText('Items as description');
            const labelCol = itemsLabel?.parentElement ?? null;
            const valueCol = labelCol?.nextElementSibling ?? null;
            if (labelCol) {
                const labels = Array.from(labelCol.children).map(textOf);
                const values = valueCol ? Array.from(valueCol.children).map(textOf) : [];
                labels.forEach((title, i) => {
                    if (title) {
                        scores.push({ title, valueText: values[i] ?? null });
                    }
                });
            }

            // "positive reviews" → the percentage ("97" + ".4%") sits in a sibling row of the same
            // column. Rather than assume an exact child position, walk up from the label and grab the
            // first ancestor whose text contains a "NN.N%" — it's the only percentage in this block.
            let positivePercentText: string | null = null;
            let node: Element | null = findByText('positive reviews') ?? null;
            for (let i = 0; i < 4 && node; i++) {
                const m = (node.textContent || '').match(/(\d+(?:\.\d+)?)\s*%/);
                if (m) {
                    positivePercentText = m[1];
                    break;
                }
                node = node.parentElement;
            }

            // "Customer reviews (389)".
            const totalEl = Array.from(document.querySelectorAll('span')).find((e) => /customer reviews\s*\(/i.test(textOf(e)));

            // Each count is the span immediately after its label span.
            const countAfter = (label: string): string | null => {
                const el = findByText(label);
                return el?.nextElementSibling ? textOf(el.nextElementSibling) : null;
            };

            return {
                storeName: nameEl ? textOf(nameEl) : null,
                locationText: locEl ? textOf(locEl) : null,
                positivePercentText,
                totalText: totalEl ? textOf(totalEl) : null,
                positiveCountText: countAfter('Positive'),
                neutralCountText: countAfter('Neutral'),
                negativeCountText: countAfter('Negative'),
                scores,
            } as RawFeedback;
        })
        .catch(
            () =>
                ({
                    storeName: null,
                    locationText: null,
                    positivePercentText: null,
                    totalText: null,
                    positiveCountText: null,
                    neutralCountText: null,
                    negativeCountText: null,
                    scores: [],
                }) as RawFeedback,
        );

    // "China | From Feb 09, 2026" → country = "China", since = "From Feb 09, 2026".
    const [countryPart, sincePart] = (raw.locationText ?? '').split('|');

    const feedback: SellerFeedback = {
        storeName: clean(raw.storeName),
        countryName: clean(countryPart),
        openedSinceText: clean(sincePart),
        positiveFeedbackPercent: num(raw.positivePercentText),
        positiveCount: num(raw.positiveCountText),
        neutralCount: num(raw.neutralCountText),
        negativeCount: num(raw.negativeCountText),
        totalCount: num(raw.totalText),
        scores: raw.scores.map((s) => ({ title: s.title, value: num(s.valueText) })),
    };

    log?.info('seller feedback extracted', {
        storeName: feedback.storeName,
        positiveFeedbackPercent: feedback.positiveFeedbackPercent,
        totalCount: feedback.totalCount,
        scores: feedback.scores.length,
    });
    return feedback;
}

// --- Seller reviews, collected per star from the feedback page review list ----------------------
//
// Below the summary panel the feedback page lists reviews with a star filter bar ("All", media tabs,
// then "5".."1"). We click each star tab in turn and read the first `perStar` review cards under it.
// Each card is: a star row (skipped — the active filter IS the rating), a gray meta row
// ("Metal Color:X" + "User,Country,DD Mon YYYY"), the comment text, and buyer photos
// (`*.aliexpress-media.com`, vs. the `ae01.alicdn.com` star icons). Output matches `SellerReviewSample`.

/** Star ratings to sweep, high → low (matches the product-review collection order). */
const STAR_FILTERS = [5, 4, 3, 2, 1] as const;

/** One review card's raw strings, before splitting the meta line into user/country/date. */
interface RawReview {
    metaText: string;
    skuText: string | null;
    comment: string;
    images: string[];
}

/** Click the star-`n` filter tab (a `cursor:pointer` div whose only span is the digit + a star icon). */
async function clickStarTab(page: Page, star: number): Promise<boolean> {
    return page
        .evaluate((n) => {
            const tab = Array.from(document.querySelectorAll('div')).find((d) => {
                const span = d.querySelector(':scope > span');
                const img = d.querySelector(':scope > img');
                return (
                    !!span &&
                    !!img &&
                    (span.textContent || '').trim() === String(n) &&
                    /cursor:\s*pointer/.test(d.getAttribute('style') || '')
                );
            }) as HTMLElement | undefined;
            if (!tab) {
                return false;
            }
            tab.scrollIntoView({ block: 'center' });
            tab.click();
            return true;
        }, star)
        .catch(() => false);
}

/** Read every review card currently rendered in the list (raw, unparsed). */
async function readVisibleReviews(page: Page): Promise<RawReview[]> {
    return page
        .evaluate(() => {
            const dateRe = /\b\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}\b/;
            // The meta line's date span is gray (rgb(117,117,117)); its sibling is the SKU, its
            // parent row's parent is the whole review card.
            const metaSpans = Array.from(document.querySelectorAll('span')).filter(
                (s) => dateRe.test(s.textContent || '') && /color:\s*rgb\(117, 117, 117\)/.test(s.getAttribute('style') || ''),
            );
            const seen = new Set<Element>();
            const out: RawReview[] = [];
            for (const metaSpan of metaSpans) {
                const metaRow = metaSpan.parentElement;
                const card = metaRow?.parentElement;
                if (!metaRow || !card || seen.has(card)) {
                    continue;
                }
                seen.add(card);
                const metaText = (metaSpan.textContent || '').trim();
                const skuSpan = Array.from(metaRow.querySelectorAll('span')).find((s) => (s.textContent || '').trim() !== metaText);
                const commentEl = metaRow.nextElementSibling;
                const comment = commentEl ? (commentEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
                const images = Array.from(card.querySelectorAll('img'))
                    .map((i) => i.getAttribute('src') || '')
                    .filter((s) => /aliexpress-media/.test(s));
                out.push({ metaText, skuText: skuSpan ? (skuSpan.textContent || '').trim() : null, comment, images });
            }
            return out;
        })
        .catch(() => [] as RawReview[]);
}

/** Compact signature of the current list, used to wait until a star click actually swaps the reviews. */
async function listSignature(page: Page): Promise<string> {
    const raw = await readVisibleReviews(page);
    return `${raw.length}|${raw.slice(0, 3).map((r) => r.metaText).join('~')}`;
}

/** Promote a protocol-relative URL to https; pass everything else through. */
function ensureAbsolute(url: string): string {
    return url.startsWith('//') ? `https:${url}` : url;
}

/** Split "User,Country,DD Mon YYYY" → its parts. Date is last; country the part before it (when present). */
function toSample(raw: RawReview, rating: number): SellerReviewSample {
    const parts = raw.metaText
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
    const commentDate = parts.pop() ?? '';
    const country = parts.length >= 2 ? (parts.pop() ?? null) : null;
    const user = parts.join(', ');
    return {
        user,
        country,
        sku: raw.skuText,
        rating,
        commentDate,
        comment: raw.comment,
        commentTranslated: null,
        images: raw.images.map(ensureAbsolute),
    };
}

/**
 * Collect the seller's reviews from the feedback page DOM by clicking each star filter (5→1) and
 * reading up to `perStar` cards under each. The active star filter is the review's rating, so we
 * never parse the star glyphs. Returns the flattened list (at most `perStar * 5` reviews).
 */
export async function collectSellerReviewsFromDom(page: Page, log?: Log, perStar = 5): Promise<SellerReviewSample[]> {
    const reviews: SellerReviewSample[] = [];

    for (const star of STAR_FILTERS) {
        const before = await listSignature(page);
        const clicked = await clickStarTab(page, star);
        if (!clicked) {
            log?.info('seller reviews — star tab not found, skipping', { star });
            continue;
        }

        // Wait for the list to actually swap (or settle to empty) before reading, so we don't grab
        // the previous star's cards. Falls through after ~6.4s if the signature never changes.
        for (let i = 0; i < 16; i++) {
            await page.waitForTimeout(400);
            if ((await listSignature(page)) !== before) {
                break;
            }
        }

        const slice = (await readVisibleReviews(page)).slice(0, perStar).map((r) => toSample(r, star));
        reviews.push(...slice);
        log?.info('seller reviews collected for star', { star, count: slice.length });
    }

    log?.info('seller reviews (DOM) total', { count: reviews.length });
    return reviews;
}

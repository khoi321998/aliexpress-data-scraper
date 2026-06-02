// Product reviews extraction — the ratings summary + sample reviews from the AliExpress PDP.
//
// Like specifications/description, reviews share the `comet-v2-anchor` tab bar. But the full list
// lives in a **modal**: clicking the reviews "View more" opens a `comet-v2-modal-content` overlay
// that holds the rating header, the impression-keyword filters, and the review cards. So we click
// the "Customer Reviews" tab, open the modal, then read everything from inside it (scoping every
// selector to the modal so we never pick up the small inline reviewer widget at the top of the PDP).
//
// Class names are content-hashed per build, so every selector matches on a stable prefix.
import type { Log } from 'apify';
import type { Page } from 'playwright';

import type { ReviewSample, ReviewsSummary } from './types.js';

const ANCHOR_SELECTOR = 'a.comet-v2-anchor-link[href="#nav-review"], a[href="#nav-review"]';
// The review *list* section (lower on the page), where the "View more" lives — NOT the small
// inline reviewer widget near the title.
// The reviews "View more" — scoped to the review area so we don't catch the description's button.
const VIEW_MORE_SELECTOR =
    '#nav-review button, #nav-review [class*="extend--btn"], [class*="reviewer--"] button, [class*="review"] button';

/** Cap on sample reviews captured from the modal (keeps the dataset row a sane size). */
const MAX_SAMPLES = 40;

/** Promote a protocol-relative URL (`//host/…`) to https; pass everything else through. */
function ensureAbsolute(url: string): string {
    return url.startsWith('//') ? `https:${url}` : url;
}

/** Collapse whitespace and trim; treats null/undefined as empty. */
function clean(value: string | null | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** A review CARD inside an on-screen modal. waitForFunction polls this condition (no fixed sleeps). */
const MODAL_READY_FN = () => {
    const modals = Array.from(document.querySelectorAll('.comet-v2-modal-content'));
    // There can be several (hidden) modal containers; require the one with an actual review card
    // AND a non-zero box. The header renders before the cards, so keying on a card avoids reading
    // an empty modal.
    return modals.some(
        (m) => !!m.querySelector('[class*="list--itemBox"]') && (m as HTMLElement).getBoundingClientRect().height > 0,
    );
};

/**
 * Open the reviews modal: click the "Customer Reviews" tab, then its "View more" — exactly once.
 *
 * Waits on real elements/conditions (no fixed `waitForTimeout`): the tab, the trigger, then the
 * modal's review cards via `waitForFunction`. Clicking "View more" a second time would toggle the
 * modal shut, so we click once and then only wait. Best-effort — never throws.
 */
async function openReviewsModal(page: Page, log: Log): Promise<boolean> {
    // 1. Customer Reviews tab. Clicking it scrolls the (lazy) review list into view, mounting the
    //    "View more" trigger.
    const anchor = page.locator(ANCHOR_SELECTOR).first();
    await anchor.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
    await anchor.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
    await anchor.click({ timeout: 5_000 }).catch(() => undefined);

    // 2. The "View more" trigger — wait for it to render, then click ONCE (auto-scrolls into view).
    const viewMore = page.locator(VIEW_MORE_SELECTOR).filter({ hasText: /view more/i }).first();
    await viewMore.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    await viewMore.click({ timeout: 5_000 }).catch(() => undefined);

    // 3. Wait for the real condition — a review card present in an on-screen modal — not a delay.
    const opened = await page
        .waitForFunction(MODAL_READY_FN, undefined, { timeout: 15_000, polling: 300 })
        .then(() => true)
        .catch(() => false);

    if (!opened) {
        // Diagnostic: enumerate every "View more" trigger on the page so we can see the real one.
        const triggers = await page
            .evaluate(() => {
                const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));
                return els
                    .filter((el) => /view\s*more/i.test(el.textContent || ''))
                    .slice(0, 10)
                    .map((el) => ({
                        tag: el.tagName,
                        cls: (el.getAttribute('class') || '').slice(0, 80),
                        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
                        inReview: !!el.closest('#nav-review, [class*="reviewer"], [class*="review"]'),
                    }));
            })
            .catch(() => null);
        log.warning('reviews modal did not open — reading summary from the inline widget only', {
            url: page.url(),
            viewMoreTriggers: triggers,
        });
    }
    log.info('reviews modal open', { open: opened });
    return opened;
}

/** One raw review card, before normalization. */
interface RawItem {
    stars: number;
    sku: string;
    comment: string;
    info: string;
    images: string[];
}

/** Raw review payload read out of the page, before normalization. */
interface RawReviews {
    ratingText: string;
    countText: string;
    keywords: string[];
    imageCount: number;
    items: RawItem[];
}

/** Star levels to pull individually via the rating dropdown, and how many cards to keep per level. */
const STAR_LEVELS = [5, 4, 3, 2, 1] as const;
const MAX_PER_STAR = 5;

/**
 * Read the rating summary + review cards from the page in one round-trip. Reads from the modal
 * when present, otherwise from the inline reviewer widget (summary only — it has no cards).
 */
async function readReviews(page: Page, max: number): Promise<RawReviews | { error: string; modalCount?: number }> {
    return page
        .evaluate((maxItems) => {
            // NOTE: do NOT define named function expressions (e.g. `const text = () => …`) inside
            // this callback — tsx/esbuild wraps them with a `__name(...)` helper that does not exist
            // in the page context, throwing `ReferenceError: __name is not defined`. Inline
            // everything with optional chaining instead. Raw text is cleaned in Node by the caller.
            try {
                const modals = Array.from(document.querySelectorAll('.comet-v2-modal-content'));
                const root: Element | null =
                    modals.find((m) => m.querySelector('[class*="list--itemBox"]')) ??
                    modals[0] ??
                    document.querySelector('[class*="reviewer--wrap"]');
                if (!root) {
                    return { error: 'no-root', modalCount: modals.length };
                }

                // Rating value: from the modal title ("Reviews | 4.8") or the inline rating link.
                const ratingText =
                    root.querySelector('[class*="title--title"]')?.textContent ||
                    root.querySelector('[class*="reviewer--rating"]')?.textContent ||
                    '';
                // Review/ratings count: "307 ratings" (modal) or "52 Reviews" (inline).
                const countText =
                    root.querySelector('[class*="title--rating"]')?.textContent ||
                    root.querySelector('[class*="reviewer--reviews"]')?.textContent ||
                    '';

                const keywords = Array.from(root.querySelectorAll('[class*="filter--impression"]')).map(
                    (e) => e.textContent ?? '',
                );

                let imageCount = 0;
                for (const fi of Array.from(root.querySelectorAll('[class*="filter--filterItem"]'))) {
                    if (fi.querySelector('.comet-icon-photo')) {
                        const m = (fi.textContent ?? '').match(/\((\d+)\)/);
                        if (m) {
                            imageCount = Number(m[1]);
                        }
                    }
                }

                const items = Array.from(root.querySelectorAll('[class*="list--itemBox"]'))
                    .slice(0, maxItems)
                    .map((box) => ({
                        stars: box.querySelectorAll('[class*="stars--box"] .comet-icon-starreviewfilled').length,
                        sku: box.querySelector('[class*="list--itemSku"]')?.textContent ?? '',
                        comment: box.querySelector('[class*="list--itemReview"]')?.textContent ?? '',
                        info: box.querySelector('[class*="list--itemInfo"]')?.textContent ?? '',
                        images: Array.from(box.querySelectorAll('[class*="list--itemThumbnail"] img'))
                            .map((i) => i.getAttribute('src') ?? '')
                            .filter(Boolean),
                    }));

                return { ratingText, countText, keywords, imageCount, items };
            } catch (e) {
                return { error: `throw: ${String((e as Error)?.stack ?? e)}` };
            }
        }, max)
        .catch((e) => ({ error: `evaluate-rejected: ${String(e)}` }));
}

/** Parse the first decimal number out of a string (e.g. "Reviews | 4.8" → 4.8). */
function parseRating(text: string): number | null {
    const m = text.match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : null;
}

/** Parse the first integer (with separators) out of a string (e.g. "307 ratings" → 307). */
function parseCount(text: string): number | null {
    const m = text.match(/([\d.,]+)/);
    if (!m) {
        return null;
    }
    const value = Number(m[1].replace(/[.,]/g, ''));
    return Number.isFinite(value) ? value : null;
}

/** Split an info line ("g***r | 31 Aug 2025") into user + date. */
function splitInfo(info: string): { user: string; date: string } {
    const [user, ...rest] = info.split('|');
    return { user: clean(user), date: clean(rest.join('|')) };
}

/** Read up to `max` review cards currently shown in the modal. (No named fns inside evaluate.) */
async function readItems(page: Page, max: number): Promise<RawItem[]> {
    const result = await page
        .evaluate((maxItems) => {
            const modals = Array.from(document.querySelectorAll('.comet-v2-modal-content'));
            const root = modals.find((m) => m.querySelector('[class*="list--itemBox"]')) ?? modals[0] ?? null;
            if (!root) {
                return [] as RawItem[];
            }
            return Array.from(root.querySelectorAll('[class*="list--itemBox"]'))
                .slice(0, maxItems)
                .map((box) => ({
                    stars: box.querySelectorAll('[class*="stars--box"] .comet-icon-starreviewfilled').length,
                    sku: box.querySelector('[class*="list--itemSku"]')?.textContent ?? '',
                    comment: box.querySelector('[class*="list--itemReview"]')?.textContent ?? '',
                    info: box.querySelector('[class*="list--itemInfo"]')?.textContent ?? '',
                    images: Array.from(box.querySelectorAll('[class*="list--itemThumbnail"] img'))
                        .map((i) => i.getAttribute('src') ?? '')
                        .filter(Boolean),
                })) as RawItem[];
        }, max)
        .catch(() => [] as RawItem[]);
    return result;
}

/**
 * Open the rating dropdown and select the "<star> Star" option. Returns true once the filter is
 * applied (the dropdown trigger text reflects the chosen level). Best-effort — never throws.
 */
async function selectStar(page: Page, star: number, log: Log): Promise<boolean> {
    // CRITICAL: the page has TWO identical review widgets (inline `#nav-review` + the modal) with
    // the SAME class names — scope the dropdown to the MODAL.
    const triggerItem = page
        .locator('.comet-v2-modal-content [class*="filter--wrap"] [class*="filter--filterItem"]')
        .first();
    const trigger = triggerItem.locator('button').first();
    await triggerItem.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);

    // Open the hover-menu and click the option with a REAL mouse path: move to the trigger (opens
    // the menu), then move *in steps* to the option (keeps the hover-menu open along the way), then
    // click at the option's coordinates. Synthetic hover + dispatchEvent only applied intermittently
    // and with a lag; a faithful mouse path is what reliably registers the filter.
    const option = page.getByText(`${star} Star`, { exact: true }).first();
    let clicked = false;
    for (let attempt = 0; attempt < 5 && !clicked; attempt += 1) {
        const tbox = await trigger.boundingBox().catch(() => null);
        if (tbox) {
            await page.mouse.move(tbox.x + tbox.width / 2, tbox.y + tbox.height / 2, { steps: 4 }).catch(() => undefined);
        } else {
            await trigger.hover({ timeout: 3_000 }).catch(() => undefined);
        }
        await page.waitForTimeout(400);
        if (!(await option.isVisible().catch(() => false))) {
            continue; // menu didn't open this round — retry
        }
        const obox = await option.boundingBox().catch(() => null);
        if (!obox) {
            continue;
        }
        const ox = obox.x + obox.width / 2;
        const oy = obox.y + obox.height / 2;
        await page.mouse.move(ox, oy, { steps: 4 }).catch(() => undefined); // travel keeps menu open
        await page.mouse.click(ox, oy).catch(() => undefined);
        clicked = true;
    }
    if (!clicked) {
        log.warning('rating dropdown option not openable', { star });
        return false;
    }

    // Confirm the filter REALLY applied: the modal's dropdown trigger must read "<star> Star" AND
    // every visible card must show exactly `star` filled stars. The filter triggers an async list
    // reload (clears then refills, with a lag), so we wait on this combined condition with a
    // generous timeout — never accepting a transiently-empty/stale list. A star that genuinely has
    // reviews can be slow to render, so we must NOT short-circuit to "empty" early.
    const sawCards = await page
        .waitForFunction(
            (s) => {
                const modal = document.querySelector('.comet-v2-modal-content');
                if (!modal) {
                    return false;
                }
                const btn = modal.querySelector('[class*="filter--wrap"] [class*="filter--filterItem"] button');
                if (!btn || !(btn.textContent ?? '').includes(`${s} Star`)) {
                    return false; // dropdown not on this star yet
                }
                const cards = Array.from(modal.querySelectorAll('[class*="list--itemBox"]')).filter(
                    (c) => (c as HTMLElement).getBoundingClientRect().height > 0,
                );
                if (cards.length === 0) {
                    return false; // wait for cards (a genuinely-empty star is handled after timeout)
                }
                return cards.every(
                    (c) => c.querySelectorAll('[class*="stars--box"] .comet-icon-starreviewfilled').length === s,
                );
            },
            star,
            { timeout: 15_000, polling: 300 },
        )
        .then(() => true)
        .catch(() => false);

    if (sawCards) {
        return true;
    }

    // No cards arrived within the timeout. That's legitimately a star with 0 reviews ONLY if the
    // dropdown is on this star and the list has truly settled empty.
    const emptyConfirmed = await page
        .evaluate((s) => {
            const modal = document.querySelector('.comet-v2-modal-content');
            if (!modal) {
                return false;
            }
            const btn = modal.querySelector('[class*="filter--wrap"] [class*="filter--filterItem"] button');
            if (!btn || !(btn.textContent ?? '').includes(`${s} Star`)) {
                return false;
            }
            const cards = Array.from(modal.querySelectorAll('[class*="list--itemBox"]')).filter(
                (c) => (c as HTMLElement).getBoundingClientRect().height > 0,
            );
            return cards.length === 0;
        }, star)
        .catch(() => false);

    if (emptyConfirmed) {
        return true; // genuine 0 reviews at this star level
    }

    const diag = await page
        .evaluate(() => {
            const modal = document.querySelector('.comet-v2-modal-content');
            const btn = modal?.querySelector('[class*="filter--wrap"] [class*="filter--filterItem"] button');
            const cards = modal
                ? Array.from(modal.querySelectorAll('[class*="list--itemBox"]'))
                      .filter((c) => (c as HTMLElement).getBoundingClientRect().height > 0)
                      .map((c) => c.querySelectorAll('[class*="stars--box"] .comet-icon-starreviewfilled').length)
                : null;
            return { triggerText: (btn?.textContent ?? '').trim().slice(0, 20), cardStars: cards };
        })
        .catch(() => null);
    log.warning('star filter not confirmed', { star, ...(diag ?? {}) });
    return false;
}

/**
 * Extract the reviews summary + sample reviews.
 *
 * Opens the modal, reads the rating header, impression keywords, photo count, and review cards,
 * then maps them onto the {@link ReviewsSummary} DTO. All samples go into a single `reviewSamples`
 * array, each carrying its own star `rating` — AliExpress only exposes a star count per review, no
 * positive/negative labelling, so we don't synthesise one. `ratingBreakdown` stays zeroed (the
 * per-star counts are only available behind the modal's rating dropdown, which we do not open).
 */
export async function extractReviews(page: Page, log: Log): Promise<ReviewsSummary> {
    const summary: ReviewsSummary = {
        rating: null,
        reviewCount: null,
        ratingBreakdown: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
        reviewSamples: [],
        authenticityKeywords: [],
        buyerMediaCounts: { images: 0, videos: 0 },
    };

    await openReviewsModal(page, log);

    // Diagnostic: how many modals are in the DOM right now, and which have review cards.
    const modalDiag = await page
        .evaluate(() => {
            const modals = Array.from(document.querySelectorAll('.comet-v2-modal-content'));
            return {
                modalCount: modals.length,
                withCards: modals.filter((m) => !!m.querySelector('[class*="list--itemBox"]')).length,
                titleHits: document.querySelectorAll('[class*="title--title"]').length,
                cardHits: document.querySelectorAll('[class*="list--itemBox"]').length,
            };
        })
        .catch(() => null);
    log.info('reviews DOM diag', modalDiag ?? {});

    const raw = await readReviews(page, MAX_SAMPLES);
    if ('error' in raw) {
        log.warning('reviews read failed', { url: page.url(), ...raw });
        return summary;
    }
    log.info('reviews raw read', {
        ratingText: raw.ratingText,
        countText: raw.countText,
        items: raw.items.length,
        keywords: raw.keywords.length,
    });

    summary.rating = parseRating(clean(raw.ratingText));
    summary.reviewCount = parseCount(clean(raw.countText));
    log.info('reviews parsed', { rating: summary.rating, reviewCount: summary.reviewCount });

    summary.buyerMediaCounts.images = raw.imageCount;
    // Strip the trailing "(NN)" count off each impression keyword: "elegant appearance (18)".
    summary.authenticityKeywords = raw.keywords.map((k) => clean(k.replace(/\s*\(\d+\)\s*$/, ''))).filter(Boolean);

    // Pull samples per star level via the rating dropdown — up to MAX_PER_STAR cards each.
    const samples: ReviewSample[] = [];
    for (const star of STAR_LEVELS) {
        if (!(await selectStar(page, star, log))) {
            continue;
        }
        const items = await readItems(page, MAX_PER_STAR);
        log.info('star reviews', { star, count: items.length });
        for (const item of items) {
            const { user, date } = splitInfo(item.info);
            samples.push({
                user,
                userFeedbackScore: null,
                comment: clean(item.comment),
                commentDate: date,
                rating: star, // The level we filtered by (reliable; the card icons match it).
                verifiedPurchase: true, // The modal header states "All from verified purchases".
                sku: clean(item.sku) || null,
                images: item.images.map((src) => ensureAbsolute(src.trim())),
            });
        }
    }
    summary.reviewSamples = samples;

    return summary;
}

// Seller product previews — the "Recommended from <store> Store" strip at the bottom of the PDP.
//
// AliExpress renders a grid of the seller's other products in a block tagged
// `data-spm="pcDetailBottomMoreThisSeller"`. Each card is an `<a href="…/item/<id>.html">` holding
// the thumbnail (`img.product-img`), the title (`h3`), the current price (the card's price wrapper
// carries it as an `aria-label`, e.g. "₫4,932,027"), a struck-through original price
// (`[style*="line-through"]`), a discount badge ("-50%") and a sold count ("7 sold").
//
// Class names are content-hashed per build, so we anchor on the stable `data-spm` attribute and on
// the unhashed `product-img` class, then read everything else by relative DOM traversal + text.
import type { Log } from 'apify';
import type { Page } from 'playwright';

import type { SellerProductPreview } from './types.js';
import { extractAliExpressItemId } from './url.js';

// The recommendation grid. `data-spm` is semantic and stable across builds (unlike the hashed
// class names), so it's our anchor for the whole block.
const GRID_SELECTOR = '[data-spm="pcDetailBottomMoreThisSeller"]';

/** One card's raw, unparsed strings as read straight from the DOM. */
interface RawPreview {
    href: string | null;
    image: string | null;
    title: string | null;
    priceText: string | null;
    originalPriceText: string | null;
    discountText: string | null;
    soldText: string | null;
}

/** Promote a protocol-relative URL (`//host/…`) to https; pass everything else through, null stays null. */
function ensureAbsolute(url: string | null): string | null {
    if (!url) {
        return null;
    }
    return url.startsWith('//') ? `https:${url}` : url;
}

/** Collapse whitespace and trim; null/undefined become null (never an empty string). */
function clean(value: string | null | undefined): string | null {
    const text = (value ?? '').replace(/\s+/g, ' ').trim();
    return text || null;
}

/**
 * Parse a localized price string ("₫4,932,027", "$12.34") into a number, best-effort.
 *
 * Keeps only the numeric run, then decides whether the separators are decimal or thousands: when
 * both `.` and `,` appear, the last one is the decimal point; when only one appears, it's treated
 * as a decimal point only if it's a single separator with ≤2 trailing digits, else as a thousands
 * grouping. Returns null when no digits are present.
 */
export function parseMoney(text: string | null): number | null {
    if (!text) {
        return null;
    }
    const match = text.match(/[\d][\d.,\s]*\d|\d/);
    if (!match) {
        return null;
    }
    let s = match[0].replace(/\s/g, '');
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastDot !== -1 && lastComma !== -1) {
        // Both present: the rightmost separator is the decimal point; the other groups thousands.
        const decimalSep = lastDot > lastComma ? '.' : ',';
        const thousandsSep = decimalSep === '.' ? ',' : '.';
        s = s.split(thousandsSep).join('').replace(decimalSep, '.');
    } else if (lastDot !== -1 || lastComma !== -1) {
        const sep = lastDot !== -1 ? '.' : ',';
        const parts = s.split(sep);
        const decimalLike = parts.length === 2 && parts[1].length > 0 && parts[1].length <= 2;
        s = decimalLike ? parts.join('.') : parts.join('');
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

/** Pull the first integer out of a string (commas/dots stripped), e.g. "1,000+ sold" → 1000. */
function parseCount(text: string | null): number | null {
    if (!text) {
        return null;
    }
    const match = text.replace(/[.,]/g, '').match(/\d+/);
    return match ? Number(match[0]) : null;
}

/** Parse the discount magnitude as a positive percent, e.g. "-50%" → 50. */
function parseDiscountPercent(text: string | null): number | null {
    if (!text) {
        return null;
    }
    const match = text.match(/(\d+)\s*%/);
    return match ? Number(match[1]) : null;
}

/**
 * Extract up to `limit` of the seller's other-product previews from the PDP recommendation strip.
 *
 * Returns an empty array when the block is absent (not every PDP renders it). Best-effort per field:
 * a card missing a price or sold count still contributes what it has.
 */
export async function extractSellerProductPreviews(page: Page, log?: Log, limit = 10): Promise<SellerProductPreview[]> {
    const raw = await page
        .evaluate((gridSelector) => {
            const grid = document.querySelector(gridSelector);
            if (!grid) {
                return [] as RawPreview[];
            }
            return Array.from(grid.querySelectorAll('a[href*="/item/"]')).map((card) => {
                const img = card.querySelector('img.product-img');
                const titleEl = card.querySelector('h3');
                const origEl = card.querySelector('[style*="line-through"]');

                // The current-price wrapper carries the price as an aria-label. It's the nearest
                // labelled ancestor of the struck-through original; without a discount, fall back to
                // the first aria-label on the card that looks like money (digits + separators only).
                const wrap = origEl ? origEl.closest('[aria-label]') : null;
                let priceText = wrap ? wrap.getAttribute('aria-label') : null;
                if (!priceText) {
                    priceText =
                        Array.from(card.querySelectorAll('[aria-label]'))
                            .map((el) => (el.getAttribute('aria-label') || '').trim())
                            .find((t) => /^[^\dA-Za-z]{0,4}\d[\d.,\s]*$/.test(t)) || null;
                }

                const discountEl = Array.from(card.querySelectorAll('span')).find((el) =>
                    /-\s*\d+\s*%/.test(el.textContent || ''),
                );
                const soldEl = Array.from(card.querySelectorAll('span, div')).find(
                    (el) => el.children.length === 0 && /[\d.,]+\s*sold/i.test((el.textContent || '').trim()),
                );

                return {
                    href: card.getAttribute('href'),
                    image: img ? img.getAttribute('src') : null,
                    title: titleEl ? titleEl.textContent : null,
                    priceText,
                    originalPriceText: origEl ? origEl.textContent : null,
                    discountText: discountEl ? discountEl.textContent : null,
                    soldText: soldEl ? soldEl.textContent : null,
                };
            });
        }, GRID_SELECTOR)
        .catch(() => [] as RawPreview[]);

    const previews = raw.slice(0, limit).map((card) => {
        const url = ensureAbsolute(card.href);
        const priceText = clean(card.priceText);
        const originalPriceText = clean(card.originalPriceText);
        return {
            productId: card.href ? extractAliExpressItemId(card.href) : null,
            title: clean(card.title),
            url,
            imageUrl: ensureAbsolute(card.image),
            price: parseMoney(priceText),
            priceText,
            originalPrice: parseMoney(originalPriceText),
            originalPriceText,
            discountPercent: parseDiscountPercent(card.discountText),
            soldCount: parseCount(card.soldText),
            soldText: clean(card.soldText),
        };
    });

    log?.info('seller product previews extracted', { count: previews.length });
    return previews;
}

// --- Store "All items" listing grid -------------------------------------------------------------
//
// The `seller_only` pipeline navigates to `/store/<id>/pages/all-items.html`, whose product grid is
// a DIFFERENT layout from the PDP strip above: a `display:grid` of fully inline-styled cards (no
// `product-img` class, no `aria-label` price). Each card is an `<a ae_object_type="product"
// href="…/item/<id>.html">` that carries a `utlogmap` attribute (URL-encoded JSON with `x_object_id`
// / `prod` and `star_rating`), shows the title in a `span[numberoflines]` / the image `alt`, splits
// the current price across several big-font (`font-size: 24px`) spans, and renders the original price
// struck through (`text-decoration: line-through`). We anchor on the stable `ae_object_type` /
// `numberoflines` / inline-style fragments rather than the hashed class names.

/** The product cards on the store all-items page; `ae_object_type="product"` is stable across builds. */
const ALL_ITEMS_CARD_SELECTOR = 'a[ae_object_type="product"][href*="/item/"]';

/** One all-items card's raw strings, plus the `utlogmap`-derived product id as a fallback. */
interface RawStorePreview {
    href: string | null;
    image: string | null;
    title: string | null;
    priceText: string | null;
    originalPriceText: string | null;
    soldText: string | null;
    /** Product id read from the card's `utlogmap` JSON, used when the href has no `/item/<id>`. */
    utProductId: string | null;
}

/**
 * Extract up to `limit` product previews from the store's all-items grid
 * (`/store/<id>/pages/all-items.html`), de-duplicated by product id.
 *
 * Returns an empty array when no product cards are present. Best-effort per field; `discountPercent`
 * is derived from the current vs. original price (the grid shows a "Save ₫…" string, not a "-NN%"
 * badge), so it's only set when both prices parse.
 */
export async function extractStoreAllItemsPreviews(page: Page, log?: Log, limit = 60): Promise<SellerProductPreview[]> {
    const raw = await page
        .evaluate((cardSelector) => {
            return Array.from(document.querySelectorAll(cardSelector)).map((card) => {
                // Product image: the first <img> with a real (http/protocol-relative) src — skips the
                // inline base64 rating-star and badge images that share the card.
                const productImg = Array.from(card.querySelectorAll('img')).find((im) =>
                    /^(https?:)?\/\//.test(im.getAttribute('src') || ''),
                );

                const titleEl = card.querySelector('span[numberoflines]');
                const title = (titleEl ? titleEl.textContent : null) || (productImg ? productImg.getAttribute('alt') : null);

                // Original price is the struck-through node; the current price lives in its sibling
                // big-font spans. The price row is the parent of either, and its text concatenates both
                // (e.g. "₫35,706₫59,401"), so we strip the original back out to isolate the current price.
                const origEl = card.querySelector('[style*="line-through"]');
                const originalPriceText = origEl ? origEl.textContent : null;
                const bigEl = card.querySelector('[style*="font-size: 24px"]');
                const priceRow = (bigEl && bigEl.parentElement) || (origEl && origEl.parentElement) || null;
                let priceText: string | null = priceRow ? priceRow.textContent : null;
                if (priceText && originalPriceText) {
                    priceText = priceText.split(originalPriceText).join('');
                }

                // Sold count is a leaf node like "800+ sold".
                const soldEl = Array.from(card.querySelectorAll('div, span')).find(
                    (el) => el.children.length === 0 && /[\d.,]+\+?\s*sold/i.test((el.textContent || '').trim()),
                );

                // Fallback product id from the card's tracking map (URL-encoded JSON).
                let utProductId: string | null = null;
                const ut = card.getAttribute('utlogmap');
                if (ut) {
                    try {
                        const m = JSON.parse(decodeURIComponent(ut)) as { x_object_id?: unknown; prod?: unknown };
                        const id = m.x_object_id ?? m.prod;
                        utProductId = id != null ? String(id) : null;
                    } catch {
                        utProductId = null;
                    }
                }

                return {
                    href: card.getAttribute('href'),
                    image: productImg ? productImg.getAttribute('src') : null,
                    title,
                    priceText,
                    originalPriceText,
                    soldText: soldEl ? soldEl.textContent : null,
                    utProductId,
                } as RawStorePreview;
            });
        }, ALL_ITEMS_CARD_SELECTOR)
        .catch(() => [] as RawStorePreview[]);

    const seen = new Set<string>();
    const previews: SellerProductPreview[] = [];
    for (const card of raw) {
        const productId = (card.href && extractAliExpressItemId(card.href)) || card.utProductId;
        // De-duplicate by product id (a card can repeat if a slot is re-rendered); keep id-less cards too.
        if (productId) {
            if (seen.has(productId)) continue;
            seen.add(productId);
        }

        const priceText = clean(card.priceText);
        const originalPriceText = clean(card.originalPriceText);
        const price = parseMoney(priceText);
        const originalPrice = parseMoney(originalPriceText);
        const discountPercent =
            price != null && originalPrice != null && originalPrice > 0 ? Math.round((1 - price / originalPrice) * 100) : null;

        previews.push({
            productId,
            title: clean(card.title),
            url: ensureAbsolute(card.href),
            imageUrl: ensureAbsolute(card.image),
            price,
            priceText,
            originalPrice,
            originalPriceText,
            discountPercent,
            soldCount: parseCount(card.soldText),
            soldText: clean(card.soldText),
        });

        if (previews.length >= limit) break;
    }

    log?.info('store all-items previews extracted', { count: previews.length });
    return previews;
}

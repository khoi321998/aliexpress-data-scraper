// Product pricing extraction — the headline price from the AliExpress PDP price block.
//
// The price lives in `.price-default--wrap` › `.price-default--current` as a localized,
// currency-prefixed string (e.g. `₫1,209,822`, `$12.99`, `€12,99`). Class names are
// content-hashed per build, so we match on the stable `price-default--current` prefix and parse
// the currency symbol + numeric amount out of the text ourselves.
import type { Page } from 'playwright';

import type { Pricing } from './types.js';

// The discounted/headline price. Fall through progressively looser selectors so a markup tweak
// that renames the suffix still yields the value.
const CURRENT_PRICE_SELECTOR = '[class*="price-default--current--"], [class*="price-default--current"]';

// Map the leading currency symbol AliExpress renders to its ISO 4217 code. Falls back to the
// raw symbol when unknown so the information is never lost.
const CURRENCY_SYMBOLS: Record<string, string> = {
    '₫': 'VND',
    $: 'USD',
    '€': 'EUR',
    '£': 'GBP',
    '¥': 'JPY',
    '₽': 'RUB',
    '₹': 'INR',
    '₩': 'KRW',
    '₺': 'TRY',
    '₴': 'UAH',
    R$: 'BRL',
};

/**
 * Pull the ISO currency code out of a localized price string.
 *
 * Matches the non-numeric prefix (`₫`, `R$`, `US $`, …) against {@link CURRENCY_SYMBOLS},
 * trying the longest symbols first; returns the raw symbol if it is not in the map, or `null`
 * when the string carries no symbol at all.
 */
export function parseCurrency(text: string): string | null {
    const symbol = text.replace(/[\d.,\s]/g, '').trim();
    if (!symbol) {
        return null;
    }
    for (const known of Object.keys(CURRENCY_SYMBOLS).sort((a, b) => b.length - a.length)) {
        if (symbol.includes(known)) {
            return CURRENCY_SYMBOLS[known];
        }
    }
    return symbol;
}

/**
 * Parse a localized price string into a number, handling both `,`-decimal (EU) and `.`-decimal
 * (US) conventions plus thousands separators.
 *
 * `₫1,209,822` → `1209822`, `$12.99` → `12.99`, `€12,99` → `12.99`, `1.234,56` → `1234.56`.
 * Returns `null` when no digits are present.
 */
export function parsePrice(text: string): number | null {
    const cleaned = text.replace(/[^\d.,]/g, '');
    if (!cleaned) {
        return null;
    }

    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');

    let decimalSep = '';
    if (lastComma !== -1 && lastDot !== -1) {
        // Both present — the rightmost separator is the decimal point.
        decimalSep = lastComma > lastDot ? ',' : '.';
    } else if (lastComma !== -1 && cleaned.split(',').length === 2 && cleaned.split(',')[1].length <= 2) {
        // A lone comma followed by ≤2 digits is a decimal point (€12,99); otherwise thousands.
        decimalSep = ',';
    } else if (lastDot !== -1 && cleaned.split('.').length === 2 && cleaned.split('.')[1].length <= 2) {
        decimalSep = '.';
    }

    let normalized: string;
    if (decimalSep) {
        const thousandSep = decimalSep === ',' ? '.' : ',';
        normalized = cleaned.split(thousandSep).join('').replace(decimalSep, '.');
    } else {
        normalized = cleaned.replace(/[.,]/g, '');
    }

    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
}

/**
 * Extract the price range from the PDP price block.
 *
 * Reads the current-price text from a single selector and parses out the currency and numeric
 * amount(s). AliExpress renders a range (`₫1,000 - ₫2,000`) in this same element when a product
 * has SKU variants at different prices, and a single value otherwise — so `priceMin`/`priceMax`
 * both come from this one selector: the two ends of the range, or the same value when there's no
 * range.
 */
export async function extractPricing(page: Page): Promise<Pricing> {
    const text = await page
        .locator(CURRENT_PRICE_SELECTOR)
        .first()
        .textContent({ timeout: 2_000 })
        .catch(() => null);

    const raw = text?.trim() ?? '';

    // Split a range like `₫1,000 - ₫2,000` on the separating dash (en/em dash or hyphen). A lone
    // value yields a single part used for both ends.
    const parts = raw
        .split(/\s[-–—]\s/)
        .map((part) => parsePrice(part))
        .filter((value): value is number => value !== null);

    const priceMin = parts.length > 0 ? Math.min(...parts) : null;
    const priceMax = parts.length > 0 ? Math.max(...parts) : null;

    return {
        currency: parseCurrency(raw) ?? '',
        priceMin,
        priceMax,
    };
}

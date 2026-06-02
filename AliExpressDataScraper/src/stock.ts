// Product stock extraction — availability + lifetime sales from the AliExpress PDP.
//
// Two separate signals from two blocks:
//   • Available quantity — the right-side action panel renders the remaining stock next to the
//     quantity picker, e.g. `888 available`, in `[class*="quantity--info"]`.
//   • Sold count — the reviewer summary above the price shows lifetime sales, e.g. `127 sold`,
//     in `[class*="reviewer--sold"]`.
//
// Class names are content-hashed per build, so we match on the stable `quantity--info` /
// `reviewer--sold` prefixes and parse the integers out of the text ourselves.
import type { Page } from 'playwright';

import type { Stock } from './types.js';

const QUANTITY_INFO_SELECTOR = '[class*="quantity--info"]';
const SOLD_COUNT_SELECTOR = '[class*="reviewer--sold"]';

// Matches the leading run of digits (with thousands separators) before the word "available".
const AVAILABLE_QTY_RE = /([\d.,]+)\s*available/i;

// Matches the leading run of digits (with thousands separators) before the word "sold".
const SOLD_COUNT_RE = /([\d.,]+)\s*sold/i;

/**
 * Parse the integer count preceding a keyword (`available` / `sold`) out of a localized label.
 *
 * Strips thousands separators (`.`/`,`) — these counts are always whole numbers, so there is no
 * decimal ambiguity to resolve. Returns `null` when no count is present.
 */
function parseCount(text: string, re: RegExp): number | null {
    const match = re.exec(text);
    if (!match) {
        return null;
    }
    const digits = match[1].replace(/[.,]/g, '');
    const value = Number(digits);
    return Number.isFinite(value) ? value : null;
}

/** Parse the integer stock count out of an "N available" label. */
export function parseAvailableQuantity(text: string): number | null {
    return parseCount(text, AVAILABLE_QTY_RE);
}

/** Parse the integer sales count out of an "N sold" label. */
export function parseSoldCount(text: string): number | null {
    return parseCount(text, SOLD_COUNT_RE);
}

/**
 * Extract the stock signals from the page.
 *
 * Best-effort: a missing panel/summary (or a layout without a visible count) leaves the
 * respective field null rather than failing the scrape.
 */
export async function extractStock(page: Page): Promise<Stock> {
    const availableText = await page
        .locator(QUANTITY_INFO_SELECTOR)
        .first()
        .textContent({ timeout: 2_000 })
        .catch(() => null);

    const soldText = await page
        .locator(SOLD_COUNT_SELECTOR)
        .first()
        .textContent({ timeout: 2_000 })
        .catch(() => null);

    return {
        availableQuantity: parseAvailableQuantity(availableText ?? ''),
        soldCount: parseSoldCount(soldText ?? ''),
    };
}

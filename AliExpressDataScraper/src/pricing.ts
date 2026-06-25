// Price-string parsing helpers — turn a localized, currency-prefixed price string
// (e.g. `₫1,209,822`, `$12.99`, `€12,99`) into an ISO currency code + numeric amount.
//
// Consumed by `productApi.ts`, which reads prices out of the `pdp.pc.query` JSON
// (`salePriceString` / `originalPrice`) rather than the page DOM.

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

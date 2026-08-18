// Price-string parsing helper — turns a localized, currency-prefixed price string
// (e.g. `₫1,209,822`, `$12.99`, `€12,99`) into a numeric amount.
//
// Consumed by `productApi.ts`, which reads prices out of the `pdp.pc.query` JSON
// (`salePriceString`) rather than the page DOM. The ISO currency code is NOT derived here: it is
// read straight off the amount objects the API returns (see `parseCurrencyCode`), because guessing
// it from the symbol is lossy — `$` is as much CAD/AUD/MXN as it is USD.

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

/**
 * Normalize any AliExpress product URL the user pastes into the canonical form:
 *
 *     https://www.aliexpress.com/item/<itemId>.html
 *
 * Why: the locale subdomain (`vi.`, `de.`, `m.`, `us.`, ...) and query string are
 * themselves region/tracking signals that conflict with our proxy country. Stripping
 * them to the neutral `www` host lets the proxy decide locale deterministically, so
 * results stay consistent no matter which subdomain the user pasted.
 *
 * Examples:
 *   https://vi.aliexpress.com/item/1005009982221130.html      -> https://www.aliexpress.com/item/1005009982221130.html
 *   https://www.aliexpress.com/item/1005010695338136.html?spm=a2g0o.x -> https://www.aliexpress.com/item/1005010695338136.html
 *   https://m.aliexpress.com/item/1005009982221130.html       -> https://www.aliexpress.com/item/1005009982221130.html
 *
 * Returns `null` if the input is not a recognizable AliExpress product URL.
 */
export function normalizeAliExpressUrl(raw: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(raw.trim());
    } catch {
        return null;
    }

    // Accept any AliExpress host/subdomain on the .com or .us TLD.
    if (!/(^|\.)aliexpress\.(com|us)$/i.test(parsed.hostname)) {
        return null;
    }

    // The product id is the run of digits in `/item/<id>.html` (the `.html` is optional).
    const match = parsed.pathname.match(/\/item\/(\d+)(?:\.html)?/i);
    if (!match) {
        return null;
    }

    return `https://www.aliexpress.com/item/${match[1]}.html`;
}

/**
 * Extract the numeric AliExpress product id from any item URL.
 * Returns `null` if the URL has no recognizable `/item/<id>` segment.
 */
export function extractAliExpressItemId(raw: string): string | null {
    const match = raw.match(/\/item\/(\d+)/i);
    return match ? match[1] : null;
}

/** The neutral AliExpress landing page. In `seller_only` mode we navigate here purely to warm
 *  cookies + prime the MTOP token — the store page itself is too heavily anti-bot protected. */
export const HOME_URL = 'https://www.aliexpress.com/';

/**
 * Normalize an AliExpress store URL (e.g. `https://www.aliexpress.com/store/1101234567`) to its
 * canonical form and pull out the numeric store id. Used by `seller_only` mode, where the start
 * URLs are store pages rather than product pages.
 *
 * The store id doubles as the `sellerId` for the MTOP seller API — the same fallback the PDP path
 * already uses (see `extractSellerRef` in `seller.ts`).
 *
 * Returns `null` if the input is not a recognizable AliExpress store URL.
 */
export function normalizeAliExpressStoreUrl(raw: string): { id: string; url: string } | null {
    let parsed: URL;
    try {
        parsed = new URL(raw.trim());
    } catch {
        return null;
    }

    // Accept any AliExpress host/subdomain on the .com or .us TLD (same guard as the product path).
    if (!/(^|\.)aliexpress\.(com|us)$/i.test(parsed.hostname)) {
        return null;
    }

    const match = parsed.pathname.match(/\/store\/(\d+)/i);
    if (!match) {
        return null;
    }

    const id = match[1];
    return { id, url: `https://www.aliexpress.com/store/${id}` };
}

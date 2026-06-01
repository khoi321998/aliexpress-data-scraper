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

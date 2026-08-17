/**
 * Ship-to country → the storefront subdomain AliExpress serves that market on. Countries without a
 * dedicated localized host (GB, AU, CA, MX, ...) fall through to `www`, which is what a buyer there
 * actually browses.
 */
const COUNTRY_TO_SUBDOMAIN: Record<string, string> = {
    US: 'www',
    ES: 'es',
    FR: 'fr',
    DE: 'de',
    IT: 'it',
    NL: 'nl',
    PL: 'pl',
    PT: 'pt',
    BR: 'pt',
    RU: 'ru',
    TR: 'tr',
    KR: 'ko',
    JP: 'ja',
    VN: 'vi',
    TH: 'th',
    ID: 'id',
    IL: 'he',
    SA: 'ar',
    AE: 'ar',
};

/** The storefront host for a ship-to country, e.g. `ES` → `es.aliexpress.com`. */
export function storefrontHost(country?: string): string {
    const sub = country ? (COUNTRY_TO_SUBDOMAIN[country.toUpperCase()] ?? 'www') : 'www';
    return `${sub}.aliexpress.com`;
}

/**
 * Normalize any AliExpress product URL the user pastes into the canonical form for a given ship-to
 * country:
 *
 *     https://<storefront>.aliexpress.com/item/<itemId>.html
 *
 * Two separate jobs. The QUERY STRING is always dropped — `spm`, `algo_pvid`, `gatewayAdapt` and
 * friends are tracking/redirect noise, and the region they encode has already been read out by
 * {@link detectShipToCountry}. The HOST is rebuilt from `country` rather than from whatever the user
 * pasted, so a mistyped or stale subdomain can't disagree with the region we crawl under.
 *
 * The host is NOT collapsed to `www`. Asking `www.aliexpress.com` for a listing while presenting a
 * Spanish IP and a `region=ES` cookie is the same contradiction the proxy fix removes: the
 * storefront, the exit IP, the timezone and the ship-to cookie all have to name one country.
 * Omitting `country` keeps the historical `www` behavior.
 *
 * Examples:
 *   ('https://es.aliexpress.com/item/1005010204377877.html?gatewayAdapt=glo2esp', 'ES')
 *       -> https://es.aliexpress.com/item/1005010204377877.html
 *   ('https://m.aliexpress.com/item/1005009982221130.html', 'VN')
 *       -> https://vi.aliexpress.com/item/1005009982221130.html
 *   ('https://www.aliexpress.com/item/1005010695338136.html?spm=a2g0o.x')
 *       -> https://www.aliexpress.com/item/1005010695338136.html
 *
 * Returns `null` if the input is not a recognizable AliExpress product URL.
 */
export function normalizeAliExpressUrl(raw: string, country?: string): string | null {
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

    return `https://${storefrontHost(country)}/item/${match[1]}.html`;
}

/**
 * ISO-3166 alpha-3 (as AliExpress writes it in `gatewayAdapt=glo2<iso3>`) → alpha-2, for the
 * markets AliExpress runs a localized gateway for. Anything not listed falls through to the
 * subdomain heuristic below.
 */
const GATEWAY_ISO3_TO_ISO2: Record<string, string> = {
    usa: 'US',
    esp: 'ES',
    fra: 'FR',
    deu: 'DE',
    ita: 'IT',
    nld: 'NL',
    pol: 'PL',
    prt: 'PT',
    bra: 'BR',
    rus: 'RU',
    tur: 'TR',
    kor: 'KR',
    jpn: 'JP',
    vnm: 'VN',
    tha: 'TH',
    idn: 'ID',
    isr: 'IL',
    sau: 'SA',
    are: 'AE',
    gbr: 'GB',
    aus: 'AU',
    can: 'CA',
    mex: 'MX',
    chl: 'CL',
};

/**
 * Locale subdomain → the country AliExpress ships to on that storefront. Only unambiguous
 * language↔market pairs are listed; `www`, `m`, `best`, ... deliberately map to nothing so the
 * caller falls back to the configured default.
 *
 * `pt` → BR because AliExpress's Portuguese storefront targets Brazil, not Portugal (a Portuguese
 * buyer lands on `pt.aliexpress.com` with `gatewayAdapt=glo2prt`, which the ISO-3 map catches first).
 */
const SUBDOMAIN_TO_COUNTRY: Record<string, string> = {
    us: 'US',
    es: 'ES',
    fr: 'FR',
    de: 'DE',
    it: 'IT',
    nl: 'NL',
    pl: 'PL',
    pt: 'BR',
    ru: 'RU',
    tr: 'TR',
    ko: 'KR',
    ja: 'JP',
    vi: 'VN',
    th: 'TH',
    id: 'ID',
    he: 'IL',
    ar: 'SA',
};

/**
 * Work out which country the user was shopping from when they copied this URL, so we can pin the
 * SAME ship-to region on our own session.
 *
 * Why this matters: AliExpress gates product availability on ship-to, not just on the proxy IP. A
 * listing the seller does not ship to the US answers `pdp.pc.query` with a block/empty result even
 * on a perfectly clean session — indistinguishable from an anti-bot 403, and no amount of rotating
 * fixes it. Reading the region back off the pasted URL and replaying it in the `aep_usuc_f` cookie
 * (see `main.ts`) is what makes those listings resolve.
 *
 * Two signals, most explicit first:
 *   1. `?gatewayAdapt=glo2esp` — AliExpress's own redirect stamp, an ISO-3 country code.
 *   2. the locale subdomain (`es.`, `de.`, `vi.`, ...).
 *
 * Returns `null` when the URL carries no regional signal (`www.`/`m.`), leaving the choice to the
 * caller's default.
 *
 * Examples:
 *   https://es.aliexpress.com/item/1005010204377877.html?gatewayAdapt=glo2esp -> 'ES'
 *   https://vi.aliexpress.com/item/1005009982221130.html                      -> 'VN'
 *   https://www.aliexpress.com/item/1005010695338136.html                     -> null
 */
export function detectShipToCountry(raw: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(raw.trim());
    } catch {
        return null;
    }
    if (!/(^|\.)aliexpress\.(com|us)$/i.test(parsed.hostname)) {
        return null;
    }

    // 1. The `glo2<iso3>` redirect stamp — AliExpress telling us outright which market it sent the
    //    user to. Trusted over the subdomain, which can lag behind a manual region switch.
    const gateway = parsed.searchParams.get('gatewayAdapt');
    const iso3 = gateway?.match(/glo2([a-z]{3})/i)?.[1]?.toLowerCase();
    if (iso3 && GATEWAY_ISO3_TO_ISO2[iso3]) {
        return GATEWAY_ISO3_TO_ISO2[iso3];
    }

    // 2. The locale subdomain.
    const sub = parsed.hostname.toLowerCase().split('.')[0];
    return SUBDOMAIN_TO_COUNTRY[sub] ?? null;
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
 * already uses (see `extractSellerRef` in `seller.ts`). Also returns `allItemsUrl`, the listing page
 * the `seller_only` pipeline actually navigates to (see {@link storeAllItemsUrl}).
 *
 * Returns `null` if the input is not a recognizable AliExpress store URL.
 */
export function normalizeAliExpressStoreUrl(raw: string): { id: string; url: string; allItemsUrl: string } | null {
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
    return { id, url: `https://www.aliexpress.com/store/${id}`, allItemsUrl: storeAllItemsUrl(id) };
}

/**
 * The store's "All items" listing page, e.g. `https://www.aliexpress.com/store/<id>/pages/all-items.html`.
 *
 * This is where `seller_only` mode navigates: unlike the bare `/store/<id>` landing page (a curated
 * marketing layout), the all-items page renders a paginated grid of every product the seller offers,
 * which is what we scrape into {@link SellerProductPreview}s.
 */
export function storeAllItemsUrl(id: string): string {
    return `https://www.aliexpress.com/store/${id}/pages/all-items.html`;
}

/**
 * The store's "Feedback" page, e.g. `https://www.aliexpress.com/store/feedback-score/<id>.html`.
 *
 * This is the page behind the store nav's "Feedback" tab. Its panel renders the seller's credibility
 * scores and positive/neutral/negative review counts directly in the DOM, which `seller_only` mode
 * scrapes instead of calling the MTOP seller API (no token dance, no `sellerSeq` needed).
 */
export function storeFeedbackUrl(id: string): string {
    return `https://www.aliexpress.com/store/feedback-score/${id}.html`;
}

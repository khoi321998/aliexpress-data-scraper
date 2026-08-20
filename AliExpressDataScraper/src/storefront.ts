// Storefront identity per ship-to country — the three fields a real buyer's browser sends that
// together decide WHICH CATALOGUE AliExpress answers from.
//
// Why this module exists: asking `pdp.pc.query` with `ext.site: "glo"` reaches the GLOBAL catalogue
// even when the request otherwise claims to be a Spanish buyer on `es.aliexpress.com`. Listings the
// Spanish storefront has withdrawn (`bigBossBan: true`, `errorCode: "SITEM_BAN_NO_AVAIL_SKU"`) still
// resolve there, in USD, with an empty delivery estimate — data that looks complete but describes a
// market the buyer cannot actually order from. Sending the storefront the browser sends makes the
// availability answer match what a buyer in that country sees.
//
// The three fields move together and must not be mixed:
//   - `site`     → `ext.site` in MTOP payloads AND `site=` in the `aep_usuc_f` cookie
//   - `locale`   → `_lang` in MTOP payloads AND `b_locale=` in the cookie
//   - `currency` → `_currency` in MTOP payloads AND `c_tp=` in the cookie
//
// The cookie is the authoritative half: AliExpress prices from `c_tp`/IP geo and ignores the
// payload's `_currency` (see the preNavigationHook in `main.ts`). The payload fields are sent anyway
// so the signed call and the session it rides on tell one consistent story.

/** The storefront AliExpress serves a given market on. */
export interface Storefront {
    /** AliExpress's own storefront code — `esp`, `fra`, `usa`, … (`glo` = the global catalogue). */
    site: string;
    /** Language tag the storefront is read in, as AliExpress writes it in `b_locale`. */
    locale: string;
    /** ISO-4217 code the storefront prices in. */
    currency: string;
}

/**
 * The global catalogue: the pre-existing behaviour, and the fallback for any country without a
 * dedicated localized storefront below.
 */
export const GLOBAL_STOREFRONT: Storefront = { site: 'glo', locale: 'en_US', currency: 'USD' };

/**
 * Ship-to country → its storefront. The `site` codes are the same ISO-3-ish codes AliExpress stamps
 * into its own `gatewayAdapt=glo2<site>` redirects (see `GATEWAY_ISO3_TO_ISO2` in `url.ts`), so the
 * two maps are inverses of one another and stay in step.
 *
 * ONLY the `ES` row is verified against a real browser capture (`site=esp`, `b_locale=es_ES`,
 * `c_tp=EUR`). The rest pair the storefront code with that market's conventional language tag and
 * currency. A row whose locale is wrong degrades gracefully rather than failing: AliExpress serves
 * every storefront in English too, so a bad `b_locale` falls back to English content on the RIGHT
 * storefront — and `site` is the field that decides availability.
 */
const STOREFRONTS: Record<string, Storefront> = {
    US: { site: 'usa', locale: 'en_US', currency: 'USD' },
    ES: { site: 'esp', locale: 'es_ES', currency: 'EUR' },
    FR: { site: 'fra', locale: 'fr_FR', currency: 'EUR' },
    DE: { site: 'deu', locale: 'de_DE', currency: 'EUR' },
    IT: { site: 'ita', locale: 'it_IT', currency: 'EUR' },
    NL: { site: 'nld', locale: 'nl_NL', currency: 'EUR' },
    PL: { site: 'pol', locale: 'pl_PL', currency: 'PLN' },
    PT: { site: 'prt', locale: 'pt_PT', currency: 'EUR' },
    BR: { site: 'bra', locale: 'pt_BR', currency: 'BRL' },
    RU: { site: 'rus', locale: 'ru_RU', currency: 'RUB' },
    TR: { site: 'tur', locale: 'tr_TR', currency: 'TRY' },
    KR: { site: 'kor', locale: 'ko_KR', currency: 'KRW' },
    JP: { site: 'jpn', locale: 'ja_JP', currency: 'JPY' },
    VN: { site: 'vnm', locale: 'vi_VN', currency: 'VND' },
    TH: { site: 'tha', locale: 'th_TH', currency: 'THB' },
    // The locale tags below are the least certain in this table; each falls back to English content
    // on the correct storefront if AliExpress spells it differently.
    ID: { site: 'idn', locale: 'in_ID', currency: 'IDR' },
    IL: { site: 'isr', locale: 'iw_IL', currency: 'ILS' },
    SA: { site: 'sau', locale: 'ar_MA', currency: 'SAR' },
    AE: { site: 'are', locale: 'ar_MA', currency: 'AED' },
    // Markets with no localized subdomain (see `COUNTRY_TO_SUBDOMAIN` in `url.ts`) still have their
    // own storefront code and currency — they are simply browsed on `www`.
    GB: { site: 'gbr', locale: 'en_GB', currency: 'GBP' },
    AU: { site: 'aus', locale: 'en_US', currency: 'AUD' },
    CA: { site: 'can', locale: 'en_US', currency: 'CAD' },
    MX: { site: 'mex', locale: 'es_MX', currency: 'MXN' },
    CL: { site: 'chl', locale: 'es_CL', currency: 'CLP' },
};

/** The storefront for a ship-to country; unknown/absent countries get {@link GLOBAL_STOREFRONT}. */
export function storefrontFor(country?: string | null): Storefront {
    return (country ? STOREFRONTS[country.toUpperCase()] : undefined) ?? GLOBAL_STOREFRONT;
}

/**
 * Parse the `aep_usuc_f` locale cookie into its key/value parts.
 *
 * Format is `key=value` pairs joined by `&`, NOT percent-encoded — values legitimately contain `|`
 * (`ups_d=1|1|1|1`) and `%` — so this deliberately does not use `URLSearchParams`, which would
 * mangle them. An empty/garbage cookie yields `{}`.
 */
export function parseLocaleCookie(value: string): Record<string, string> {
    const parts: Record<string, string> = {};
    for (const chunk of value.split('&')) {
        const eq = chunk.indexOf('=');
        if (eq > 0) {
            parts[chunk.slice(0, eq)] = chunk.slice(eq + 1);
        }
    }
    return parts;
}

/** Re-join `aep_usuc_f` parts, dropping empty values (AliExpress omits them rather than sending `k=`). */
export function buildLocaleCookie(parts: Record<string, string>): string {
    return Object.entries(parts)
        .filter(([, v]) => v !== '')
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
}

/** The buyer's resolved delivery address, as AliExpress's own region ids. Empty string = unknown. */
export interface RegionAddress {
    /** Ship-to country, ISO-3166 alpha-2. */
    country: string;
    /** AliExpress province id (e.g. `919971656567000000`), or `''` when the session has none yet. */
    province: string;
    /** AliExpress city id, or `''`. */
    city: string;
}

/**
 * Read the province/city ids out of an `aep_usuc_f` cookie value.
 *
 * A real browsing session picks these up from AliExpress's own geo resolution and sends them in every
 * `pdp.pc.query`. We never invent them — an invented id is worse than none — so this returns `''` for
 * whatever the session has not been given, which is exactly what the payload sent before this change.
 */
export function addressFromLocaleCookie(country: string, cookieValue: string | null): RegionAddress {
    const parts = cookieValue ? parseLocaleCookie(cookieValue) : {};
    return { country, province: parts.province ?? '', city: parts.city ?? '' };
}

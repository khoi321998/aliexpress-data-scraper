// Central, typed configuration for the AliExpress scraper.
//
// Everything tunable lives here so the crawler wiring in `main.ts` stays declarative and
// operators have a single place to reason about anti-bot trade-offs. Values come from the
// Actor input (see `.actor/input_schema.json`) with safe production defaults applied here;
// anything not worth surfacing in the Console form is just a constant in this file.
//
// Anti-bot strategy: avoidance + rotation only. When AliExpress serves a captcha / punish /
// verify / empty page, we abandon the burned session (IP + fingerprint) and retry on a fresh
// one. We deliberately do NOT solve captchas — the Alibaba slider is solver-resistant and
// rotating off a clean residential IP is cheaper and more reliable.

import type { Storefront } from './storefront.js';
import { GLOBAL_STOREFRONT, storefrontFor } from './storefront.js';
import { detectShipToCountry } from './url.js';

/**
 * What the run captures:
 *   - `product_and_seller`: full product DOM + seller profile (API) + seller/product reviews + previews.
 *   - `product_only`: product DOM + `sellerRef` + product reviews only (no seller API enrichment/previews).
 *   - `seller_only`: store URLs in; scrape the seller from the DOM (all-items previews + feedback
 *     credibility/reviews) — `product` is null. No product page is visited.
 */
export type ScraperMode = 'product_and_seller' | 'product_only' | 'seller_only';

/** The accepted `mode` values, as a runtime list for input validation. */
export const SCRAPER_MODES: readonly ScraperMode[] = ['product_and_seller', 'product_only', 'seller_only'];

/** Raw Actor input shape (mirrors `.actor/input_schema.json`). */
export interface ScraperInput {
    startUrls?: { url: string }[];
    mode?: string;
    headless?: boolean;
    /** 2captcha API key used by the `seller_only` pipeline to solve reCAPTCHA punish pages. */
    twoCaptchaApiKey?: string;
    /**
     * Force one ship-to country (ISO-3166 alpha-2) for every start URL. Leave empty to auto-detect
     * it per URL from the locale subdomain / `gatewayAdapt` stamp the user pasted.
     */
    shipToCountry?: string;
    /**
     * Force the RESIDENTIAL proxy group for EVERY country, including ones the datacenter pool can
     * serve. Non-US ship-to already uses residential automatically — see {@link proxyGroupsFor}.
     */
    residentialProxy?: boolean;
    /**
     * Ask each ship-to country's OWN storefront (`site=esp`, prices in EUR, page in Spanish) instead
     * of the global catalogue. See {@link ScraperConfig.matchStorefrontLocale}. Default `true`.
     */
    matchStorefrontLocale?: boolean;
}

/** Fully-resolved configuration consumed by the crawler. */
export interface ScraperConfig {
    /** Which of the three capture modes this run performs. */
    mode: ScraperMode;
    /** Fixed to 10. */
    maxRequestsPerCrawl: number;
    /** Fixed to 2. */
    maxConcurrency: number;
    /** Fixed to 10. */
    maxRequestRetries: number;
    /** Hard cap for a single navigation. Kept well below the handler timeout. */
    navigationTimeoutSecs: number;
    /** Whole-request budget (navigation + hydration wait + humanization + extraction). */
    requestHandlerTimeoutSecs: number;
    headless: boolean;
    /**
     * Proxy country for the `seller_only` pipeline, which starts from a store URL and so has no
     * per-request ship-to to resolve. Fixed to "US". Also the fallback region for seller MTOP
     * payloads when no ship-to is supplied — see `sellerApiOpts` in `sellerProfile.ts`.
     *
     * The product crawler does NOT use this: it exits the proxy in the SAME country it ships to,
     * resolved per request — see {@link shipToCountry} — and the seller scrape it triggers now signs
     * that same country, so a locale-only store's catalog is visible to it.
     */
    proxyCountry: string;
    /** Force RESIDENTIAL everywhere, even for countries the datacenter pool can serve. */
    residentialProxy: boolean;
    /**
     * Countries the Apify DATACENTER pool actually holds IPs in. Anything outside this list has to
     * go through RESIDENTIAL — see {@link proxyGroupsFor}.
     */
    datacenterCountries: string[];

    /**
     * Explicit ship-to override (ISO-3166 alpha-2) applied to every URL, or `null` to auto-detect
     * per URL.
     *
     * This drives BOTH the `aep_usuc_f` region cookie AND the proxy exit country. Splitting them
     * (ES ship-to over a US IP) is what AliExpress punishes hardest: a US datacenter IP asking for
     * Spanish delivery is a contradiction no real buyer produces, and the whole run gets captcha'd.
     */
    shipToCountry: string | null;
    /** Ship-to used when a URL carries no regional signal and no override is set. Fixed to "US". */
    defaultShipToCountry: string;

    /** 2captcha API key (input or `TWOCAPTCHA_API_KEY` env). `undefined` = no solver configured. */
    twoCaptchaApiKey?: string;
    /** Fixed to "USD" — forced via the AliExpress `aep_usuc_f` locale cookie (seller pipeline). */
    currency: string;
    /** Fixed to "en_US" — forced via the `aep_usuc_f` cookie. */
    language: string;

    /**
     * Read each product on the ship-to country's OWN storefront, exactly as a buyer there does:
     * `site=esp`, `b_locale=es_ES`, `c_tp=EUR` — instead of the global catalogue in USD/English.
     *
     * This is an AVAILABILITY switch, not a cosmetic one. The global catalogue answers for listings a
     * localized storefront has withdrawn, so with this off a product that a Spanish buyer cannot order
     * still lands in the dataset looking complete — priced in USD, with an empty delivery estimate.
     * With it on, AliExpress says so outright (`bigBossBan`) and the record carries `success: false`
     * with `errorCode: 'unavailable_in_region'`.
     *
     * The cost is comparability: prices arrive in the storefront's currency (EUR, BRL, …) and review
     * and description text in its language, so records from different regions are no longer directly
     * comparable. Set to `false` to restore the previous global-catalogue behaviour exactly.
     */
    matchStorefrontLocale: boolean;

    sessionPool: {
        /** Small pool keeps residential IPs sticky and reused instead of churning. */
        maxPoolSize: number;
        /** Reuse a healthy session a few times (warm cookies) before it is recycled. */
        maxUsageCount: number;
        /** Retire a session after this many errors. 1 = drop a burned IP immediately. */
        maxErrorScore: number;
    };

    /** Refresh the browser (and thus its fingerprint) after this many pages. */
    retireBrowserAfterPageCount: number;
}

/**
 * Merge Actor input with production defaults into a single immutable config object.
 *
 * Defaults are deliberately conservative for a browser + residential-proxy crawl of a
 * hostile target: low concurrency, generous retries (rotation needs room to find a clean
 * IP), and `rotate` as the challenge strategy.
 */
export function buildConfig(input: ScraperInput): ScraperConfig {
    const maxConcurrency = 2;

    // Lenient like the rest of this file: an unrecognized/absent mode falls back to the full
    // default rather than throwing, so a typo degrades gracefully to the safest behavior.
    const mode: ScraperMode = SCRAPER_MODES.includes(input.mode as ScraperMode)
        ? (input.mode as ScraperMode)
        : 'product_and_seller';

    return {
        mode,
        maxRequestsPerCrawl: 10,
        maxConcurrency,
        maxRequestRetries: 10,
        navigationTimeoutSecs: 45,
        // 6 minutes: covers product extraction PLUS the `product_and_seller` seller scrape, which runs
        // in a separate local browser and may include a 2captcha solve (up to ~5 min) on the store pages.
        requestHandlerTimeoutSecs: 360,
        headless: input.headless ?? true,
        proxyCountry: 'US',
        residentialProxy: input.residentialProxy ?? false,
        // The account's datacenter groups (SHADER / BUYPROXIES* / StaticUS3) are US-only; asking
        // proxy.apify.com for any other country returns 407 "Selected proxy groups have no usable
        // proxies from country '<XX>'", which surfaces in the browser as ERR_TUNNEL_CONNECTION_FAILED.
        datacenterCountries: ['US'],
        shipToCountry: input.shipToCountry?.trim().toUpperCase() || null,
        defaultShipToCountry: 'US',
        twoCaptchaApiKey: input.twoCaptchaApiKey || process.env.TWOCAPTCHA_API_KEY || undefined,
        currency: 'USD',
        language: 'en_US',
        matchStorefrontLocale: input.matchStorefrontLocale ?? true,
        sessionPool: {
            // A touch larger than concurrency so a retired session can be replaced without stalling.
            maxPoolSize: Math.max(maxConcurrency + 2, 4),
            maxUsageCount: 5,
            maxErrorScore: 1,
        },
        retireBrowserAfterPageCount: 5,
    };
}

/**
 * Decide the ship-to country for ONE start URL: an explicit input override wins, otherwise the
 * region the pasted URL carries, otherwise the default.
 *
 * Call this on the RAW url — {@link normalizeAliExpressUrl} strips exactly the signals it reads.
 */
export function resolveShipToCountry(rawUrl: string, config: ScraperConfig): string {
    return config.shipToCountry ?? detectShipToCountry(rawUrl) ?? config.defaultShipToCountry;
}

/**
 * The storefront identity to present for ONE ship-to country under the current config — the single
 * place {@link ScraperConfig.matchStorefrontLocale} is honoured.
 *
 * Off ⇒ the global catalogue in USD/English for every region, which is what every call sent before
 * the flag existed. On ⇒ that country's own storefront.
 */
export function storefrontForRequest(shipToCountry: string, config: ScraperConfig): Storefront {
    return config.matchStorefrontLocale ? storefrontFor(shipToCountry) : GLOBAL_STOREFRONT;
}

/**
 * Which Apify proxy groups to request for a given exit country. `[]` means the automatic datacenter
 * pool.
 *
 * Residential is not merely "better" outside the US — it is the only thing that works. The
 * datacenter pool holds US addresses only, so `country-ES` there is refused at the CONNECT stage
 * with 407 and the crawl dies before it ever reaches AliExpress. Datacenter therefore stays for the
 * countries it can actually serve (where it's cheaper), and everything else goes residential.
 */
export function proxyGroupsFor(country: string, config: ScraperConfig): string[] {
    if (config.residentialProxy) {
        return ['RESIDENTIAL'];
    }
    return config.datacenterCountries.includes(country.toUpperCase()) ? [] : ['RESIDENTIAL'];
}

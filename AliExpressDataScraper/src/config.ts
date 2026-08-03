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
    /** Standby: number of warm browser contexts to keep alive (== max simultaneous calls). */
    standbyPoolSize?: number;
    /** Standby: recycle a warm context after this many served requests. */
    standbyMaxUsageCount?: number;
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
    /** Fixed to "US" — the Apify residential proxy country. */
    proxyCountry: string;

    /** 2captcha API key (input or `TWOCAPTCHA_API_KEY` env). `undefined` = no solver configured. */
    twoCaptchaApiKey?: string;
    /** Fixed to "USD" — forced via the AliExpress `aep_usuc_f` locale cookie (seller pipeline). */
    currency: string;
    /** Fixed to "en_US" — forced via the `aep_usuc_f` cookie. */
    language: string;

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

    /** Standby warm-pool settings (used only by the standby HTTP entry path). */
    standby: {
        /** Target number of warm contexts == max simultaneous in-flight calls. */
        poolSize: number;
        /** Recycle a warm context after this many served requests. */
        maxUsageCount: number;
    };
}

function asPositiveInt(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
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
        twoCaptchaApiKey: input.twoCaptchaApiKey || process.env.TWOCAPTCHA_API_KEY || undefined,
        currency: 'USD',
        language: 'en_US',
        sessionPool: {
            // A touch larger than concurrency so a retired session can be replaced without stalling.
            maxPoolSize: Math.max(maxConcurrency + 2, 4),
            maxUsageCount: 5,
            maxErrorScore: 1,
        },
        retireBrowserAfterPageCount: 5,
        standby: {
            // Clamp pool size to 2–4 (a few concurrent calls); each warm context is a full Chrome.
            poolSize: Math.min(4, Math.max(2, asPositiveInt(input.standbyPoolSize, 3))),
            maxUsageCount: asPositiveInt(input.standbyMaxUsageCount, 5) || 5,
        },
    };
}

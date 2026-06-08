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
    maxRequestsPerCrawl?: number;
    maxConcurrency?: number;
    maxRequestRetries?: number;
    proxyCountry?: string;
    headless?: boolean;
    /** 2captcha API key used by the `seller_only` pipeline to solve reCAPTCHA punish pages. */
    twoCaptchaApiKey?: string;
    /** Currency code forced via the AliExpress locale cookie, e.g. "USD". */
    currency?: string;
    /** UI/content language as an AliExpress locale, e.g. "en_US". */
    language?: string;
}

/** Fully-resolved configuration consumed by the crawler. */
export interface ScraperConfig {
    /** Which of the three capture modes this run performs. */
    mode: ScraperMode;
    maxRequestsPerCrawl: number;
    maxConcurrency: number;
    maxRequestRetries: number;
    /** Hard cap for a single navigation. Kept well below the handler timeout. */
    navigationTimeoutSecs: number;
    /** Whole-request budget (navigation + hydration wait + humanization + extraction). */
    requestHandlerTimeoutSecs: number;
    headless: boolean;
    proxyCountry: string;

    /** 2captcha API key (input or `TWOCAPTCHA_API_KEY` env). `undefined` = no solver configured. */
    twoCaptchaApiKey?: string;
    /** Currency forced via the AliExpress `aep_usuc_f` locale cookie (seller pipeline). */
    currency: string;
    /** AliExpress locale forced via the `aep_usuc_f` cookie, e.g. "en_US". */
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

    humanize: {
        minActionDelayMs: number;
        maxActionDelayMs: number;
        /** Extra settle time after `domcontentloaded` for client-side hydration. */
        minHydrationDelayMs: number;
        maxHydrationDelayMs: number;
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
    const maxConcurrency = asPositiveInt(input.maxConcurrency, 2) || 1;

    // Lenient like the rest of this file: an unrecognized/absent mode falls back to the full
    // default rather than throwing, so a typo degrades gracefully to the safest behavior.
    const mode: ScraperMode = SCRAPER_MODES.includes(input.mode as ScraperMode)
        ? (input.mode as ScraperMode)
        : 'product_and_seller';

    return {
        mode,
        maxRequestsPerCrawl: asPositiveInt(input.maxRequestsPerCrawl, 10),
        maxConcurrency,
        maxRequestRetries: asPositiveInt(input.maxRequestRetries, 5),
        navigationTimeoutSecs: 45,
        // 6 minutes: covers product extraction PLUS the `product_and_seller` seller scrape, which runs
        // in a separate local browser and may include a 2captcha solve (up to ~5 min) on the store pages.
        requestHandlerTimeoutSecs: 360,
        headless: input.headless ?? true,
        proxyCountry: (input.proxyCountry ?? 'US').toUpperCase(),
        twoCaptchaApiKey: input.twoCaptchaApiKey || process.env.TWOCAPTCHA_API_KEY || undefined,
        currency: input.currency || 'USD',
        language: input.language || 'en_US',
        sessionPool: {
            // A touch larger than concurrency so a retired session can be replaced without stalling.
            maxPoolSize: Math.max(maxConcurrency + 2, 4),
            maxUsageCount: 5,
            maxErrorScore: 1,
        },
        retireBrowserAfterPageCount: 5,
        humanize: {
            minActionDelayMs: 400,
            maxActionDelayMs: 1_500,
            minHydrationDelayMs: 1_500,
            maxHydrationDelayMs: 3_000,
        },
    };
}

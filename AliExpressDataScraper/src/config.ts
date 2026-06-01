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

/** Raw Actor input shape (mirrors `.actor/input_schema.json`). */
export interface ScraperInput {
    startUrls?: { url: string }[];
    maxRequestsPerCrawl?: number;
    maxConcurrency?: number;
    maxRequestRetries?: number;
    proxyCountry?: string;
    headless?: boolean;
}

/** Fully-resolved configuration consumed by the crawler. */
export interface ScraperConfig {
    maxRequestsPerCrawl: number;
    maxConcurrency: number;
    maxRequestRetries: number;
    /** Hard cap for a single navigation. Kept well below the handler timeout. */
    navigationTimeoutSecs: number;
    /** Whole-request budget (navigation + hydration wait + humanization + extraction). */
    requestHandlerTimeoutSecs: number;
    headless: boolean;
    proxyCountry: string;

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

    return {
        maxRequestsPerCrawl: asPositiveInt(input.maxRequestsPerCrawl, 10),
        maxConcurrency,
        maxRequestRetries: asPositiveInt(input.maxRequestRetries, 5),
        navigationTimeoutSecs: 45,
        // Comfortably covers navigation + hydration wait + humanization + extraction.
        requestHandlerTimeoutSecs: 90,
        headless: input.headless ?? true,
        proxyCountry: (input.proxyCountry ?? 'US').toUpperCase(),
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

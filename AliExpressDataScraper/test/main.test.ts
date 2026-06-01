import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { buildConfig } from '../src/config.js';
import { classifyPage, isPunishUrl } from '../src/detection.js';
import { extractAliExpressItemId, normalizeAliExpressUrl } from '../src/url.js';

describe('url normalization', () => {
    it('normalizes locale subdomains and strips tracking params', () => {
        expect(normalizeAliExpressUrl('https://vi.aliexpress.com/item/1005009982221130.html')).toBe(
            'https://www.aliexpress.com/item/1005009982221130.html',
        );
        expect(normalizeAliExpressUrl('https://www.aliexpress.com/item/1005010695338136.html?spm=a2g0o.x')).toBe(
            'https://www.aliexpress.com/item/1005010695338136.html',
        );
        expect(normalizeAliExpressUrl('https://m.aliexpress.com/item/1005009982221130.html')).toBe(
            'https://www.aliexpress.com/item/1005009982221130.html',
        );
    });

    it('rejects non-product / non-AliExpress URLs', () => {
        expect(normalizeAliExpressUrl('https://www.aliexpress.com/category/123/phones.html')).toBeNull();
        expect(normalizeAliExpressUrl('https://example.com/item/123.html')).toBeNull();
        expect(normalizeAliExpressUrl('not a url')).toBeNull();
    });

    it('extracts the numeric item id', () => {
        expect(extractAliExpressItemId('https://www.aliexpress.com/item/1005009982221130.html')).toBe(
            '1005009982221130',
        );
        expect(extractAliExpressItemId('https://example.com/no-item')).toBeNull();
    });
});

describe('config defaults', () => {
    it('applies safe production defaults', () => {
        const config = buildConfig({});
        expect(config.maxConcurrency).toBe(2);
        expect(config.maxRequestRetries).toBe(5);
        expect(config.headless).toBe(true);
        expect(config.proxyCountry).toBe('US');
        // The whole-request budget must comfortably exceed a single navigation.
        expect(config.requestHandlerTimeoutSecs).toBeGreaterThan(config.navigationTimeoutSecs);
    });

    it('honors and sanitizes overrides', () => {
        const config = buildConfig({ proxyCountry: 'de', headless: false, maxConcurrency: 3 });
        expect(config.proxyCountry).toBe('DE');
        expect(config.headless).toBe(false);
        expect(config.maxConcurrency).toBe(3);
    });
});

describe('detection', () => {
    it('flags Alibaba punish URLs', () => {
        expect(isPunishUrl('https://www.aliexpress.com/punish?x5secdata=abc')).toBe(true);
        expect(isPunishUrl('https://_____tmd_____/path')).toBe(true);
        expect(isPunishUrl('https://www.aliexpress.com/item/123.html')).toBe(false);
    });

    // A minimal fake Page: classifyPage only touches url(), locator().count(), title(), and
    // evaluate(). We stub just those to exercise the classification priority without a browser.
    function fakePage(opts: { url: string; selectorHits?: string[]; title?: string; bodyLen?: number }): Page {
        const hits = new Set(opts.selectorHits ?? []);
        return {
            url: () => opts.url,
            title: async () => opts.title ?? '',
            locator: (selector: string) => ({
                count: async () => (hits.has(selector) ? 1 : 0),
            }),
            evaluate: async () => opts.bodyLen ?? 0,
        } as unknown as Page;
    }

    it('classifies a punish redirect', async () => {
        const page = fakePage({ url: 'https://www.aliexpress.com/punish?x5secdata=x' });
        expect(await classifyPage(page)).toBe('punish');
    });

    it('classifies a captcha overlay on a product URL', async () => {
        const page = fakePage({
            url: 'https://www.aliexpress.com/item/123.html',
            selectorHits: ['iframe[src*="recaptcha"]'],
        });
        expect(await classifyPage(page)).toBe('captcha');
    });

    it('classifies a loaded product page as ok', async () => {
        const page = fakePage({
            url: 'https://www.aliexpress.com/item/123.html',
            selectorHits: ['h1[data-pl="product-title"]'],
            bodyLen: 5_000,
        });
        expect(await classifyPage(page)).toBe('ok');
    });

    it('classifies a blank/shell product page as empty', async () => {
        const page = fakePage({ url: 'https://www.aliexpress.com/item/123.html', bodyLen: 10 });
        expect(await classifyPage(page)).toBe('empty');
    });
});

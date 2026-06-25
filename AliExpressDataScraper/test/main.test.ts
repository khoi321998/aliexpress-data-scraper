import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { buildConfig } from '../src/config.js';
import { classifyPage, isPunishUrl } from '../src/detection.js';
import { parsePdpResult } from '../src/productApi.js';
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
        expect(config.maxRequestRetries).toBe(10);
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

describe('pdp.pc.query parsing', () => {
    // A minimal `result` mirroring the real module shapes (see productApi.ts field map).
    const result = {
        PRODUCT_TITLE: { text: '  Fancy Shoes  ' },
        PRICE: {
            targetSkuPriceInfo: { originalPrice: { currency: 'USD' }, salePriceString: '$29.12' },
            skuPriceInfoMap: {
                a: { salePriceString: '$29.12' },
                b: { salePriceString: '$32.49' },
            },
        },
        HEADER_IMAGE_PC: {
            imagePathList: ['//ae.com/a.jpg', 'http://ae.com/b.jpg'],
            productVideo: { posterUrl: '//ae.com/p.jpg', videoPlayInfo: { webUrl: 'https://v.com/x.mp4' } },
        },
        PRODUCT_PROP_PC: {
            showedProps: [
                { attrName: 'Color', attrValue: 'Silver' },
                { attrName: '', attrValue: 'dropme' },
            ],
        },
        QUANTITY_PC: { totalAvailableInventory: 717 },
        PC_RATING: { rating: '5.0', totalValidNum: 105, otherText: '236 sold' },
        SHIPPING: {
            deliveryLayoutInfo: [{ additionLayout: [{ content: '<strong>Delivery: Jul 02 - 09</strong>' }] }],
        },
        SHOP_CARD_PC: { storeName: 'Aneikeh Shoes Store', sellerInfo: { adminSeq: 2671658649, storeURL: '//www.aliexpress.com/store/1102738107' } },
        DESC: { pcDescUrl: 'https://pdp.aliexpress-media.com/desc.htm?x=1' },
    };

    it('maps every product field from one result object', () => {
        const p = parsePdpResult(result);
        expect(p.title).toBe('Fancy Shoes');
        expect(p.pricing).toEqual({ currency: 'USD', priceMin: 29.12, priceMax: 32.49 });
        expect(p.media.images.map((i) => i.url)).toEqual(['https://ae.com/a.jpg', 'https://ae.com/b.jpg']);
        expect(p.media.videos[0]).toEqual({ url: 'https://v.com/x.mp4', poster: 'https://ae.com/p.jpg' });
        expect(p.specifications).toEqual([{ name: 'Color', value: 'Silver' }]);
        expect(p.stock).toEqual({ availableQuantity: 717, soldCount: 236 });
        expect(p.shipping.deliveryTimeText).toBe('Jul 02 - 09');
        expect(p.ratingFallback).toEqual({ rating: 5, reviewCount: 105 });
        expect(p.sellerRef).toEqual({
            platformSellerId: '2671658649',
            name: 'Aneikeh Shoes Store',
            url: 'https://www.aliexpress.com/store/1102738107',
        });
        expect(p.descUrl).toBe('https://pdp.aliexpress-media.com/desc.htm?x=1');
    });

    it('degrades gracefully on an empty result', () => {
        const p = parsePdpResult({});
        expect(p.title).toBeNull();
        expect(p.pricing).toEqual({ currency: '', priceMin: null, priceMax: null });
        expect(p.media.images).toEqual([]);
        expect(p.specifications).toEqual([]);
        expect(p.sellerRef).toBeNull();
        expect(p.descUrl).toBeNull();
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

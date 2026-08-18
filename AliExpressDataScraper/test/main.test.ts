import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { buildConfig, proxyGroupsFor, resolveShipToCountry } from '../src/config.js';
import { classifyPage, isPunishUrl } from '../src/detection.js';
import { parsePdpResult } from '../src/productApi.js';
import { sellerApiOpts } from '../src/sellerProfile.js';
import { TIMEZONE_ID, timezoneForCountry } from '../src/stealth.js';
import { detectShipToCountry, extractAliExpressItemId, normalizeAliExpressUrl } from '../src/url.js';

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

    it('rebuilds the host from the ship-to country, not from what was pasted', () => {
        expect(normalizeAliExpressUrl('https://es.aliexpress.com/item/1005010204377877.html?gatewayAdapt=glo2esp', 'ES')).toBe(
            'https://es.aliexpress.com/item/1005010204377877.html',
        );
        // A stale/mistyped subdomain loses to the resolved country.
        expect(normalizeAliExpressUrl('https://m.aliexpress.com/item/1005009982221130.html', 'VN')).toBe(
            'https://vi.aliexpress.com/item/1005009982221130.html',
        );
        expect(normalizeAliExpressUrl('https://es.aliexpress.com/item/123.html', 'US')).toBe('https://www.aliexpress.com/item/123.html');
        // A country with no localized storefront browses the global one.
        expect(normalizeAliExpressUrl('https://www.aliexpress.com/item/123.html', 'GB')).toBe('https://www.aliexpress.com/item/123.html');
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

describe('ship-to detection', () => {
    it('prefers the gatewayAdapt stamp over the subdomain', () => {
        expect(detectShipToCountry('https://es.aliexpress.com/item/1005010204377877.html?gatewayAdapt=glo2esp')).toBe('ES');
        // Subdomain and stamp disagree (user switched region manually) — the stamp wins.
        expect(detectShipToCountry('https://www.aliexpress.com/item/123.html?gatewayAdapt=glo2deu')).toBe('DE');
    });

    it('falls back to the locale subdomain', () => {
        expect(detectShipToCountry('https://es.aliexpress.com/item/1005010204377877.html')).toBe('ES');
        expect(detectShipToCountry('https://vi.aliexpress.com/item/123.html')).toBe('VN');
        expect(detectShipToCountry('https://us.aliexpress.com/item/123.html')).toBe('US');
    });

    it('returns null when the URL carries no region signal', () => {
        expect(detectShipToCountry('https://www.aliexpress.com/item/123.html')).toBeNull();
        expect(detectShipToCountry('https://m.aliexpress.com/item/123.html')).toBeNull();
        expect(detectShipToCountry('https://example.com/item/123.html')).toBeNull();
        expect(detectShipToCountry('not a url')).toBeNull();
    });

    it('resolves per URL, with the input override winning over detection', () => {
        const auto = buildConfig({});
        expect(resolveShipToCountry('https://es.aliexpress.com/item/123.html', auto)).toBe('ES');
        // No signal in the URL → the default, NOT a guess from the proxy country.
        expect(resolveShipToCountry('https://www.aliexpress.com/item/123.html', auto)).toBe('US');

        const forced = buildConfig({ shipToCountry: ' de ' });
        expect(forced.shipToCountry).toBe('DE');
        expect(resolveShipToCountry('https://es.aliexpress.com/item/123.html', forced)).toBe('DE');
    });

    it('presents a timezone consistent with the proxy exit country', () => {
        // The whole point: no US timezone on a Spanish IP.
        expect(timezoneForCountry('ES')).toBe('Europe/Madrid');
        expect(timezoneForCountry('vn')).toBe('Asia/Ho_Chi_Minh');
        expect(timezoneForCountry('US')).toBe('America/New_York');
        // Unknown code (only reachable via the manual override) → the US default, never the host's.
        expect(timezoneForCountry('ZZ')).toBe(TIMEZONE_ID);
    });

    it('uses residential wherever the datacenter pool has no IPs', () => {
        const config = buildConfig({});
        // Datacenter is US-only on this account; ES there is refused at CONNECT with 407.
        expect(proxyGroupsFor('US', config)).toEqual([]);
        expect(proxyGroupsFor('ES', config)).toEqual(['RESIDENTIAL']);
        expect(proxyGroupsFor('vn', config)).toEqual(['RESIDENTIAL']);

        // The input flag forces residential even where datacenter would work.
        const forced = buildConfig({ residentialProxy: true });
        expect(proxyGroupsFor('US', forced)).toEqual(['RESIDENTIAL']);
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

    // --- currency priority ladder (see parseCurrencyCode) ---------------------------------------
    // Rung 1 must stay ahead of everything: listings that already resolved from the selected SKU
    // keep resolving from it, even when a variant disagrees.
    it('prefers the selected SKU currency over any variant', () => {
        const p = parsePdpResult({
            PRICE: {
                targetSkuPriceInfo: { originalPrice: { currency: 'USD' }, salePriceString: '$29.12' },
                skuPriceInfoMap: { a: { originalPrice: { currency: 'EUR' }, salePriceString: '€29,12' } },
            },
        });
        expect(p.pricing.currency).toBe('USD');
    });

    // The API's stated code wins over anything inferable from the '$' in the formatted price, which
    // would have guessed USD while the payload says CAD outright.
    it('takes the stated ISO code, never a guess from the price symbol', () => {
        const p = parsePdpResult({
            PRICE: {
                targetSkuPriceInfo: { salePriceString: '$29.12' },
                skuPriceInfoMap: { a: { originalPrice: { currency: 'CAD' }, salePriceString: '$29.12' } },
            },
        });
        expect(p.pricing.currency).toBe('CAD');
    });

    // Rung 3 - the last API-stated source, used when no per-SKU amount object carries a code.
    it('reads the currency from itemRangePriceView as a last resort', () => {
        const p = parsePdpResult({
            PRICE: {
                itemRangePriceView: { minDisPrice: { currency: 'GBP', value: 29.12 } },
                skuPriceInfoMap: { a: { salePriceString: '£29.12' } },
            },
        });
        expect(p.pricing).toEqual({ currency: 'GBP', priceMin: 29.12, priceMax: 29.12 });
    });

    // Rung 4 - item 3256811581312282: six variants, every price info symbol-only (no `originalPrice`,
    // no `itemRangePriceView`), so the page-level code in GLOBAL_DATA is the only ISO source left.
    it('falls back to GLOBAL_DATA.currencyCode when no price info carries an amount object', () => {
        const p = parsePdpResult({
            GLOBAL_DATA: { globalData: { currencyCode: 'USD', localStr: 'en_US' } },
            PRICE: {
                targetSkuPriceInfo: { salePriceString: '$6.71' },
                skuPriceInfoMap: { a: { salePriceString: '$7.74' }, b: { salePriceString: '$6.71' } },
            },
        });
        expect(p.pricing).toEqual({ currency: 'USD', priceMin: 6.71, priceMax: 7.74 });
    });

    // No rung yields a code: report it EMPTY rather than guessing 'EUR' from the symbol. An empty
    // currency is flagged by the extraction audit; a wrong one would pass silently.
    it('leaves the currency empty when the API states none, instead of guessing from the symbol', () => {
        const p = parsePdpResult({ PRICE: { skuPriceInfoMap: { a: { salePriceString: '€21,09' } } } });
        expect(p.pricing).toEqual({ currency: '', priceMin: 21.09, priceMax: 21.09 });
    });

    // The es.aliexpress.com single-SKU shape that shipped `currency: ''` while the prices parsed:
    // no `targetSkuPriceInfo` at all, so the code must reach into `skuPriceInfoMap` for the ISO code.
    it('reads the currency from skuPriceInfoMap when targetSkuPriceInfo is absent', () => {
        const p = parsePdpResult({
            PRICE: { skuPriceInfoMap: { a: { salePriceString: '€21,09', originalPrice: { currency: 'EUR' } } } },
        });
        expect(p.pricing).toEqual({ currency: 'EUR', priceMin: 21.09, priceMax: 21.09 });
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

describe('seller MTOP payload region', () => {
    // The store catalog module (`ModuleAsyncService` → `productList`) filters by ship-to and answers
    // SUCCESS with an empty body when the asking region cannot be shipped to. Signing the fixed
    // proxyCountry ("US") emptied `seller.productPreviews` for locale-only stores reached from a
    // locale storefront — e.g. a Spanish store read from `es.aliexpress.com`.
    it('signs the request ship-to, not the fixed proxy country', () => {
        const config = buildConfig({});
        expect(sellerApiOpts(config, 'ES').country).toBe('ES');
        expect(sellerApiOpts(config, 'VN').country).toBe('VN');
    });

    it('falls back to the proxy country for callers with no per-request region', () => {
        const config = buildConfig({});
        expect(sellerApiOpts(config, undefined).country).toBe(config.proxyCountry);
    });

    it('leaves language and currency pinned regardless of region', () => {
        const config = buildConfig({});
        const opts = sellerApiOpts(config, 'ES');
        expect(opts.language).toBe(config.language);
        expect(opts.currency).toBe(config.currency);
    });
});

import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { buildConfig, proxyGroupsFor, resolveShipToCountry, storefrontForRequest } from '../src/config.js';
import { classifyPage, isNotFoundPage, isPunishUrl, NOT_FOUND_SELECTORS } from '../src/detection.js';
import { auditExtraction } from '../src/extractionAudit.js';
import { NO_LISTING_CHECKS } from '../src/extractionChecks.js';
import { createAliExpressResponse } from '../src/response.js';
import { blockReasonFromError } from '../src/routes.js';
import { parsePdpResult, pdpUnavailability } from '../src/productApi.js';
import { sellerApiOpts } from '../src/sellerProfile.js';
import { addressFromLocaleCookie, buildLocaleCookie, GLOBAL_STOREFRONT, parseLocaleCookie, storefrontFor } from '../src/storefront.js';
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

    // AliExpress serves its 404 under the requested /item/<id>.html URL with a 200 — only the page's
    // own Open Graph header gives it away.
    it('classifies a nonexistent item id as notfound, not empty', async () => {
        const page = fakePage({
            url: 'https://es.aliexpress.com/item/999999999999999.html',
            selectorHits: ['meta[property="og:title"][content="404 page"]'],
        });
        expect(await classifyPage(page)).toBe('notfound');
    });

    it('still recognises the 404 page from the illustration marker alone', async () => {
        const page = fakePage({
            url: 'https://es.aliexpress.com/item/999999999999999.html',
            selectorHits: ['meta[property="og:image"][content*="HTB18eCBQXXXXXXfXXXX760XFXXXa"]'],
        });
        expect(await classifyPage(page)).toBe('notfound');
    });

    // A live listing ships an og:title too — with the product name. The content match must reject it,
    // or every successful scrape would be discarded as a 404.
    it('does not mistake a live product page for a 404', async () => {
        const page = fakePage({
            url: 'https://www.aliexpress.com/item/123.html',
            selectorHits: ['h1[data-pl="product-title"]', 'meta[property="og:title"]'],
            bodyLen: 5_000,
        });
        expect(await classifyPage(page)).toBe('ok');
    });
});

describe('give-up records', () => {
    // Every record leaves in the same envelope; `availability` alone says what happened. These two
    // strings are a matched pair with the throw in `rotateAndRetry` — if that message is reworded
    // without this pattern, give-up records silently lose their reason code.
    it('recovers the classified block reason from the rotation error', () => {
        expect(blockReasonFromError(new Error('Anti-bot block (captcha); rotating to a fresh session/proxy.'))).toBe('captcha');
        expect(blockReasonFromError(new Error('Anti-bot block (pdp-timeout); rotating to a fresh session/proxy.'))).toBe('pdp-timeout');
    });

    it('reports no code for failures that were not anti-bot blocks', () => {
        expect(blockReasonFromError(new Error('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED'))).toBeNull();
        expect(blockReasonFromError('some non-Error rejection')).toBeNull();
    });

    // Every record leaves in one envelope, so a consumer branches on `success` alone — never on the
    // shape of the record.
    it('defaults to success with no error fields set', () => {
        const response = createAliExpressResponse('https://es.aliexpress.com/item/1005008003575937.html');
        expect(response.success).toBe(true);
        expect(response.errorCode).toBeNull();
        expect(response.errorMessage).toBeNull();
        expect(response.product.id).toBe('1005008003575937');
    });

    // The audit must not grade a give-up record `broken`: no product field could ever have been
    // filled, so flagging them would drown out records that really did suffer a property rename.
    it('audits a failed record against the no-listing checks, not the product ones', () => {
        const response = createAliExpressResponse('https://es.aliexpress.com/item/1005008003575937.html');
        response.success = false;
        response.errorCode = 'blocked';
        response.errorMessage = 'captcha: Anti-bot block (captcha); … (gave up after 11 attempts)';
        const report = auditExtraction(response, NO_LISTING_CHECKS);
        expect(report.status).toBe('ok');
        expect(report.missingFields).toEqual([]);
    });

    it('still flags a failed record that never got its error code set', () => {
        const response = createAliExpressResponse('https://es.aliexpress.com/item/1005008003575937.html');
        response.success = false;
        expect(auditExtraction(response, NO_LISTING_CHECKS).status).toBe('broken');
    });
});

describe('404 detection in the failure path', () => {
    /** A page whose markers are absent instantly and only arrive (or not) via `waitForSelector`. */
    function streamingPage(opts: { waitResolves: boolean }): Page & { waitedFor: string[] } {
        const waitedFor: string[] = [];
        const page = {
            locator: () => ({ count: async () => 0 }),
            waitForSelector: async (selector: string) => {
                waitedFor.push(selector);
                if (!opts.waitResolves) throw new Error('Timeout exceeded');
                return {};
            },
            waitedFor,
        };
        return page as unknown as Page & { waitedFor: string[] };
    }

    it('never waits on the happy path', async () => {
        const page = streamingPage({ waitResolves: false });
        expect(await isNotFoundPage(page)).toBe(false);
        expect(page.waitedFor).toEqual([]);
    });

    // Navigation resolves at `commit`, so the <head> markers can still be streaming when the arrival
    // check runs. This is the second look that catches them.
    it('catches markers that had not been parsed yet at arrival', async () => {
        const page = streamingPage({ waitResolves: true });
        expect(await isNotFoundPage(page, 3_000)).toBe(true);
        // One combined CSS selector list, so the timeout is not silently doubled.
        expect(page.waitedFor).toEqual([NOT_FOUND_SELECTORS.join(', ')]);
    });

    it('reports false instead of throwing when the wait times out', async () => {
        const page = streamingPage({ waitResolves: false });
        expect(await isNotFoundPage(page, 50)).toBe(false);
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

describe('storefront identity', () => {
    // Verified against a real es.aliexpress.com capture: the browser sends exactly these three.
    it('gives a ship-to country its own storefront, not the global catalogue', () => {
        expect(storefrontFor('ES')).toEqual({ site: 'esp', locale: 'es_ES', currency: 'EUR' });
        expect(storefrontFor('es')).toEqual({ site: 'esp', locale: 'es_ES', currency: 'EUR' });
    });

    it('falls back to the global catalogue for unknown or absent countries', () => {
        expect(storefrontFor('ZZ')).toBe(GLOBAL_STOREFRONT);
        expect(storefrontFor(undefined)).toBe(GLOBAL_STOREFRONT);
        expect(GLOBAL_STOREFRONT.site).toBe('glo');
    });

    it('collapses every region to the global catalogue when matchStorefrontLocale is off', () => {
        const matched = buildConfig({});
        const global = buildConfig({ matchStorefrontLocale: false });
        expect(matched.matchStorefrontLocale).toBe(true);
        expect(storefrontForRequest('ES', matched).site).toBe('esp');
        expect(storefrontForRequest('ES', global)).toBe(GLOBAL_STOREFRONT);
        expect(storefrontForRequest('VN', global).currency).toBe('USD');
    });
});

describe('aep_usuc_f locale cookie', () => {
    // Values legitimately contain `|` and `%`; URLSearchParams would mangle both.
    it('round-trips values that are not percent-encoded', () => {
        const raw = 'site=esp&province=919971656567000000&c_tp=EUR&ups_d=1|1|1|1&region=ES&b_locale=es_ES';
        const parts = parseLocaleCookie(raw);
        expect(parts.ups_d).toBe('1|1|1|1');
        expect(parts.site).toBe('esp');
        expect(buildLocaleCookie(parts)).toBe(raw);
    });

    it('drops empty parts rather than emitting a bare key=', () => {
        expect(buildLocaleCookie({ site: 'esp', province: '', region: 'ES' })).toBe('site=esp&region=ES');
    });

    it('carries the resolved delivery address, and never invents one', () => {
        expect(addressFromLocaleCookie('ES', 'site=esp&province=919971656567000000&city=919971656567047000&region=ES')).toEqual({
            country: 'ES',
            province: '919971656567000000',
            city: '919971656567047000',
        });
        expect(addressFromLocaleCookie('ES', 'site=esp&region=ES')).toEqual({ country: 'ES', province: '', city: '' });
        expect(addressFromLocaleCookie('US', null)).toEqual({ country: 'US', province: '', city: '' });
    });
});

describe('regional unavailability', () => {
    // The shape a localized storefront returns for a listing it has withdrawn: ret is SUCCESS and
    // `result` is well-formed, but GLOBAL_DATA is the ONLY module in it.
    const banned = {
        GLOBAL_DATA: {
            globalData: {
                bigBossBan: true,
                errorCode: 'SITEM_BAN_NO_AVAIL_SKU',
                bigBossBanTip: 'Lo sentimos, este artículo actualmente no está disponible en tu ubicación. ',
            },
        },
    };

    it('reads AliExpress own refusal code and shopper-facing message', () => {
        expect(pdpUnavailability(banned)).toEqual({
            errorCode: 'SITEM_BAN_NO_AVAIL_SKU',
            message: 'Lo sentimos, este artículo actualmente no está disponible en tu ubicación.',
        });
    });

    it('falls back to a generic code when only the ban flag is set', () => {
        expect(pdpUnavailability({ GLOBAL_DATA: { globalData: { bigBossBan: true } } })).toEqual({
            errorCode: 'BIG_BOSS_BAN',
            message: null,
        });
    });

    it('stays silent for a live listing, so real blocks keep rotating', () => {
        expect(pdpUnavailability({ PRODUCT_TITLE: { text: 'A live product' }, GLOBAL_DATA: { globalData: { currencyCode: 'EUR' } } })).toBeNull();
        // An empty/blocked result must not be mistaken for a merchandising refusal.
        expect(pdpUnavailability({})).toBeNull();
    });

    // Guards the ordering in `extractProduct`: a refused listing has no title, and the older
    // "no title ⇒ blocked" rule would have spent the whole retry budget rotating IPs against it.
    it('produces no product fields, which is why it must be detected before the title check', () => {
        expect(parsePdpResult(banned).title).toBeNull();
    });
});

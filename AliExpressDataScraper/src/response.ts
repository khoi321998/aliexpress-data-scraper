import type { ProductSellerResponse } from './types.js';
import { extractAliExpressItemId } from './url.js';

/**
 * Build an empty AliExpress {@link ProductSellerResponse} skeleton for a given product URL.
 *
 * Every field is initialized to its "absent" default (null / empty array / empty object)
 * so scrapers only have to fill in what they actually find on the page. `platform`,
 * `url`, `capturedAt` and the product id are populated up front.
 */
export function createAliExpressResponse(url: string): ProductSellerResponse {
    return {
        platform: 'aliexpress',
        url,
        capturedAt: new Date().toISOString(),
        captureMode: 'product_only',
        product: {
            id: {
                platformItemId: extractAliExpressItemId(url) ?? '',
                otherIds: {
                    mpn: null,
                    modelNumber: null,
                    ean: null,
                    upc: null,
                    gtin: null,
                },
            },
            title: '',
            brand: null,
            category: {
                breadcrumb: [],
                leafCategoryName: null,
                leafCategoryId: null,
                categoryPathIds: [],
            },
            pricing: {
                currency: '',
                price: null,
                priceMin: null,
                priceMax: null,
            },
            stock: {
                availableQuantity: null,
                soldCount: null,
            },
            condition: {
                conditionText: null,
                returnPolicySummary: null,
                guaranteeLabels: [],
                authenticityClaims: [],
            },
            origin: {
                itemLocationText: null,
                itemCountryCode: null,
                shipsFromLocations: [],
                warehouseCountryCodes: [],
            },
            shipping: {
                options: [],
                deliveryTimeText: null,
            },
            paymentMethods: [],
            description: {
                html: '',
                plainText: '',
            },
            specifications: [],
            media: {
                images: [],
                videos: [],
            },
            reviewsSummary: {
                rating: null,
                reviewCount: null,
                ratingBreakdown: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
                reviewSamples: [],
                authenticityKeywords: [],
                buyerMediaCounts: { images: 0, videos: 0 },
            },
        },
        sellerRef: null,
        seller: null,
        technical: {
            scriptBlocks: [],
            jsonState: {},
            dataAttributes: {},
            rawUrlParameters: {},
            experimentIds: [],
            trackingIds: {
                googleAnalytics: [],
                facebookPixel: [],
            },
            pageContext: {
                pageType: null,
                searchQuery: null,
                position: 0,
                listingType: null,
                campaignId: null,
            },
            fulfilmentCodes: [],
            jsBundles: [],
            cssBundles: [],
            apiEndpoints: [],
        },
        sellerTechnical: null,
    };
}

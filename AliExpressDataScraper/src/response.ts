import type { Product, ProductSellerResponse, Technical } from './types.js';
import { extractAliExpressItemId } from './url.js';

/** The empty {@link Technical} diagnostics block shared by every response skeleton. */
function emptyTechnical(): Technical {
    return {
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
    };
}

/**
 * Build an empty AliExpress {@link ProductSellerResponse} skeleton for a given product URL.
 *
 * Every field is initialized to its "absent" default (null / empty array / empty object)
 * so scrapers only have to fill in what they actually find on the page. `platform`,
 * `url`, `capturedAt` and the product id are populated up front.
 *
 * The return type narrows `product` to non-null (it's always built here), so the product handler
 * can assign `response.product.<field>` without null checks even though the DTO field is nullable
 * (only `seller_only` runs, which use {@link createSellerOnlyResponse}, leave it null).
 */
export function createAliExpressResponse(url: string): ProductSellerResponse & { product: Product } {
    return {
        platform: 'aliexpress',
        url,
        capturedAt: new Date().toISOString(),
        captureMode: 'product_only',
        product: {
            id: extractAliExpressItemId(url) ?? '',
            title: '',
            brand: null,
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
        technical: emptyTechnical(),
        sellerTechnical: null,
    };
}

/**
 * Build a {@link ProductSellerResponse} skeleton for a `seller_only` run.
 *
 * There is no product page in this mode, so `product` is `null`. We seed `sellerRef` from the store
 * URL + parsed store id (the handler fills `name` from the seller API), leaving `seller` for the
 * handler to populate once the API responds.
 */
export function createSellerOnlyResponse(storeUrl: string, storeId: string): ProductSellerResponse {
    return {
        platform: 'aliexpress',
        url: storeUrl,
        capturedAt: new Date().toISOString(),
        captureMode: 'seller_only',
        product: null,
        sellerRef: {
            platformSellerId: storeId,
            name: null,
            url: storeUrl,
        },
        seller: null,
        technical: emptyTechnical(),
        sellerTechnical: null,
    };
}

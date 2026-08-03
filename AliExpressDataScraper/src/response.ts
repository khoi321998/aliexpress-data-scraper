import type { Product, ProductSellerResponse, Technical } from './types.js';
import { extractAliExpressItemId } from './url.js';

/**
 * Payment method icon URLs shown in the AliExpress site footer (`#_footer_card_list_`). Identical
 * on every product page — not scraped, just the same static set every PDP renders.
 */
const PAYMENT_METHODS: string[] = [
    'https://ae-pic-a1.aliexpress-media.com/kf/S2ee1f368a78345c293982065980ceddeG/216x144.png',
    'https://ae-pic-a1.aliexpress-media.com/kf/S7b20ce778ba44e60a062008c35e98b57M/216x144.png',
    'https://ae-pic-a1.aliexpress-media.com/kf/S8331b2acbf4a439f960a474048fb401fv/216x144.png',
    'https://ae-pic-a1.aliexpress-media.com/kf/S91ee3e0f4fde4535aad35f7c30f6bacfh/216x144.png',
    'https://ae-pic-a1.aliexpress-media.com/kf/Sf14f351eb8754ed29274ff420aae88b4y/216x144.png',
    'https://ae-pic-a1.aliexpress-media.com/kf/S8df1a1d99c8049d1b1a86c9a144719b6W/216x144.png',
    'https://ae-pic-a1.aliexpress-media.com/kf/S2a5881f5906b4fb58a0c6da600ddf7bf1/216x144.png',
    'https://ae-pic-a1.aliexpress-media.com/kf/S173da9e53a234dcb9795cebd1856c4d7J/216x144.png',
    'https://ae-pic-a1.aliexpress-media.com/kf/Sdf4f036432294444ac2d1d1dd96ec54ak/333x72.png',
    'https://ae-pic-a1.aliexpress-media.com/kf/S0321450614244c4dafba2517560de3b8s/216x144.png',
    'https://ae-pic-a1.aliexpress-media.com/kf/S731eb6a4a8a144baaa0d49e60fbd5467C.png',
];

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
                priceMin: null,
                priceMax: null,
            },
            stock: {
                availableQuantity: null,
                soldCount: null,
            },
            shipping: {
                deliveryTimeText: null,
            },
            paymentMethods: PAYMENT_METHODS,
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

/**
 * Unified product-scraper response DTO.
 *
 * Shared across marketplaces (eBay, AliExpress, ...). A scraper fills as many
 * fields as the target page exposes; anything genuinely absent is `null` (or an
 * empty array/object), never silently dropped.
 */

export type Platform = 'ebay' | 'aliexpress' | string;

export type CaptureMode = 'product_only' | 'product_and_seller' | string;

export type RatingType = 'positive' | 'negative' | 'neutral';

/** Top-level scrape envelope returned for a single URL. */
export interface ProductSellerResponse {
    platform: Platform;
    url: string;
    /** ISO-8601 timestamp of when the page was captured. */
    capturedAt: string;
    captureMode: CaptureMode;
    product: Product;
    sellerRef: SellerRef | null;
    seller: Seller | null;
    technical: Technical;
    sellerTechnical: SellerTechnical | null;
}

export interface Product {
    id: ProductId;
    title: string;
    brand: string | null;
    category: Category;
    pricing: Pricing;
    stock: Stock;
    condition: Condition;
    origin: Origin;
    shipping: Shipping;
    paymentMethods: string[];
    description: Description;
    specifications: Specification[];
    media: Media;
    reviewsSummary: ReviewsSummary;
}

export interface ProductId {
    /** The marketplace's native item identifier (e.g. eBay item id, AliExpress productId). */
    platformItemId: string;
    otherIds: OtherIds;
}

export interface OtherIds {
    mpn: string | null;
    modelNumber: string | null;
    ean: string | null;
    upc: string | null;
    gtin: string | null;
}

export interface Category {
    breadcrumb: string[];
    leafCategoryName: string | null;
    leafCategoryId: string | null;
    categoryPathIds: string[];
}

export interface Pricing {
    currency: string;
    price: number | null;
    priceMin: number | null;
    priceMax: number | null;
}

export interface Stock {
    availableQuantity: number | null;
    soldCount: number | null;
}

export interface Condition {
    conditionText: string | null;
    returnPolicySummary: string | null;
    guaranteeLabels: string[];
    authenticityClaims: string[];
}

export interface Origin {
    itemLocationText: string | null;
    itemCountryCode: string | null;
    shipsFromLocations: string[];
    warehouseCountryCodes: string[];
}

export interface Shipping {
    options: ShippingOption[];
    deliveryTimeText: string | null;
}

export interface ShippingOption {
    name: string;
    cost: number | null;
    currency: string;
    estimatedDeliveryMinDays: number | null;
    estimatedDeliveryMaxDays: number | null;
}

export interface Description {
    html: string;
    plainText: string;
}

export interface Specification {
    name: string;
    value: string;
}

export interface Media {
    images: ProductImage[];
    videos: ProductVideo[];
}

export interface ProductImage {
    url: string;
    /** Stable key extracted from the image URL, used to de-duplicate variants. */
    variantKey: string | null;
    isMain: boolean;
}

export interface ProductVideo {
    url: string;
    poster?: string | null;
}

export interface ReviewsSummary {
    rating: number | null;
    reviewCount: number | null;
    /** Count of reviews per star value, keyed "1".."5". */
    ratingBreakdown: RatingBreakdown;
    negativeReviewSamples: ReviewSample[];
    positiveReviewSamples: ReviewSample[];
    authenticityKeywords: string[];
    buyerMediaCounts: BuyerMediaCounts;
}

export interface RatingBreakdown {
    '1': number;
    '2': number;
    '3': number;
    '4': number;
    '5': number;
}

export interface ReviewSample {
    user: string;
    userFeedbackScore: number | null;
    comment: string;
    /** Free-text recency label as shown on the page, e.g. "Past 6 months". */
    commentDate: string;
    ratingType: RatingType;
    verifiedPurchase: boolean;
}

export interface BuyerMediaCounts {
    images: number;
    videos: number;
}

/** Lightweight pointer to a seller (id/handle) without the full profile. */
export interface SellerRef {
    platformSellerId: string | null;
    name: string | null;
    url: string | null;
}

/** Full seller profile. Shape extends as more seller fields are scraped. */
export interface Seller {
    platformSellerId: string | null;
    name: string | null;
    url: string | null;
    positiveFeedbackPercent: number | null;
    feedbackScore: number | null;
    [key: string]: unknown;
}

/** Raw / diagnostic signals harvested from the page for debugging & enrichment. */
export interface Technical {
    scriptBlocks: string[];
    jsonState: Record<string, unknown>;
    dataAttributes: Record<string, unknown>;
    rawUrlParameters: Record<string, string>;
    experimentIds: string[];
    trackingIds: TrackingIds;
    pageContext: PageContext;
    fulfilmentCodes: string[];
    jsBundles: string[];
    cssBundles: string[];
    apiEndpoints: string[];
}

export interface TrackingIds {
    googleAnalytics: string[];
    facebookPixel: string[];
}

export interface PageContext {
    pageType: string | null;
    searchQuery: string | null;
    position: number;
    listingType: string | null;
    campaignId: string | null;
}

/** Technical signals specific to the seller page (when captured). */
export type SellerTechnical = Technical;

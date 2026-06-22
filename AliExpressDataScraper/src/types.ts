/**
 * Unified product-scraper response DTO.
 *
 * Shared across marketplaces (eBay, AliExpress, ...). A scraper fills as many
 * fields as the target page exposes; anything genuinely absent is `null` (or an
 * empty array/object), never silently dropped.
 */

export type Platform = 'ebay' | 'aliexpress' | string;

export type CaptureMode = 'product_only' | 'product_and_seller' | 'seller_only' | string;

/** Top-level scrape envelope returned for a single URL. */
export interface ProductSellerResponse {
    platform: Platform;
    url: string;
    /** ISO-8601 timestamp of when the page was captured. */
    capturedAt: string;
    captureMode: CaptureMode;
    /** The scraped product, or `null` in `seller_only` runs (no product page is visited). */
    product: Product | null;
    sellerRef: SellerRef | null;
    seller: Seller | null;
    technical: Technical;
    sellerTechnical: SellerTechnical | null;
}

export interface Product {
    /** The marketplace's native item identifier (e.g. AliExpress productId). */
    id: string;
    title: string;
    brand: string | null;
    pricing: Pricing;
    stock: Stock;
    shipping: Shipping;
    paymentMethods: string[];
    description: Description;
    specifications: Specification[];
    media: Media;
    reviewsSummary: ReviewsSummary;
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

export interface Shipping {
    deliveryTimeText: string | null;
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
    /** Sample reviews as shown on the page, each carrying its own star `rating`. */
    reviewSamples: ReviewSample[];
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
    /** English machine-translation of {@link comment}, when the review was written in another language. */
    commentTranslated?: string | null;
    /** Free-text recency label as shown on the page, e.g. "Past 6 months". */
    commentDate: string;
    /** Star rating of this individual review (1–5), when shown. The only sentiment signal AliExpress exposes. */
    rating: number | null;
    verifiedPurchase: boolean;
    /** Buyer-uploaded photo URLs attached to this review. */
    images: string[];
}

/** Lightweight pointer to a seller (id/handle) without the full profile. */
export interface SellerRef {
    platformSellerId: string | null;
    name: string | null;
    url: string | null;
}

/** A lightweight preview of one of the seller's other products, scraped from the PDP's
 *  "Recommended from <store>" strip (`pcDetailBottomMoreThisSeller`). */
export interface SellerProductPreview {
    productId: string | null;
    title: string | null;
    url: string | null;
    imageUrl: string | null;
    /** Current price as a number. */
    price: number | null;
}

/**
 * A single seller-store review — the lean subset shown on the store's "Customer reviews" panel:
 * reviewer, date, star rating, the comment, and any buyer photos.
 * Deliberately narrower than {@link ReviewSample} (no feedback score / verified flag) since the
 * seller endpoint only surfaces these display fields.
 */
export interface SellerReviewSample {
    /** Reviewer's masked display name, e.g. "A***z". */
    user: string;
    /** Star rating of this review (1–5), when shown. */
    rating: number | null;
    /** Date shown on the review, e.g. "14 Aug 2025". */
    commentDate: string;
    /** The review text, in its original language. */
    comment: string;
    /** English machine-translation of {@link comment}, when written in another language. */
    commentTranslated?: string | null;
    /** Buyer-uploaded photo URLs attached to this review. */
    images: string[];
}

/** Full seller profile. Shape extends as more seller fields are scraped. */
export interface Seller {
    platformSellerId: string | null;
    name: string | null;
    url: string | null;
    positiveFeedbackPercent: number | null;
    feedbackScore: number | null;
    /** Other products by this seller, scraped from the PDP recommendation strip. */
    productPreviews?: SellerProductPreview[];
    /** Sample store reviews, collected per star rating (at most a few per star). */
    sellerReviews?: SellerReviewSample[];
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

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
    /**
     * The Apify run that produced this record, or `null` when the scraper ran outside the platform
     * (local `apify run`, tests). Lets a consumer trace any dataset item back to its run.
     */
    actorRunId: string | null;
    captureMode: CaptureMode;
    /** The ship-to country this URL was read under (ISO-3166 alpha-2). */
    shipToCountry: string;
    /** AliExpress storefront code the data came from — `esp`, `usa`, `glo`, … */
    storefront: string;
    /**
     * The one field to branch on: `true` ⇒ product data is present, `false` ⇒ it is not and
     * {@link errorCode} says why. Every record carries it, so nothing downstream has to tell two
     * record shapes apart.
     */
    success: boolean;
    /** `null` when {@link success}. Otherwise one of {@link ScrapeErrorCode}. */
    errorCode: ScrapeErrorCode | null;
    /** `null` when {@link success}. Otherwise the detail behind {@link errorCode}, for a human. */
    errorMessage: string | null;
    /** The scraped product, or `null` in `seller_only` runs (no product page is visited). */
    product: Product | null;
    sellerRef: SellerRef | null;
    seller: Seller | null;
    technical: Technical;
    sellerTechnical: SellerTechnical | null;
    /** Health of this record's extraction — see {@link ExtractionReport}. Filled just before push. */
    extraction: ExtractionReport;
}

/**
 * Why a record carries no product. Deliberately three codes, not more: they are the three DIFFERENT
 * follow-ups a caller can take, and the specific cause (which captcha, which AliExpress ban code)
 * lives in `errorMessage` rather than multiplying the set a backend has to switch on.
 *
 *   - `not_found` — no listing with this item id exists (AliExpress served its 404 page). The URL is
 *     wrong or the listing was deleted. Retrying, in any region, cannot produce it.
 *   - `unavailable_in_region` — AliExpress answered and refused the listing for THIS market
 *     (`bigBossBan`). Re-running with a different ship-to country is worth doing.
 *   - `blocked` — we never got an answer: anti-bot block, timeout or transport error, after the retry
 *     budget was spent. The ONLY code where re-running the same URL unchanged may still succeed.
 *
 * The first two are definitive answers from AliExpress; `blocked` is the absence of an answer.
 */
export type ScrapeErrorCode = 'not_found' | 'unavailable_in_region' | 'blocked';

// --- Extraction health ---------------------------------------------------------------------------

/** `critical` = the record cannot have parsed correctly without it; `warning` = usually present. */
export type ExtractionSeverity = 'critical' | 'warning';

export type ExtractionStatus = 'ok' | 'degraded' | 'broken';

/**
 * One expected-but-absent field: what is missing, and the source it should have come from.
 *
 * Deliberately just those two — whether the value arrived as `null` or `''` says nothing a reader
 * can act on; both mean the source stopped yielding it, and the fix is the same either way. Since
 * this scraper reads AliExpress's signed JSON APIs rather than the DOM, `source` names the API and
 * the JSON property path (`pdp.pc.query → PRODUCT_TITLE.text`); an absent field there almost always
 * means AliExpress renamed or moved that property.
 */
export interface ExtractionIssue {
    field: string;
    source?: string;
}

export interface ExtractionReport {
    /** `broken` if any critical field is absent, `degraded` if only warnings, else `ok`. */
    status: ExtractionStatus;
    /** How many declared checks actually applied to this record (mode-dependent). */
    checkedFields: number;
    missingFields: string[];
    issues: ExtractionIssue[];
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

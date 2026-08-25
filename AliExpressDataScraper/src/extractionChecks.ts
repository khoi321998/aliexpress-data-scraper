/*
The extraction-health expectations — ONE table per pushed record shape.

This Actor pushes two shapes, so each gets its own array rather than one array full of `when`
guards: {@link PRODUCT_CHECKS} for `product_only` / `product_and_seller` records, and
{@link SELLER_ONLY_CHECKS} for `seller_only` records (`product: null`, no PDP is ever visited).

`source` is the CURRENT, CORRECT API property path — the one the parser in `productApi.ts` /
`sellerApi.ts` / `reviewsApi.ts` should be reading. It is deliberately kept correct here even while
debugging a break, so the report points straight at the fix site.

What earns a severity:
  - `critical` — no live AliExpress listing/store can lack it; its absence means the response shape
    changed. Kept short.
  - `warning`  — present on the overwhelming majority, but a legitimate listing can miss it.
  - left out   — often legitimately absent (see the "deliberately unwatched" note at the bottom).
    A check that fires on healthy records trains people to ignore the report.
*/
import type { FieldCheck, RecordLike } from './extractionAudit.js';

/** Read a dot path and coerce to a finite number, else null — used by the `when` gates. */
function numAt(record: RecordLike, path: string): number | null {
    const value = path.split('.').reduce<unknown>((acc, key) => (acc == null ? acc : (acc as RecordLike)[key]), record);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * True when the record itself says the product HAS reviews, so the review fields must be populated.
 * A brand-new listing with zero reviews legitimately has none of them — gating on this is what keeps
 * the review checks silent on those instead of flagging every new product.
 *
 * `reviewCount` comes from `review.pc.list → productEvaluationStatistic.totalNum` with a fallback to
 * the PDP's own `PC_RATING.totalValidNum`, so it survives the whole reviews API going dark — which
 * is exactly when we want the `reviewSamples` check to fire.
 */
const hasReviews = (r: RecordLike) => (numAt(r, 'product.reviewsSummary.reviewCount') ?? 0) > 0;

/**
 * True when the per-star breakdown carries counts. Deliberately a DIFFERENT set of properties
 * (`oneStarNum`…`fiveStarNum`) from the one it gates (`totalNum`), so a rename of `totalNum` alone
 * still trips `reviewCount` instead of silently closing its own gate.
 */
const hasRatingBreakdown = (r: RecordLike) => {
    const breakdown = ['1', '2', '3', '4', '5'].map((star) => numAt(r, `product.reviewsSummary.ratingBreakdown.${star}`) ?? 0);
    return breakdown.reduce((sum, n) => sum + n, 0) > 0;
};

/**
 * True only when the seller scrape actually returned a profile. `product_only` runs never fetch one,
 * and in `product_and_seller` the seller APIs run on a different gateway that can be blocked on its
 * own (leaving `seller: null`). Both are anti-bot / mode outcomes, not property rot — the run log
 * already reports them — so the seller checks stay out of the count entirely in those cases.
 */
const hasSeller = (r: RecordLike) => r.seller != null;

/** True when the store reports six-month review counts, so its review list must be non-empty. */
const hasSellerReviews = (r: RecordLike) => (numAt(r, 'seller.reviewCounts.total') ?? 0) > 0;

/**
 * Fields ONLY `seller.page.info` can fill — no other endpoint carries them, so they are the signal
 * for whether that endpoint answered at all. Deliberately excludes `positiveFeedbackPercent`,
 * `followersText` and `scores`: `shop.benefit.info` fills those, so they would report a profile that
 * never arrived.
 */
const PROFILE_ONLY_PATHS = ['seller.countryName', 'seller.openedSinceText', 'seller.storeLogo', 'seller.reviewCounts.total'];

/**
 * True when `seller.page.info` actually returned a profile.
 *
 * It answers `SUCCESS` with an empty `data: {}` for stores it holds nothing for — typically ones with
 * no feedback (verified on seller 2671922206, whose PDP card reports `hasStore: false`). There is then
 * no country, no opening date and no credibility to be had from ANY endpoint, so flagging them as
 * missing reports a fact about the store as if it were property rot. Gate on this and those checks go
 * quiet exactly when the endpoint had nothing, while still firing when it answered and a field
 * genuinely vanished.
 */
const hasSellerProfile = (r: RecordLike) =>
    PROFILE_ONLY_PATHS.some((path) => path.split('.').reduce<unknown>((acc, key) => (acc == null ? acc : (acc as RecordLike)[key]), r) != null);

/** Records with a product: `product_only` and `product_and_seller`. */
export const PRODUCT_CHECKS: FieldCheck[] = [
    // --- Core: a live PDP cannot have parsed correctly without these ----------------------------
    { path: 'product.id', severity: 'critical', source: 'URL path /item/{id}.html' },
    { path: 'product.title', severity: 'critical', source: 'pdp.pc.query → PRODUCT_TITLE.text' },
    {
        path: 'product.pricing.priceMin',
        severity: 'critical',
        source: 'pdp.pc.query → PRICE.skuPriceInfoMap[].salePriceString | PRICE.targetSkuPriceInfo.salePriceString',
    },
    {
        path: 'product.media.images',
        severity: 'critical',
        source: 'pdp.pc.query → HEADER_IMAGE_PC.imagePathList | .imgList | .mainImages[].imageUrl',
    },
    {
        path: 'sellerRef.platformSellerId',
        severity: 'critical',
        source: 'pdp.pc.query → SHOP_CARD_PC.sellerInfo.adminSeq | .companyId',
    },

    // --- Detail: present on the overwhelming majority of live listings ---------------------------
    { path: 'product.pricing.currency', severity: 'warning', source: 'pdp.pc.query → PRICE.{targetSkuPriceInfo,skuPriceInfoMap[*],itemRangePriceView}.<amount>.currency | GLOBAL_DATA.globalData.currencyCode' },
    { path: 'product.specifications', severity: 'warning', source: 'pdp.pc.query → PRODUCT_PROP_PC.showedProps[].attrName/.attrValue' },
    { path: 'product.stock.availableQuantity', severity: 'warning', source: 'pdp.pc.query → QUANTITY_PC.totalAvailableInventory' },
    {
        path: 'product.shipping.deliveryTimeText',
        severity: 'warning',
        source: 'pdp.pc.query → SHIPPING.deliveryLayoutInfo[selected].bizData.displayEta{Min,Max}Date | its ETA layout block',
    },
    { path: 'product.description.html', severity: 'warning', source: 'pdp.pc.query → DESC.pcDescUrl (HTML fetched from that URL)' },
    { path: 'sellerRef.name', severity: 'warning', source: 'pdp.pc.query → SHOP_CARD_PC.storeName' },
    { path: 'sellerRef.url', severity: 'warning', source: 'pdp.pc.query → SHOP_CARD_PC.sellerInfo.storeURL' },

    // --- Reviews: gated, because a listing with no reviews is normal ------------------------------
    {
        path: 'product.reviewsSummary.rating',
        severity: 'warning',
        source: 'review.pc.list → data.productEvaluationStatistic.evarageStar | pdp.pc.query → PC_RATING.rating',
        when: hasReviews,
    },
    {
        path: 'product.reviewsSummary.reviewSamples',
        severity: 'warning',
        source: 'review.pc.list → data.evaViewList[]',
        when: hasReviews,
    },
    {
        path: 'product.reviewsSummary.reviewCount',
        severity: 'warning',
        source: 'review.pc.list → data.productEvaluationStatistic.totalNum | pdp.pc.query → PC_RATING.totalValidNum',
        when: hasRatingBreakdown,
    },

    // --- Seller enrichment: only counted when a profile actually came back ------------------------
    { path: 'seller.name', severity: 'warning', source: 'seller.page.info → data.sellerBaseInfo.storeName', when: hasSeller },
    {
        path: 'seller.countryName',
        severity: 'warning',
        source: 'seller.page.info → data.sellerBaseInfo.countryName',
        when: (r) => hasSeller(r) && hasSellerProfile(r),
    },
    {
        path: 'seller.openedSinceText',
        severity: 'warning',
        source: 'seller.page.info → data.sellerBaseInfo.since',
        when: (r) => hasSeller(r) && hasSellerProfile(r),
    },
    {
        path: 'seller.positiveFeedbackPercent',
        severity: 'warning',
        source: 'seller.page.info → data.buyerEvaluationInfo.positiveFeedBackValue | shop.benefit.info → benefitInfoList[FeedBack].value',
        when: (r) => hasSeller(r) && hasSellerProfile(r),
    },
    {
        path: 'seller.scores',
        severity: 'warning',
        source: 'seller.page.info → data.operatingScoreInfoList[].title/.value | shop.benefit.info → benefitInfoList[storerating.*]',
        when: (r) => hasSeller(r) && hasSellerProfile(r),
    },
    {
        path: 'seller.productPreviews',
        severity: 'warning',
        source: 'ModuleAsyncService (componentKey productList | allitems_choice) → data.products.data[]',
        when: hasSeller,
    },
    {
        path: 'seller.sellerReviews',
        severity: 'warning',
        source: 'evaluation.productEvaluation → data.evaViewList[]',
        when: (r) => hasSeller(r) && hasSellerReviews(r),
    },
];

/**
 * `seller_only` records. The store profile IS the record here, so its two headline fields are
 * `critical` rather than `warning`: a store row with no name and no catalog carries nothing.
 *
 * The pipeline (`sellerPipeline.ts`) already retries a store on a fresh browser when EVERYTHING came
 * back empty, so a pushed record that is still missing one of these is either a partial block on one
 * of the three seller gateways or a genuine property rename — both worth an error-level line.
 */
/**
 * Records with `success: false` — the listing was refused for this region, no such listing exists, or
 * the scrape never got an answer at all.
 *
 * {@link PRODUCT_CHECKS} would report every product field as absent here and grade the record
 * `broken` — the audit's word for "AliExpress renamed a property, go fix the parser". Nothing is
 * broken: there is no title, price or image to be had from ANY endpoint, and `errorCode` already
 * says why. Only the facts such a record genuinely must carry are checked, keeping the `broken`
 * signal meaningful for records that really did rot.
 */
export const NO_LISTING_CHECKS: FieldCheck[] = [
    { path: 'product.id', severity: 'critical', source: 'URL path /item/{id}.html' },
    { path: 'errorCode', severity: 'critical', source: 'set by extractProduct / the product handler / the give-up handler' },
    { path: 'errorMessage', severity: 'warning', source: 'set alongside errorCode' },
];

export const SELLER_ONLY_CHECKS: FieldCheck[] = [
    { path: 'seller.name', severity: 'critical', source: 'seller.page.info → data.sellerBaseInfo.storeName' },
    {
        path: 'seller.productPreviews',
        severity: 'critical',
        source: 'ModuleAsyncService (componentKey productList | allitems_choice) → data.products.data[]',
    },
    { path: 'seller.platformSellerId', severity: 'critical', source: 'renderPageData.htm → result.pageData.globalData.sellerId | .bizId' },

    { path: 'seller.countryName', severity: 'warning', source: 'seller.page.info → data.sellerBaseInfo.countryName', when: hasSellerProfile },
    { path: 'seller.openedSinceText', severity: 'warning', source: 'seller.page.info → data.sellerBaseInfo.since', when: hasSellerProfile },
    {
        path: 'seller.positiveFeedbackPercent',
        severity: 'warning',
        source: 'seller.page.info → data.buyerEvaluationInfo.positiveFeedBackValue | shop.benefit.info → benefitInfoList[FeedBack].value',
        when: hasSellerProfile,
    },
    {
        path: 'seller.scores',
        severity: 'warning',
        source: 'seller.page.info → data.operatingScoreInfoList[].title/.value | shop.benefit.info → benefitInfoList[storerating.*]',
        when: hasSellerProfile,
    },
    { path: 'seller.sellerReviews', severity: 'warning', source: 'evaluation.productEvaluation → data.evaViewList[]', when: hasSellerReviews },
];

/*
Deliberately UNWATCHED — each would fire on healthy records:
  - seller.soldByStoreText     — `shop.benefit.info` omits the 180-day order counter for stores under
  - seller.regularBuyersText     its display threshold, so a quiet-but-healthy store has neither.
  - product.brand              — no code path ever fills it; it is `null` on every record today.
  - product.paymentMethods     — a hardcoded constant list in `response.ts`, not scraped.
  - product.pricing.priceMax   — same `skuPriceInfoMap` values as priceMin; would double-report.
  - product.stock.soldCount    — regex over PC_RATING.otherText ("236 sold"); a listing with no sales
                                 has no such text at all.
  - product.media.videos       — most listings have no video.
  - product.description.plainText — image-only descriptions (very common) yield markup but no text.
  - product.reviewsSummary.ratingBreakdown — always an object with keys "1".."5", so it can never read
                                 as absent; it is used as a `when` gate instead.
  - seller.feedbackScore / storeLogo / followersText — a new or small store legitimately reports none.
  - technical / sellerTechnical — empty diagnostic stubs; nothing populates them.
*/

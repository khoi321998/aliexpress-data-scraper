// The ONE place a scraped record enters the dataset.
//
// Both pipelines (`routes.ts` for products, `sellerPipeline.ts` for `seller_only`) push through
// here so the extraction audit cannot be skipped by adding a new push somewhere else. The audit runs
// immediately before the push — auditing mid-pipeline would flag fields a later step still fills in
// (description, reviews and the seller profile all land after the PDP parse).
import type { Log } from 'apify';
import { Actor } from 'apify';

import type { FieldCheck } from './extractionAudit.js';
import { auditExtraction, logExtractionReport } from './extractionAudit.js';
import { NO_LISTING_CHECKS, PRODUCT_CHECKS, SELLER_ONLY_CHECKS } from './extractionChecks.js';
import type { ProductSellerResponse } from './types.js';

/**
 * Audit `response` against the checks for its record shape, attach the report, log it, and push.
 * A silent API property rename shows up as `extraction.missingFields` instead of an unexplained
 * `null` somewhere in the dataset.
 */
/**
 * The expectations that apply to one record's shape. A record AliExpress gave no listing for is
 * audited against its own short list — see {@link NO_LISTING_CHECKS} for why product fields are not
 * expected there.
 */
function checksFor(response: ProductSellerResponse): FieldCheck[] {
    if (response.captureMode === 'seller_only') {
        return SELLER_ONLY_CHECKS;
    }
    return response.success ? PRODUCT_CHECKS : NO_LISTING_CHECKS;
}

export async function pushRecord(response: ProductSellerResponse, log: Log): Promise<void> {
    response.extraction = auditExtraction(response, checksFor(response));
    logExtractionReport(response.extraction, log, response.url);
    await Actor.pushData(response);
}

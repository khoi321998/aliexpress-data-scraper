// The ONE place a scraped record enters the dataset.
//
// Both pipelines (`routes.ts` for products, `sellerPipeline.ts` for `seller_only`) push through
// here so the extraction audit cannot be skipped by adding a new push somewhere else. The audit runs
// immediately before the push — auditing mid-pipeline would flag fields a later step still fills in
// (description, reviews and the seller profile all land after the PDP parse).
import { Actor } from 'apify';
import type { Log } from 'apify';

import { auditExtraction, logExtractionReport } from './extractionAudit.js';
import { PRODUCT_CHECKS, SELLER_ONLY_CHECKS } from './extractionChecks.js';
import type { ProductSellerResponse } from './types.js';

/**
 * Audit `response` against the checks for its record shape, attach the report, log it, and push.
 * A silent API property rename shows up as `extraction.missingFields` instead of an unexplained
 * `null` somewhere in the dataset.
 */
export async function pushRecord(response: ProductSellerResponse, log: Log): Promise<void> {
    const checks = response.captureMode === 'seller_only' ? SELLER_ONLY_CHECKS : PRODUCT_CHECKS;
    response.extraction = auditExtraction(response, checks);
    logExtractionReport(response.extraction, log, response.url);
    await Actor.pushData(response);
}

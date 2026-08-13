/*
Extraction health audit — the engine.

Property rot is the failure mode of this scraper. Nothing here is scraped from the DOM: every field
comes out of an AliExpress JSON API (`pdp.pc.query`, `review.pc.list`, `seller.page.info`,
`evaluation.productEvaluation`, `ModuleAsyncService`), read through `asRecord(...)` chains that
return `{}` for anything they don't recognise. So when AliExpress renames a property —
`PRODUCT_TITLE.text` → `PRODUCT_TITLE.title`, `evarageStar` → `averageStar` — nothing throws: the
lookup yields `undefined`, the field is written as `null`/`''`/`[]`, and the run still "succeeds".

Every property we expect to find is declared once in `extractionChecks.ts`, and the assembled record
is walked against it right before it is pushed. Adding a field to watch = one line in that table.

The audit only INSPECTS a finished record. It never throws, never retries, and never changes a
scraped value.
*/
import type { Log } from 'apify';

import type { ExtractionIssue, ExtractionReport, ExtractionSeverity, ExtractionStatus } from './types.js';

/** Any pushed record — checks address it by dot path, not by concrete type. */
export type RecordLike = Record<string, unknown>;

/** One declared expectation about the shape of a pushed record. */
export interface FieldCheck {
    /** Dot path into the record, e.g. `product.pricing.priceMin`. */
    path: string;
    severity: ExtractionSeverity;
    /**
     * Where the value comes from — the API plus the JSON property path, copied into the issue so the
     * fix site is obvious. Alternatives separated by ` | `, mirroring the fallbacks in the parser.
     */
    source?: string;
    /** Skip the check unless this passes — scopes a check to a capture mode / to records that should have the field. */
    when?: (record: RecordLike) => boolean;
}

export function emptyExtractionReport(): ExtractionReport {
    return { status: 'ok', checkedFields: 0, missingFields: [], issues: [] };
}

function getByPath(record: unknown, path: string): unknown {
    // `acc == null ? acc : ...` so a whole null section (e.g. `seller`) reports its children absent
    // rather than throwing.
    return path.split('.').reduce<unknown>((acc, key) => (acc == null ? acc : (acc as RecordLike)[key]), record);
}

/**
 * A renamed API property produces any of these depending on how the parser defaults. `0` and `false`
 * are real values (a product can have 0 available inventory, a review can be unverified) and never
 * count as absent.
 */
function isAbsent(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return !value.trim();
    if (Array.isArray(value)) return !value.length;
    if (typeof value === 'number') return Number.isNaN(value);
    if (typeof value === 'object') return !Object.keys(value as object).length;
    return false;
}

/** Walk `record` against `checks` and return the report. */
export function auditExtraction(record: unknown, checks: FieldCheck[]): ExtractionReport {
    const issues: ExtractionIssue[] = [];
    let checkedFields = 0;
    let criticalMissing = false;

    for (const check of checks) {
        if (check.when && !check.when((record ?? {}) as RecordLike)) continue;
        checkedFields++;
        if (!isAbsent(getByPath(record, check.path))) continue;
        if (check.severity === 'critical') criticalMissing = true;
        issues.push({
            field: check.path,
            ...(check.source ? { source: check.source } : {}),
        });
    }

    let status: ExtractionStatus = 'ok';
    if (criticalMissing) status = 'broken';
    else if (issues.length) status = 'degraded';

    return { status, checkedFields, missingFields: issues.map((i) => i.field), issues };
}

/** Surface the report in the run log — `broken` records are worth an error-level line. */
export function logExtractionReport(report: ExtractionReport, log: Log, url: string): void {
    if (report.status === 'ok') {
        log.debug(`extraction ok (${report.checkedFields} fields checked)`, { url });
        return;
    }
    const detail = { url, status: report.status, missingFields: report.missingFields };
    if (report.status === 'broken') {
        log.error(
            `extraction BROKEN — ${report.missingFields.length}/${report.checkedFields} expected fields absent, likely an API property rename`,
            detail,
        );
    } else {
        log.warning(`extraction degraded — ${report.missingFields.length}/${report.checkedFields} expected fields absent`, detail);
    }
}

import { describe, expect, it } from 'vitest';

import type { FieldCheck } from '../src/extractionAudit.js';
import { auditExtraction, emptyExtractionReport } from '../src/extractionAudit.js';
import { PRODUCT_CHECKS, SELLER_ONLY_CHECKS } from '../src/extractionChecks.js';

const CHECKS: FieldCheck[] = [
    { path: 'product.title', severity: 'critical', source: 'pdp.pc.query → PRODUCT_TITLE.text' },
    { path: 'product.stock.soldCount', severity: 'warning', source: 'pdp.pc.query → PC_RATING.otherText' },
    { path: 'product.verified', severity: 'warning' },
    { path: 'product.specifications', severity: 'warning', source: 'pdp.pc.query → PRODUCT_PROP_PC.showedProps[]' },
    { path: 'product.description.html', severity: 'warning', source: 'pdp.pc.query → DESC.pcDescUrl' },
];

/** A record where every declared check passes: `0` / `false` are real values, not absences. */
function healthyRecord() {
    return {
        product: {
            title: 'Fancy Shoes',
            stock: { soldCount: 0 },
            verified: false,
            specifications: [{ name: 'Color', value: 'Silver' }],
            description: { html: '<div>hi</div>' },
        },
    };
}

describe('auditExtraction', () => {
    it('reports ok for a healthy record and counts every applicable check', () => {
        expect(auditExtraction(healthyRecord(), CHECKS)).toEqual({
            status: 'ok',
            checkedFields: 5,
            missingFields: [],
            issues: [],
        });
    });

    it('does not flag 0 or false — they are real scraped values', () => {
        const report = auditExtraction(healthyRecord(), CHECKS);
        expect(report.missingFields).not.toContain('product.stock.soldCount');
        expect(report.missingFields).not.toContain('product.verified');
    });

    it('flags empty strings, empty arrays and empty objects', () => {
        const record = healthyRecord();
        record.product.specifications = [];
        record.product.description = { html: '   ' };
        const report = auditExtraction(record, CHECKS);
        expect(report.missingFields).toEqual(['product.specifications', 'product.description.html']);
        expect(auditExtraction({ product: { title: {} } }, [CHECKS[0]]).missingFields).toEqual(['product.title']);
    });

    it('emits exactly { field, source }, and just { field } when the check declares no source', () => {
        const record = healthyRecord();
        record.product.specifications = [];
        record.product.verified = null as unknown as boolean;
        const { issues } = auditExtraction(record, CHECKS);
        expect(issues).toEqual([
            { field: 'product.verified' },
            { field: 'product.specifications', source: 'pdp.pc.query → PRODUCT_PROP_PC.showedProps[]' },
        ]);
    });

    it('is broken when a critical field is absent, degraded when only warnings are', () => {
        const broken = healthyRecord();
        broken.product.title = '';
        broken.product.specifications = [];
        const brokenReport = auditExtraction(broken, CHECKS);
        expect(brokenReport.status).toBe('broken');
        expect(brokenReport.missingFields).toEqual(['product.title', 'product.specifications']);

        const degraded = healthyRecord();
        degraded.product.specifications = [];
        expect(auditExtraction(degraded, CHECKS).status).toBe('degraded');
    });

    it('skips a `when`-gated check when closed and counts it when open', () => {
        const gated: FieldCheck[] = [
            { path: 'product.title', severity: 'critical' },
            { path: 'seller.name', severity: 'warning', when: (r) => r.seller != null },
        ];
        const closed = auditExtraction({ product: { title: 'x' }, seller: null }, gated);
        expect(closed).toEqual({ status: 'ok', checkedFields: 1, missingFields: [], issues: [] });

        const open = auditExtraction({ product: { title: 'x' }, seller: { name: '' } }, gated);
        expect(open.checkedFields).toBe(2);
        expect(open.status).toBe('degraded');
        expect(open.missingFields).toEqual(['seller.name']);
    });

    it('walks a null section without throwing, reporting its children absent', () => {
        const report = auditExtraction({ product: null }, CHECKS);
        expect(report.status).toBe('broken');
        expect(report.checkedFields).toBe(5);
        expect(report.missingFields).toHaveLength(5);
        expect(auditExtraction(undefined, CHECKS).status).toBe('broken');
    });

    it('starts from an all-clear empty report', () => {
        expect(emptyExtractionReport()).toEqual({ status: 'ok', checkedFields: 0, missingFields: [], issues: [] });
    });
});

describe('checks tables', () => {
    // Each table is the single source of truth for one record shape; duplicate paths would
    // double-report the same absence.
    it('declare unique paths and a source for every entry', () => {
        for (const table of [PRODUCT_CHECKS, SELLER_ONLY_CHECKS]) {
            const paths = table.map((c) => c.path);
            expect(new Set(paths).size).toBe(paths.length);
            expect(table.every((c) => (c.source ?? '').length > 0)).toBe(true);
        }
    });

    // The seller section is enrichment on a product record: a `product_only` run (or a blocked
    // seller gateway) must not turn every record `broken`.
    it('gate every seller check on a product record, and keep them non-critical there', () => {
        const sellerChecks = PRODUCT_CHECKS.filter((c) => c.path.startsWith('seller.'));
        expect(sellerChecks.length).toBeGreaterThan(0);
        expect(sellerChecks.every((c) => c.when != null && c.severity === 'warning')).toBe(true);
    });

    // A product with no reviews at all is normal; the review checks must stay silent for it.
    it('stay silent on a healthy product that simply has no reviews', () => {
        const record = {
            product: {
                id: '1005009982221130',
                title: 'Fancy Shoes',
                pricing: { currency: 'USD', priceMin: 29.12 },
                media: { images: [{ url: 'https://ae.com/a.jpg' }] },
                specifications: [{ name: 'Color', value: 'Silver' }],
                stock: { availableQuantity: 717 },
                shipping: { deliveryTimeText: 'Jul 02 - 09' },
                description: { html: '<div>d</div>' },
                reviewsSummary: { rating: null, reviewCount: null, ratingBreakdown: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, reviewSamples: [] },
            },
            sellerRef: { platformSellerId: '2671658649', name: 'Aneikeh Shoes Store', url: 'https://www.aliexpress.com/store/1102738107' },
            seller: null,
        };
        expect(auditExtraction(record, PRODUCT_CHECKS)).toEqual({
            status: 'ok',
            checkedFields: 12,
            missingFields: [],
            issues: [],
        });
    });
});

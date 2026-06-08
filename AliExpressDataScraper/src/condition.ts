// Product condition / service-commitment extraction from the AliExpress PDP service panel.
//
// The right-side action panel groups service guarantees under a "Service commitment" header
// (`[class*="choice-mind"]`) and renders each commitment's label in `[class*="shipping--title"]`
// (e.g. "Return&refund policy", "Security & Privacy"). We surface the return/refund row as the
// `returnPolicySummary` and collect every commitment label into `guaranteeLabels`.
//
// `conditionText` is not exposed in this panel, so it stays at its default (null).
//
// Class names are content-hashed per build, so we match on stable `shipping--title` /
// `choice-mind` prefixes rather than exact suffixed names.
import type { Page } from 'playwright';

import type { Condition } from './types.js';

const COMMITMENT_TITLE_SELECTOR = '[class*="shipping--title"]';
const COMMITMENT_HEADER_SELECTOR = '[class*="choice-mind"]';

/** Collapse whitespace and trim; treats null/undefined as empty. */
function clean(value: string | null | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Extract service-commitment guarantees from the action panel.
 *
 * `guaranteeLabels` lists every commitment row's title (deduplicated, order preserved), plus the
 * "Service commitment" header when present. `returnPolicySummary` is the first label mentioning
 * a return/refund. Best-effort: an absent panel yields an empty `guaranteeLabels` and a null
 * summary.
 */
export async function extractCondition(page: Page): Promise<Condition> {
    const titles = await page
        .locator(COMMITMENT_TITLE_SELECTOR)
        .allTextContents()
        .catch(() => [] as string[]);

    const headerText = clean(
        await page
            .locator(COMMITMENT_HEADER_SELECTOR)
            .first()
            .textContent({ timeout: 2_000 })
            .catch(() => null),
    );

    const seen = new Set<string>();
    const guaranteeLabels: string[] = [];
    const pushLabel = (label: string): void => {
        const value = clean(label);
        if (value && !seen.has(value)) {
            seen.add(value);
            guaranteeLabels.push(value);
        }
    };

    if (headerText) {
        pushLabel(headerText);
    }
    for (const title of titles) {
        pushLabel(title);
    }

    const returnPolicySummary = guaranteeLabels.find((label) => /return|refund/i.test(label)) ?? null;

    return {
        conditionText: null,
        returnPolicySummary,
        guaranteeLabels,
    };
}

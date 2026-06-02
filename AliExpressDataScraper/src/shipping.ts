// Product shipping extraction — the delivery options from the AliExpress PDP service panel.
//
// The right-side action panel lists service rows in `[class*="shipping--item"]`. The shipping
// row renders a title (e.g. "Free shipping") plus a "Delivery: <date>" line; the other rows in
// the same container describe return/security policies (handled in `condition.ts`, not here).
//
// Class names are content-hashed per build, so we match on the stable `shipping--item` prefix
// and parse the title / delivery text out of each row's text ourselves.
import type { Page } from 'playwright';

import type { Shipping, ShippingOption } from './types.js';

const SHIPPING_ITEM_SELECTOR = '[class*="shipping--item"]';

// Pulls the free-text recency label after a "Delivery:" prefix (up to the line end).
const DELIVERY_RE = /Delivery:\s*([^\n]+)/i;

/** Collapse runs of whitespace within a single line while keeping newlines as row separators. */
function normalizeLines(text: string): string {
    return text
        .split('\n')
        .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
}

/**
 * Extract shipping options + the delivery-time label from the service panel.
 *
 * Walks every `shipping--item` row, keeps the one that describes shipping (its first line
 * mentions "shipping"), and records it as a {@link ShippingOption}: cost `0` when the row says
 * "free", otherwise `null` (the panel does not show a numeric shipping fee here). The
 * estimated-days fields stay null — the page only gives a free-text date ("Jun. 26"), which we
 * surface verbatim as `deliveryTimeText` rather than guessing day ranges.
 */
export async function extractShipping(page: Page): Promise<Shipping> {
    const rows = await page
        .locator(SHIPPING_ITEM_SELECTOR)
        .allTextContents()
        .catch(() => [] as string[]);

    const options: ShippingOption[] = [];
    let deliveryTimeText: string | null = null;

    for (const raw of rows) {
        const text = normalizeLines(raw);
        const firstLine = text.split('\n')[0] ?? '';

        if (/shipping/i.test(firstLine)) {
            options.push({
                name: firstLine,
                cost: /free/i.test(firstLine) ? 0 : null,
                currency: '',
                estimatedDeliveryMinDays: null,
                estimatedDeliveryMaxDays: null,
            });
        }

        if (!deliveryTimeText) {
            const match = DELIVERY_RE.exec(text);
            if (match) {
                deliveryTimeText = match[1].trim();
            }
        }
    }

    return { options, deliveryTimeText };
}

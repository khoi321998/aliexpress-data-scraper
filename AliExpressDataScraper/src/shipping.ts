// Product shipping extraction — the delivery-time label from the AliExpress PDP service panel.
//
// The right-side action panel lists service rows in `[class*="shipping--item"]`. The shipping
// row renders a title (e.g. "Free shipping") plus a "Delivery: <date>" line.
//
// Class names are content-hashed per build, so we match on the stable `shipping--item` prefix
// and parse the delivery text out of each row's text ourselves.
import type { Page } from 'playwright';

import type { Shipping } from './types.js';

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
 * Extract the delivery-time label from the service panel.
 *
 * Walks every `shipping--item` row and surfaces the first "Delivery: <date>" value verbatim as
 * `deliveryTimeText` — the page only gives a free-text date ("Jun. 26"), so we surface it as-is
 * rather than guessing day ranges. Best-effort: an absent panel yields a null label.
 */
export async function extractShipping(page: Page): Promise<Shipping> {
    // The service panel is rendered asynchronously — give the shipping rows a moment to mount
    // before reading, otherwise we capture an empty panel on slower loads.
    await page
        .locator(SHIPPING_ITEM_SELECTOR)
        .first()
        .waitFor({ state: 'attached', timeout: 4_000 })
        .catch(() => undefined);

    const rows = await page
        .locator(SHIPPING_ITEM_SELECTOR)
        .allTextContents()
        .catch(() => [] as string[]);

    let deliveryTimeText: string | null = null;

    for (const raw of rows) {
        const text = normalizeLines(raw);

        if (!deliveryTimeText) {
            const match = DELIVERY_RE.exec(text);
            if (match) {
                deliveryTimeText = match[1].trim();
            }
        }
    }

    return { deliveryTimeText };
}

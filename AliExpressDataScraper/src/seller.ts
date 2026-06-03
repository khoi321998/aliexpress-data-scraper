// Seller reference extraction — the store identity from the AliExpress PDP "Sold By" block.
//
// The right-side action panel links to the store in `[class*="store-detail--wrap"]`
// (`href="//www.aliexpress.com/store/<storeId>"`) and shows the shop name in
// `[class*="store-detail--storeName"]`. A separate "Message" link in
// `[class*="businessInfoWrap"]` carries the seller's internal id as a `sellerSeq` query param —
// this is the more stable seller identifier than the public store id, so we prefer it.
//
// Class names are content-hashed per build, so we match on stable `store-detail--` /
// `businessInfoWrap` prefixes rather than exact suffixed names.
import type { Page } from 'playwright';

import type { SellerRef } from './types.js';

export const STORE_LINK_SELECTOR = '[class*="store-detail--wrap"]';
const STORE_NAME_SELECTOR = '[class*="store-detail--storeName"]';
const MESSAGE_LINK_SELECTOR = '[class*="businessInfoWrap"] a[href*="sellerSeq"]';

/** Promote a protocol-relative URL (`//host/…`) to https; pass everything else through. */
export function ensureAbsolute(url: string): string {
    return url.startsWith('//') ? `https:${url}` : url;
}

/** Pull the numeric store id out of a `/store/<id>` URL, or null if absent. */
export function parseStoreId(url: string): string | null {
    const match = url.match(/\/store\/(\d+)/i);
    return match ? match[1] : null;
}

/** Pull the `sellerSeq` value out of a message-link URL, or null if absent. */
export function parseSellerSeq(url: string): string | null {
    const match = url.match(/[?&]sellerSeq=(\d+)/i);
    return match ? match[1] : null;
}

/** Collapse whitespace and trim; treats null/undefined as empty. */
function clean(value: string | null | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Extract a lightweight {@link SellerRef} (name + store URL + seller id) from the "Sold By" block.
 *
 * Prefers the `sellerSeq` from the message link for `platformSellerId` (the seller's internal id),
 * falling back to the public store id parsed from the store URL. Returns `null` only when none of
 * the three fields could be found, so a partial block still yields what it can.
 */
export async function extractSellerRef(page: Page): Promise<SellerRef | null> {
    const storeLink = page.locator(STORE_LINK_SELECTOR).first();
    const href = await storeLink.getAttribute('href').catch(() => null);
    const url = href ? ensureAbsolute(href.trim()) : null;

    const name =
        clean(
            await page
                .locator(STORE_NAME_SELECTOR)
                .first()
                .textContent({ timeout: 2_000 })
                .catch(() => null),
        ) || null;

    const messageHref = await page
        .locator(MESSAGE_LINK_SELECTOR)
        .first()
        .getAttribute('href')
        .catch(() => null);
    const platformSellerId = (messageHref && parseSellerSeq(messageHref)) || (url && parseStoreId(url)) || null;

    if (!name && !url && !platformSellerId) {
        return null;
    }

    return { platformSellerId, name, url };
}

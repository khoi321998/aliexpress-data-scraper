// Egress-IP diagnostics. Confirms WHICH IP each flow actually leaves from:
//   - the product crawler runs behind the US residential proxy  → expect a proxy IP
//   - the seller pipeline / local browser runs on the real IP    → expect the local/container IP
//
// We query the IP-echo endpoint through the page's OWN browser context request client
// (`page.context().request`), which inherits that context's proxy (or lack of one) and cookies — so
// the reported IP is exactly the route the browser uses, not the Node process's. Going through a page
// `fetch` instead would risk AliExpress's CSP blocking the cross-origin call; the context request
// client is not subject to page CSP.
import type { Log } from 'apify';
import type { Page } from 'playwright';

/**
 * Log the egress IP the given page's browser context is actually using. `label` tags the line
 * (e.g. "product" vs "seller") so the two flows are easy to tell apart in the logs.
 *
 * Best-effort: never throws — on any failure it logs a warning and moves on, so IP logging can never
 * break the scrape.
 */
export async function logEgressIp(page: Page, log: Log, label: string): Promise<void> {
    try {
        const res = await page.context().request.get('https://api.ipify.org?format=json', { timeout: 4_000 });
        const body = (await res.json()) as { ip?: string };
        log.info(`🌍 egress IP (${label})`, { ip: body.ip ?? null });
    } catch (error) {
        log.warning(`Could not determine egress IP (${label})`, {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

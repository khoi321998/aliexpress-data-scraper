// Browser stealth configuration.
//
// The heavy lifting is done by Crawlee's fingerprint injector (enabled via
// `browserPoolOptions.useFingerprints` in `main.ts`). It generates a *self-consistent*
// real-Chrome fingerprint — user-agent, navigator props, `navigator.webdriver` hidden,
// matching viewport, Accept-Language / Sec-CH-UA headers — and ties it to each Crawlee
// session. Hand-rolling these individually almost always produces contradictions that are
// easier to detect than no spoofing at all, so we lean on the injector and only add a thin
// belt-and-suspenders init script for the few globals it does not touch.
import type { FingerprintGeneratorOptions } from '@crawlee/browser-pool';
import type { Page } from 'playwright';

/**
 * Constrain generated fingerprints to a realistic US desktop-Chrome population.
 *
 * - `chrome` + `desktop`: matches our launch (real Chrome via `useChrome`) and avoids the
 *   mobile/Firefox mismatches that stick out on AliExpress's desktop PDP.
 * - `windows` / `macos`: the two dominant desktop OSes; skipping Linux avoids a rare-UA tell.
 * - `locales: ['en-US']`: keeps Accept-Language aligned with the US residential proxy and the
 *   `en-US` locale we request, so language, IP geo, and headers all tell the same story.
 */
export const FINGERPRINT_OPTIONS: FingerprintGeneratorOptions = {
    browsers: ['chrome'],
    operatingSystems: ['windows', 'macos'],
    devices: ['desktop'],
    locales: ['en-US'],
};

/**
 * Chrome launch arguments that reduce obvious automation tells.
 *
 * `--disable-blink-features=AutomationControlled` is the important one: it stops Chrome from
 * advertising the `AutomationControlled` blink feature that trivially flags a bot. The rest
 * are container hygiene (`--no-sandbox`, `--disable-dev-shm-usage`) and noise reduction so the
 * fingerprint stays clean and stable.
 */
export const CHROME_LAUNCH_ARGS: string[] = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-infobars',
    '--disable-notifications',
    '--lang=en-US',
];

/**
 * Optional extra init-script patches, applied per page before navigation.
 *
 * The fingerprint injector already hides `navigator.webdriver` and spoofs plugins/navigator,
 * so this is purely defensive cover for a couple of globals that headless Chrome can still
 * leak: a missing `window.chrome.runtime` object and the notifications `permissions.query`
 * quirk. Cheap, safe, and easy to drop if it ever conflicts with the injector.
 */
export async function applyStealthInitScript(page: Page): Promise<void> {
    await page.addInitScript(() => {
        // Real Chrome exposes `window.chrome`; headless sometimes does not.
        const w = window as unknown as { chrome?: Record<string, unknown> };
        if (!w.chrome) {
            w.chrome = { runtime: {} };
        }

        // Headless Chrome returns `denied` for notifications even when the prompt state is
        // `default`; align the two so the pair is internally consistent.
        const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
        if (originalQuery) {
            window.navigator.permissions.query = (parameters: PermissionDescriptor) =>
                parameters.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
                    : originalQuery(parameters);
        }
    });
}

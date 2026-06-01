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
import type { Log } from 'apify';
import type { Page } from 'playwright';

/**
 * Constrain generated fingerprints to a realistic US desktop-Chrome population.
 *
 * - `chrome` + `desktop`: matches our launch (real Chrome via `useChrome`) and avoids the
 *   mobile/Firefox mismatches that stick out on AliExpress's desktop PDP.
 * - `windows` / `macos`: the two dominant desktop OSes; skipping Linux avoids a rare-UA tell.
 * - `locales: ['en-US', 'en']`: mirrors what real US Chrome reports as `navigator.languages`
 *   (a two-entry array, not just `en-US`) and keeps Accept-Language aligned with the US
 *   residential proxy, so language, IP geo, and headers all tell the same story.
 */
export const FINGERPRINT_OPTIONS: FingerprintGeneratorOptions = {
    // `minVersion` excludes ancient/garbage entries from the fingerprint dataset (e.g. Chrome 91
    // with a Mac UA + Linux platform + "LarkUrl") that are self-contradictory and instantly flag
    // a bot. Pinning a recent floor keeps every generated identity coherent and modern.
    browsers: [{ name: 'chrome', minVersion: 120 }],
    operatingSystems: ['windows', 'macos'],
    devices: ['desktop'],
    locales: ['en-US', 'en'],
};

// Locale + timezone enforced per page via CDP (see `applyRegionOverrides`).
//
// The fingerprint injector spoofs the user-agent/navigator/locale but NOT the timezone, so
// without this the page leaks the *host machine's* timezone (e.g. Asia/Bangkok) — a glaring
// contradiction with an en-US identity on a US residential IP.
export const LOCALE = 'en-US';
export const TIMEZONE_ID = 'America/New_York';

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
 * Force the browser timezone + locale to the US region via the Chrome DevTools Protocol.
 *
 * CDP overrides are native: `Date`/`Intl` report the overridden timezone exactly as a real
 * machine in that region would, with no JS patching to fingerprint. We use CDP (not Playwright
 * context options) because the fingerprint injector creates the context itself, so context-level
 * options passed through Crawlee hooks are ignored once `useFingerprints` is on.
 */
export async function applyRegionOverrides(page: Page): Promise<void> {
    try {
        const client = await page.context().newCDPSession(page);
        await client.send('Emulation.setTimezoneOverride', { timezoneId: TIMEZONE_ID });
        await client.send('Emulation.setLocaleOverride', { locale: LOCALE });
    } catch {
        // Best-effort: a failed override must never block the crawl.
    }
}

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
            window.navigator.permissions.query = async (parameters: PermissionDescriptor) =>
                parameters.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
                    : originalQuery(parameters);
        }
    });
}

/** The effective browser identity as the *page itself* reports it. */
export interface BrowserIdentity {
    userAgent: string;
    platform: string;
    languages: string[];
    vendor: string;
    hardwareConcurrency: number;
    deviceMemory: number | null;
    screen: { width: number; height: number };
    viewport: { width: number; height: number };
    timezone: string;
    /** Should be `false` — confirms the injector hid the automation flag. */
    webdriver: boolean;
}

/**
 * Read the fingerprint that actually landed in the page, straight from `navigator`/`screen`.
 *
 * We log what the page reports (not what we asked the generator for) because that is exactly
 * what AliExpress sees — the ground truth for confirming the injector applied a clean, US
 * desktop-Chrome identity and that `navigator.webdriver` is hidden.
 */
export async function readBrowserIdentity(page: Page): Promise<BrowserIdentity | null> {
    return page
        .evaluate(() => {
            const nav = navigator as Navigator & { deviceMemory?: number };
            return {
                userAgent: nav.userAgent,
                platform: nav.platform,
                languages: [...nav.languages],
                vendor: nav.vendor,
                hardwareConcurrency: nav.hardwareConcurrency,
                deviceMemory: nav.deviceMemory ?? null,
                screen: { width: window.screen.width, height: window.screen.height },
                viewport: { width: window.innerWidth, height: window.innerHeight },
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                webdriver: Boolean(nav.webdriver),
            };
        })
        .catch(() => null);
}

/**
 * Read the public IP the page is egressing from, via the browser's own request context
 * (so it goes through the same residential proxy as the session). This is the only way to
 * *prove* a rotation actually changed the IP — the IP is otherwise invisible to page JS.
 */
export async function readPublicIp(page: Page): Promise<string | null> {
    try {
        const res = await page.request.get('https://api.ipify.org?format=json', { timeout: 10_000 });
        if (!res.ok()) {
            return null;
        }
        const data = (await res.json()) as { ip?: string };
        return data.ip ?? null;
    } catch {
        return null;
    }
}

/** Best-effort log of the per-session proxy IP + fingerprint; never throws. */
export async function logBrowserIdentity(page: Page, log: Log, sessionId?: string): Promise<void> {
    const [identity, proxyIp] = await Promise.all([readBrowserIdentity(page), readPublicIp(page)]);
    if (identity) {
        log.info('Session identity in use (proxy IP + fingerprint as the page reports it).', {
            sessionId,
            proxyIp,
            ...identity,
        });
    }
}

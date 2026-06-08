// Page-level captcha handling for the independent seller pipeline.
//
// Unlike the product crawler — which only DETECTS a challenge and rotates to a fresh
// session (see `detection.ts` / `classifyPage`) — the seller pipeline runs on a real local
// IP with no fingerprint, so when AliExpress serves a punish / reCAPTCHA page we SOLVE it
// (via 2captcha) instead of rotating. These helpers find the sitekey, push it to the solver,
// inject the returned token and confirm the widget cleared.
import type { Log } from 'apify';
import type { Page } from 'playwright';

import { solveRecaptchaV2 } from './captcha.js';

// DOM selectors for an actual visible verification widget (AliExpress slider, baxia punish
// dialog, or an embedded Google reCAPTCHA).
// NOTE: tokens like "punish" / "_____tmd_____" appear in anti-bot scripts on EVERY normal
// AliExpress page, so we must NOT treat their mere presence in the DOM as a captcha — only a
// VISIBLE widget or a punish URL counts.
const CAPTCHA_SELECTORS = [
    '#nc_1_wrapper',
    '.nc-container',
    '#baxia-dialog',
    '#baxia-punish',
    '.baxia-dialog',
    '#nocaptcha',
    '.J_MIDDLEWARE_FRAME_WIDGET',
    'iframe[src*="recaptcha"]',
    'iframe[title*="recaptcha" i]',
];

// Visible text that only appears on a punish / verification page.
const CAPTCHA_TEXTS = ['check if you are a robot', "i'm not a robot", 'slide to verify', 'verify to continue'];

/**
 * Detect whether the current page is a captcha / punish page.
 * Returns the matching signal (for logging) or null if the page looks clean.
 */
export async function detectBlock(page: Page): Promise<string | null> {
    const lowerUrl = page.url().toLowerCase();
    for (const marker of ['punish', '_____tmd_____', 'x5sec']) {
        if (lowerUrl.includes(marker)) return `url contains "${marker}"`;
    }

    return page.evaluate(
        ({ sels, texts }) => {
            // Only count a widget as blocking if it is actually VISIBLE — anti-bot dialogs
            // often leave a hidden container in the DOM after they clear.
            const isVisible = (el: Element | null): boolean => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return false;
                const style = getComputedStyle(el);
                return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
            };
            const sel = sels.find((s) => isVisible(document.querySelector(s)));
            if (sel) return `visible element "${sel}"`;
            const body = (document.body?.innerText ?? '').toLowerCase();
            const txt = texts.find((t) => body.includes(t));
            return txt ? `text "${txt}"` : null;
        },
        { sels: CAPTCHA_SELECTORS, texts: CAPTCHA_TEXTS },
    );
}

/**
 * Find the Google reCAPTCHA site key. The widget may live in a nested iframe, so we check
 * every frame's URL (`.../api2/anchor?...&k=<sitekey>`) and, as a fallback, any `[data-sitekey]`
 * element in any frame.
 */
async function findRecaptchaSitekey(page: Page): Promise<string | null> {
    for (const frame of page.frames()) {
        const m = frame.url().match(/[?&]k=([^&]+)/);
        if (frame.url().includes('recaptcha') && m) return decodeURIComponent(m[1]);
    }
    for (const frame of page.frames()) {
        try {
            const key = await frame.evaluate(() => document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') ?? null);
            if (key) return key;
        } catch {
            // frame may be detached / cross-origin — ignore and keep looking
        }
    }
    return null;
}

/**
 * Inject the solved token into every frame that hosts a `g-recaptcha-response` field and try
 * to fire the reCAPTCHA callback registered in `___grecaptcha_cfg`.
 */
async function injectRecaptchaToken(page: Page, token: string): Promise<number> {
    let totalInjected = 0;
    for (const frame of page.frames()) {
        try {
            const count = await frame.evaluate((t) => {
                const fields = document.querySelectorAll<HTMLTextAreaElement>(
                    'textarea#g-recaptcha-response, textarea[name="g-recaptcha-response"]',
                );
                fields.forEach((el) => {
                    el.value = t;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                });

                // Try to invoke the page's reCAPTCHA success callback directly.
                const cfg = (window as unknown as { ___grecaptcha_cfg?: { clients?: Record<string, unknown> } }).___grecaptcha_cfg;
                if (!cfg?.clients) return fields.length;
                for (const client of Object.values(cfg.clients)) {
                    const stack: unknown[] = [client];
                    while (stack.length) {
                        const node = stack.pop();
                        if (!node || typeof node !== 'object') continue;
                        for (const v of Object.values(node as Record<string, unknown>)) {
                            if (v && typeof v === 'object') {
                                const callback = (v as { callback?: unknown }).callback;
                                if (typeof callback === 'function') {
                                    try {
                                        (callback as (arg: string) => void)(t);
                                    } catch {
                                        /* keep trying other callbacks */
                                    }
                                }
                                stack.push(v);
                            }
                        }
                    }
                }
                return fields.length;
            }, token);
            totalInjected += count ?? 0;
        } catch {
            // detached / cross-origin frame — skip
        }
    }
    return totalInjected;
}

/**
 * Attempt to solve a reCAPTCHA-based punish page via 2captcha.
 * Returns true if the page is no longer blocked afterwards.
 */
export async function trySolveCaptcha(page: Page, pageUrl: string, apiKey: string | undefined, log: Log): Promise<boolean> {
    if (!apiKey) {
        log.warning('Captcha detected but no 2captcha API key configured — cannot solve');
        return false;
    }

    log.info('🔍 [2/5] Looking for the reCAPTCHA sitekey across all frames...');
    // The reCAPTCHA lives in a nested iframe (the `#baxia-dialog-content` punish frame loads it a
    // beat after the dialog becomes visible), so poll for up to ~12s instead of checking once.
    let sitekey: string | null = null;
    for (let i = 0; i < 12; i++) {
        sitekey = await findRecaptchaSitekey(page);
        if (sitekey) break;
        await page.waitForTimeout(1_000);
    }
    if (!sitekey) {
        log.warning('❌ No reCAPTCHA sitekey found after waiting — captcha may be a slider/other type.');
        return false;
    }
    log.info(`🔑 [2/5] Found reCAPTCHA sitekey: ${sitekey}`);

    let token: string;
    const startedAt = Date.now();
    try {
        log.info('📤 [3/5] Sending captcha to 2captcha and waiting for a human/AI solver...');
        token = await solveRecaptchaV2({ apiKey, websiteKey: sitekey, websiteURL: pageUrl });
    } catch (err) {
        log.warning(`❌ 2captcha failed: ${(err as Error).message}`);
        return false;
    }
    log.info(`🎟️  [4/5] Got token from 2captcha in ${Math.round((Date.now() - startedAt) / 1000)}s (length=${token.length})`);

    const injected = await injectRecaptchaToken(page, token);
    log.info(`💉 [5/5] Injected token into ${injected} g-recaptcha-response field(s); waiting for the punish page to clear...`);

    // Poll for the widget to disappear right away — do NOT wait for networkidle here: the punish
    // page never goes idle (reCAPTCHA + trackers), which would add a needless ~30s delay. The
    // baxia dialog closes within ~1-2s once the token is accepted.
    for (let i = 0; i < 20; i++) {
        const signal = await detectBlock(page);
        if (!signal) {
            log.info('✅ Captcha cleared! Page is no longer blocked 🎉');
            return true;
        }
        await page.waitForTimeout(1_000);
    }

    log.warning('⚠️  Still blocked ~20s after injecting the token. Submit step may need adjustment — check the saved HTML/screenshot.');
    return false;
}

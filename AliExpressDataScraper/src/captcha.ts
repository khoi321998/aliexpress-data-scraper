// Minimal 2captcha client (https://2captcha.com/2captcha-api) for Google reCAPTCHA v2.
//
// Uses the classic in.php / res.php endpoints over global fetch (Node 18+) — no extra dependency.
//
// Flow:
//   1. POST in.php  with method=userrecaptcha, googlekey=<sitekey>, pageurl=<url> -> captcha id
//   2. poll res.php with action=get&id=<id> until the token is ready ("CAPCHA_NOT_READY" while waiting)
import { setTimeout as sleep } from 'node:timers/promises';

import { log } from 'apify';

interface SolveRecaptchaV2Options {
    apiKey: string;
    /** The reCAPTCHA site key (data-sitekey / `k` param of the anchor iframe). */
    websiteKey: string;
    /** The full URL of the page that shows the captcha. */
    websiteURL: string;
    /** True for reCAPTCHA v2 "invisible". Default false (checkbox). */
    invisible?: boolean;
    /** Poll interval in ms (2captcha recommends ~5s). */
    pollIntervalMs?: number;
    /** Max time to wait for a solution before giving up. */
    timeoutMs?: number;
}

interface TwoCaptchaResponse {
    status: 0 | 1;
    request: string;
}

const IN_URL = 'https://2captcha.com/in.php';
const RES_URL = 'https://2captcha.com/res.php';

/**
 * Parse a 2captcha response defensively.
 *
 * 2captcha replies in TWO formats and does not always honor `json=1`: the JSON form
 * (`{"status":0|1,"request":"..."}`) and the classic plaintext form (`OK|<token>`,
 * `CAPCHA_NOT_READY`, `ERROR_*`). Calling `r.json()` blindly throws on the plaintext form
 * ("Unexpected non-whitespace character after JSON"), so we read the body as text and handle
 * both shapes here.
 */
function parseTwoCaptcha(raw: string): TwoCaptchaResponse {
    const text = raw.trim();
    try {
        const json = JSON.parse(text) as TwoCaptchaResponse;
        if (json && typeof json.status === 'number') return json;
    } catch {
        // Not JSON — fall through to the plaintext formats below.
    }
    if (text.startsWith('OK|')) return { status: 1, request: text.slice(3) };
    if (text === 'CAPCHA_NOT_READY') return { status: 0, request: 'CAPCHA_NOT_READY' };
    // Anything else (ERROR_*, an unexpected body, …) is treated as a non-success status; the
    // caller logs `request` so the raw reason is visible.
    return { status: 0, request: text };
}

/** Fetch a 2captcha endpoint and parse its body (JSON or plaintext) into a typed response. */
async function fetchTwoCaptcha(url: string, init?: RequestInit): Promise<TwoCaptchaResponse> {
    const res = await fetch(url, init);
    const raw = await res.text();
    return parseTwoCaptcha(raw);
}

/**
 * Submit a reCAPTCHA v2 challenge to 2captcha and poll until the solver returns the
 * `g-recaptcha-response` token. Throws if 2captcha rejects the task or times out.
 */
export async function solveRecaptchaV2({
    apiKey,
    websiteKey,
    websiteURL,
    invisible = false,
    pollIntervalMs = 5_000,
    timeoutMs = 300_000,
}: SolveRecaptchaV2Options): Promise<string> {
    // --- 1. Submit the captcha task ------------------------------------------------
    const submitParams = new URLSearchParams({
        key: apiKey,
        method: 'userrecaptcha',
        googlekey: websiteKey,
        pageurl: websiteURL,
        json: '1',
    });
    if (invisible) submitParams.set('invisible', '1');

    const submit = await fetchTwoCaptcha(IN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: submitParams.toString(),
    });

    if (submit.status !== 1) {
        throw new Error(`2captcha rejected the task: ${submit.request}`);
    }
    const captchaId = submit.request;
    log.info(`📨 2captcha accepted the task (id=${captchaId}); polling for the solution...`);

    // --- 2. Poll for the solution --------------------------------------------------
    const deadline = Date.now() + timeoutMs;
    // 2captcha asks clients to wait ~15-20s before the first poll.
    await sleep(Math.min(15_000, timeoutMs));

    let attempt = 0;
    while (Date.now() < deadline) {
        attempt += 1;
        const resParams = new URLSearchParams({ key: apiKey, action: 'get', id: captchaId, json: '1' });
        const res = await fetchTwoCaptcha(`${RES_URL}?${resParams.toString()}`);

        if (res.status === 1) {
            log.info(`✅ 2captcha solved the captcha (id=${captchaId}) after ${attempt} poll(s)`);
            return res.request; // the g-recaptcha-response token
        }
        if (res.request !== 'CAPCHA_NOT_READY') {
            throw new Error(`2captcha poll error: ${res.request}`);
        }
        log.info(`⏳ 2captcha still working (poll #${attempt}, waited ~${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s)...`);
        await sleep(pollIntervalMs);
    }

    throw new Error(`2captcha timed out after ${timeoutMs}ms (captchaId ${captchaId})`);
}

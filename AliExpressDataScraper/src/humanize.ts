// Human-behavior simulation.
//
// Anti-bot systems score *how* a page is used, not just the fingerprint: instant, perfectly
// linear, zero-dwell interactions read as automation. These helpers add small randomized
// delays, a few stepped scrolls, and some mouse movement so the session looks like a person
// skimming a product page. A pleasant side effect is that scrolling triggers AliExpress's
// lazy-loaded content (images, reviews) that would otherwise never render.
import type { Page } from 'playwright';

import type { ScraperConfig } from './config.js';

/** Inclusive random integer in `[min, max]`. */
function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Pause for a random duration in `[minMs, maxMs]` to break up robotic timing. */
export async function randomDelay(page: Page, minMs: number, maxMs: number): Promise<void> {
    await page.waitForTimeout(randomInt(minMs, maxMs));
}

/**
 * Move the mouse to a few random points with brief pauses.
 *
 * Not a perfect Bézier path — just enough non-zero, non-instant pointer activity to avoid the
 * "no mouse events ever fired" tell. Kept cheap so it never dominates the request budget.
 */
export async function randomMouseMove(page: Page): Promise<void> {
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    const moves = randomInt(2, 4);
    for (let i = 0; i < moves; i += 1) {
        const x = randomInt(0, viewport.width);
        const y = randomInt(0, viewport.height);
        // `steps` makes Playwright emit intermediate mousemove events instead of one jump.
        await page.mouse.move(x, y, { steps: randomInt(5, 15) });
        await page.waitForTimeout(randomInt(120, 400));
    }
}

/**
 * Scroll the page down in a few human-sized increments, then drift back up a little.
 *
 * Each step is a partial-viewport scroll with a pause, mimicking reading cadence and giving
 * lazy content time to load.
 */
export async function humanScroll(page: Page): Promise<void> {
    const viewportHeight = page.viewportSize()?.height ?? 800;
    const steps = randomInt(3, 6);
    for (let i = 0; i < steps; i += 1) {
        const delta = randomInt(Math.round(viewportHeight * 0.4), Math.round(viewportHeight * 0.9));
        await page.mouse.wheel(0, delta).catch(() => undefined);
        await page.waitForTimeout(randomInt(300, 900));
    }
    // A small scroll back up, the way people re-check something they passed.
    await page.mouse.wheel(0, -randomInt(100, 400)).catch(() => undefined);
    await page.waitForTimeout(randomInt(200, 600));
}

/**
 * Run a realistic post-load browsing flow: settle delay → mouse movement → scroll.
 *
 * Called after navigation but before extraction. Best-effort: any individual gesture failing
 * (e.g. page closed) must never break the scrape, so failures are swallowed.
 */
export async function simulateBrowsing(page: Page, config: ScraperConfig): Promise<void> {
    const { minActionDelayMs, maxActionDelayMs } = config.humanize;
    try {
        await randomDelay(page, minActionDelayMs, maxActionDelayMs);
        await randomMouseMove(page);
        await humanScroll(page);
        await randomDelay(page, minActionDelayMs, maxActionDelayMs);
    } catch {
        // Humanization is opportunistic; never let it fail the request.
    }
}

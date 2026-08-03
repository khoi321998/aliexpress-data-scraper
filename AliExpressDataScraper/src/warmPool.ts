// The warm-context pool that backs the standby server.
//
// Keeps `size` warm contexts alive in RAM (each = one sticky residential IP + fingerprint + warm
// cookies/token). A request LEASES the freest, least-used context, runs the extraction on it, then
// RELEASES it. Contexts are recycled proactively (past `maxUsageCount` uses, or older than the
// sticky-IP TTL) and reactively (when a request was blocked) — recycling = retire the burned
// browser and bootstrap a replacement on a fresh IP in the background, so the pool self-heals.
import type { Log } from 'apify';
import type { ProxyConfiguration } from 'apify';

import type { ScraperConfig } from './config.js';
import type { StandbyBrowserPool, WarmContext } from './warmContext.js';
import { bootstrapWarmContext, retireWarmContext } from './warmContext.js';

export interface WarmPoolOptions {
    /** Target number of warm contexts (== max simultaneous in-flight calls). */
    size: number;
    /** Recycle a context after this many leased requests (mirrors the batch session `maxUsageCount`). */
    maxUsageCount: number;
    /** Recycle a context older than this many ms (residential sticky-IP TTL guard). */
    maxAgeMs: number;
    /** How long `lease()` waits for a free context before giving up. */
    leaseTimeoutMs: number;
}

/** A queued lease request, resolved when a context frees up. */
interface Waiter {
    resolve: (wc: WarmContext) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

export class WarmPool {
    private contexts: WarmContext[] = [];
    private readonly waiters: Waiter[] = [];
    /** Count of in-flight background bootstraps so we never over-refill past `size`. */
    private refilling = 0;
    private closed = false;

    constructor(
        private readonly pool: StandbyBrowserPool,
        private readonly proxyConfiguration: ProxyConfiguration,
        private readonly config: ScraperConfig,
        private readonly log: Log,
        private readonly opts: WarmPoolOptions,
    ) {}

    /** Bootstrap the initial pool. Tolerates partial failures — the pool can run degraded. */
    async start(): Promise<void> {
        const results = await Promise.all(Array.from({ length: this.opts.size }, async () => bootstrapWarmContext(this.pool, this.proxyConfiguration, this.config, this.log)));
        this.contexts = results.filter((wc): wc is WarmContext => wc !== null);
        this.log.info(`WarmPool ready (${this.contexts.length}/${this.opts.size}).`);
        // If some bootstraps failed, schedule background refills up to the target.
        this.topUp();
    }

    /** Number of currently-ready (bootstrapped) contexts. Used by the readiness probe. */
    readyCount(): number {
        return this.contexts.length;
    }

    /**
     * Lease the free context with the lowest `useCount`. If all are busy, queue until one is released
     * or `leaseTimeoutMs` elapses. The returned context is marked busy — the caller MUST `release` it.
     */
    async lease(): Promise<WarmContext> {
        if (this.closed) {
            return Promise.reject(new Error('WarmPool is closed.'));
        }
        const free = this.contexts.filter((wc) => !wc.busy).sort((a, b) => a.useCount - b.useCount)[0];
        if (free) {
            free.busy = true;
            return Promise.resolve(free);
        }
        return new Promise<WarmContext>((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = this.waiters.findIndex((w) => w.timer === timer);
                if (idx !== -1) this.waiters.splice(idx, 1);
                reject(new Error('Timed out waiting for a free warm context.'));
            }, this.opts.leaseTimeoutMs);
            this.waiters.push({ resolve, reject, timer });
        });
    }

    /**
     * Release a leased context. Increments its use count; if it is now over-used or aged out it is
     * recycled (retired + background-replaced) instead of being handed to the next waiter.
     */
    release(wc: WarmContext): void {
        wc.useCount += 1;
        wc.busy = false;
        const aged = Date.now() - wc.createdAt > this.opts.maxAgeMs;
        const overUsed = wc.useCount >= this.opts.maxUsageCount;
        if (this.closed) {
            return;
        }
        if (aged || overUsed) {
            this.log.info('Recycling warm context.', { sessionId: wc.sessionId, useCount: wc.useCount, aged });
            void this.recycle(wc);
            return;
        }
        this.handToWaiterOrIdle(wc);
    }

    /**
     * Rotate a context that got blocked mid-request: retire it and background-bootstrap a replacement.
     * The caller leases a different context to retry on.
     */
    async rotate(wc: WarmContext): Promise<void> {
        this.log.warning('Rotating blocked warm context.', { sessionId: wc.sessionId, useCount: wc.useCount });
        await this.recycle(wc);
    }

    /** Drop a context from the pool, retire its browser, and schedule a background refill. */
    private async recycle(wc: WarmContext): Promise<void> {
        this.contexts = this.contexts.filter((c) => c !== wc);
        await retireWarmContext(this.pool, wc, this.log);
        this.topUp();
    }

    /** Give a still-healthy released context to the next waiter, or leave it idle in the pool. */
    private handToWaiterOrIdle(wc: WarmContext): void {
        const waiter = this.waiters.shift();
        if (waiter) {
            clearTimeout(waiter.timer);
            wc.busy = true;
            waiter.resolve(wc);
        }
    }

    /** Background-bootstrap contexts until the pool reaches `size` (counting in-flight refills). */
    private topUp(): void {
        if (this.closed) {
            return;
        }
        const deficit = this.opts.size - this.contexts.length - this.refilling;
        for (let i = 0; i < deficit; i += 1) {
            this.refilling += 1;
            void (async () => {
                const wc = await bootstrapWarmContext(this.pool, this.proxyConfiguration, this.config, this.log);
                this.refilling -= 1;
                if (this.closed) {
                    if (wc) await retireWarmContext(this.pool, wc, this.log);
                    return;
                }
                if (wc) {
                    this.contexts.push(wc);
                    this.handToWaiterOrIdle(wc);
                } else {
                    // Bootstrap failed (burned IP) — try again so the pool eventually recovers.
                    this.topUp();
                }
            })();
        }
    }

    /** On abort: stop accepting work, reject queued waiters, and close every browser. */
    async drainAndClose(): Promise<void> {
        this.closed = true;
        for (const w of this.waiters.splice(0)) {
            clearTimeout(w.timer);
            w.reject(new Error('WarmPool draining.'));
        }
        const all = this.contexts.splice(0);
        await Promise.all(all.map(async (wc) => retireWarmContext(this.pool, wc, this.log)));
        await this.pool.destroy().catch(() => undefined);
    }
}

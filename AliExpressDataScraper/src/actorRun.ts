// The single source for the Apify run identity. Nothing else in the codebase should reach for
// `Actor.getEnv()` to answer "which run is this?" — one accessor keeps the local-run fallback
// (`null`) in one place instead of every caller inventing its own.
import { Actor } from 'apify';

/**
 * The id of the Apify run this process belongs to, or `null` when running outside the platform
 * (`apify run` locally, tests). Read live on every call rather than captured at module load: the
 * environment is only populated once `Actor.init()` has run, so a module-level constant would
 * freeze whatever was — or was not — set at import time.
 */
export function currentActorRunId(): string | null {
    return Actor.getEnv().actorRunId ?? null;
}

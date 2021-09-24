import { CSpellLintResultCache } from './CSpellLintResultCache';

/**
 * Dummy cache implementation that should be usd if caching option is disabled.
 */
export class DummyCache implements CSpellLintResultCache {
    getCachedLintResults() {
        return Promise.resolve(undefined);
    }
    setCachedLintResults() {}
    reconcile() {}
}

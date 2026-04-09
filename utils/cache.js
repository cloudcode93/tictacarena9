// ============================================================
// TicTacArena — High-Performance In-Memory Cache
// Supports: TTL, stale-while-revalidate, key patterns, stats
// ============================================================

const store = new Map();
let hits = 0, misses = 0;

const pendingRequests = new Map();

/**
 * Get cached value or compute and cache it.
 * Uses stale-while-revalidate: returns stale data instantly while
 * refreshing in the background (prevents cache stampede).
 * @param {string} key - Cache key
 * @param {number} ttlSeconds - Time-to-live in seconds
 * @param {Function} fetchFn - Async function to compute value if cache miss
 * @returns {Promise<any>}
 */
async function getOrSet(key, ttlSeconds, fetchFn) {
  const cached = store.get(key);
  const now = Date.now();

  if (cached) {
    if (now < cached.expiresAt) {
      hits++;
      return cached.value;
    }

    // Stale-while-revalidate: return stale data, refresh in background
    if (now < cached.expiresAt + (ttlSeconds * 500)) { // grace period = 50% of TTL
      hits++;
      if (!cached.refreshing && !pendingRequests.has(key)) {
        cached.refreshing = true;
        const fetchPromise = fetchFn().then(value => {
          store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000, refreshing: false });
        }).catch(() => { cached.refreshing = false; }).finally(() => pendingRequests.delete(key));
        pendingRequests.set(key, fetchPromise);
      }
      return cached.value;
    }
  }

  // Pure Cache Miss - Coalesce using pendingRequests Map to prevent stampede
  if (pendingRequests.has(key)) {
    hits++; // Treat coalesced waits as cache hits for stats
    await pendingRequests.get(key);
    return store.get(key)?.value;
  }

  misses++;
  const fetchPromise = fetchFn().then(value => {
    store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000, refreshing: false });
    return value;
  }).finally(() => {
    pendingRequests.delete(key);
  });

  pendingRequests.set(key, fetchPromise);
  return await fetchPromise;
}

/**
 * Invalidate a specific cache key.
 */
function invalidate(key) {
  store.delete(key);
}

/**
 * Invalidate all keys matching a prefix.
 * Example: invalidatePattern('leaderboard_') clears all leaderboard caches
 */
function invalidatePattern(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/**
 * Clear all cache entries.
 */
function clear() {
  store.clear();
  hits = 0;
  misses = 0;
}

/**
 * Get cache statistics.
 */
function stats() {
  return { size: store.size, hits, misses, hitRate: hits + misses > 0 ? (hits / (hits + misses) * 100).toFixed(1) + '%' : 'N/A' };
}

// Auto-cleanup expired entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store.entries()) {
    if (now > val.expiresAt + 120000) store.delete(key); // expired + 2min grace
  }
}, 2 * 60 * 1000);

module.exports = { getOrSet, invalidate, invalidatePattern, clear, stats };

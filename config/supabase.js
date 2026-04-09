const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

// Public client (uses anon key, respects RLS)
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Service role client (bypasses RLS — use for server-side operations only)
const supabaseAdmin = supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : supabase;

// === Authenticated Client Pool (LRU) ===
// Reuse clients per token instead of creating a new one every request
const CLIENT_POOL_MAX = 100;
const clientPool = new Map();

function getSupabaseClient(accessToken) {
  if (!accessToken) return supabase;

  // Check pool
  const existing = clientPool.get(accessToken);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.client;
  }

  // Create new client
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  });

  clientPool.set(accessToken, { client, lastUsed: Date.now() });

  // Evict oldest if pool too large
  if (clientPool.size > CLIENT_POOL_MAX) {
    let oldestKey = null, oldestTime = Infinity;
    for (const [key, val] of clientPool.entries()) {
      if (val.lastUsed < oldestTime) {
        oldestTime = val.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) clientPool.delete(oldestKey);
  }

  return client;
}

// Clean expired tokens from pool every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000; // 10 min idle = evict
  for (const [key, val] of clientPool.entries()) {
    if (val.lastUsed < cutoff) clientPool.delete(key);
  }
}, 5 * 60 * 1000);

module.exports = { supabase, supabaseAdmin, getSupabaseClient, supabaseUrl, supabaseAnonKey };

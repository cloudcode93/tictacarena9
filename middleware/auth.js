const { supabase } = require('../config/supabase');

// === Token Cache — avoids round-trip to Supabase on every request ===
const tokenCache = new Map();
const TOKEN_CACHE_TTL = 60 * 1000; // 60 seconds
const TOKEN_CACHE_MAX = 500;

function getCachedUser(token) {
  const cached = tokenCache.get(token);
  if (cached && Date.now() < cached.expiresAt) return cached.user;
  tokenCache.delete(token);
  return null;
}

function setCachedUser(token, user) {
  tokenCache.set(token, { user, expiresAt: Date.now() + TOKEN_CACHE_TTL });
  // Evict oldest if too large
  if (tokenCache.size > TOKEN_CACHE_MAX) {
    const firstKey = tokenCache.keys().next().value;
    tokenCache.delete(firstKey);
  }
}

// Promise map to prevent Cache Stampedes
const pendingTokenRequests = new Map();

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.split(' ')[1];

  // Check cache first (avoids network call to Supabase)
  const cachedUser = getCachedUser(token);
  if (cachedUser) {
    req.user = cachedUser;
    req.token = token;
    return next();
  }

  // Prevent Cache Stampede: if request for this token is already in flight, wait for it
  if (pendingTokenRequests.has(token)) {
    try {
      const user = await pendingTokenRequests.get(token);
      req.user = user;
      req.token = token;
      return next();
    } catch (err) {
      return res.status(401).json({ error: 'Authentication failed' });
    }
  }

  // Define the remote request promise and store it
  const fetchPromise = supabase.auth.getUser(token).then(({ data: { user }, error }) => {
    if (error || !user) throw new Error('Invalid token');
    setCachedUser(token, user);
    return user;
  }).finally(() => {
    pendingTokenRequests.delete(token); // Cleanup after resolve/reject
  });

  pendingTokenRequests.set(token, fetchPromise);

  try {
    const user = await fetchPromise;
    req.user = user;
    req.token = token;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// Admin role cache (separate, longer TTL)
const adminCache = new Map();
const ADMIN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function adminMiddleware(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Check admin cache
  const cached = adminCache.get(req.user.id);
  if (cached && Date.now() < cached.expiresAt) {
    if (cached.isAdmin) return next();
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', req.user.id)
      .single();

    const isAdmin = profile?.role === 'admin';
    adminCache.set(req.user.id, { isAdmin, expiresAt: Date.now() + ADMIN_CACHE_TTL });

    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    console.error('Admin middleware error:', err.message);
    return res.status(500).json({ error: 'Failed to verify admin status' });
  }
}

module.exports = { authMiddleware, adminMiddleware };

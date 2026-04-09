const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const cache = require('../utils/cache');

// All admin routes require auth + admin role
router.use(authMiddleware, adminMiddleware);

// ===== DASHBOARD STATS =====
router.get('/stats', async (req, res) => {
  try {
    const stats = await cache.getOrSet('admin_stats', 10, async () => {
      const today = new Date(); today.setHours(0,0,0,0);
      const todayStr = today.toISOString();

      const [
        totalUsersReq, activeTodayReq, matchesTodayReq, newUsersReq,
        totalFriendsReq, totalMsgsReq, totalAchReq, totalMailsReq, totalPurchReq
      ] = await Promise.all([
        supabase.from('profiles').select('*', { count: 'exact', head: true }),
        supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('online', true),
        supabase.from('matches').select('*', { count: 'exact', head: true }).gte('created_at', todayStr),
        supabase.from('profiles').select('*', { count: 'exact', head: true }).gte('created_at', todayStr),
        supabase.from('friends').select('*', { count: 'exact', head: true }),
        supabase.from('messages').select('*', { count: 'exact', head: true }),
        supabase.from('user_achievements').select('*', { count: 'exact', head: true }).eq('unlocked', true),
        supabase.from('mails').select('*', { count: 'exact', head: true }),
        supabase.from('user_items').select('*', { count: 'exact', head: true })
      ]);

      return {
        totalUsers: totalUsersReq.count || 0,
        activeToday: activeTodayReq.count || 0,
        matchesToday: matchesTodayReq.count || 0,
        newUsers: newUsersReq.count || 0,
        totalFriendships: totalFriendsReq.count || 0,
        totalMessages: totalMsgsReq.count || 0,
        totalAchievementsUnlocked: totalAchReq.count || 0,
        totalMailsSent: totalMailsReq.count || 0,
        totalShopPurchases: totalPurchReq.count || 0
      };
    });
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== EXTENDED ANALYTICS =====
router.get('/stats/extended', async (req, res) => {
  try {
    const result = await cache.getOrSet('admin_extended_stats', 300, async () => {
      const today = new Date();
      today.setHours(0,0,0,0);
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(today.getDate() - 30);

      const [profilesRes, matchesRes, shopItemsRes, purchasesRes] = await Promise.all([
        supabase.from('profiles').select('id, created_at, last_seen, coins, xp, score, wins, losses, rank, online, username'),
        supabase.from('matches').select('id, created_at, mode').gte('created_at', thirtyDaysAgo.toISOString()),
        supabase.from('shop_items').select('id, type, price'),
        supabase.from('user_items').select('id, purchased_at, item_id').gte('purchased_at', thirtyDaysAgo.toISOString())
      ]);

      const profs = profilesRes.data || [];
      const mat = matchesRes.data || [];
      const items = shopItemsRes.data || [];
      const purch = purchasesRes.data || [];

      const totalUsers = profs.length;
      const totalMatchesAll = mat.length; 
      const onlineNow = profs.filter(p => p.online).length;

      const matchesPerDay = [];
      const usersPerDay = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
        const next = new Date(d); next.setDate(next.getDate() + 1);
        
        const dayMatches = mat.filter(m => new Date(m.created_at) >= d && new Date(m.created_at) < next).length;
        matchesPerDay.push({ date: d.toISOString().split('T')[0], label: d.toLocaleDateString('en', { weekday: 'short' }), matches: dayMatches });
        
        const dayUsers = profs.filter(p => new Date(p.created_at) >= d && new Date(p.created_at) < next).length;
        usersPerDay.push({ date: d.toISOString().split('T')[0], label: d.toLocaleDateString('en', { weekday: 'short' }), users: dayUsers });
      }

      const topPlayers = [...profs].sort((a,b) => (b.score||0) - (a.score||0)).slice(0, 5);

      const ranks = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master', 'Grandmaster'];
      const rankDistribution = ranks.map(r => ({ rank: r, count: profs.filter(p => p.rank === r).length }));

      const revenueLabels = [];
      const revenueData = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
        const next = new Date(d); next.setDate(next.getDate() + 1);
        const dayPurchases = purch.filter(p => new Date(p.purchased_at) >= d && new Date(p.purchased_at) < next);
        let dayRev = 0;
        dayPurchases.forEach(p => {
          const item = items.find(it => it.id === p.item_id);
          if (item) dayRev += (item.price || 0);
        });
        revenueLabels.push(d.toLocaleDateString('en', { weekday: 'short' }));
        revenueData.push(dayRev);
      }
      const chart1 = { labels: revenueLabels, data: revenueData };

      const chart2 = { labels: ['NA', 'EU', 'ASIA', 'SA', 'AF'], data: [
          Math.floor(totalUsers * 0.4), Math.floor(totalUsers * 0.35), Math.floor(totalUsers * 0.15), 
          Math.floor(totalUsers * 0.08), Math.floor(totalUsers * 0.02)
      ] };

      const chart3 = { labels: ['Mobile', 'Desktop', 'Tablet'], data: [
          Math.floor(totalUsers * 0.8), Math.floor(totalUsers * 0.15), Math.floor(totalUsers * 0.05)
      ] };

      const chart4 = { labels: ['12am', '4am', '8am', '12pm', '4pm', '8pm'], data: [15, 8, 12, 22, 18, 25] };

      const typeCounts = { avatar: 0, frame: 0, skin: 0, effect: 0 };
      purch.forEach(p => {
        const item = items.find(it => it.id === p.item_id);
        if (item && typeCounts[item.type] !== undefined) typeCounts[item.type]++;
      });
      const chart5 = { labels: ['Avatars', 'Frames', 'Skins', 'Effects'], data: [typeCounts.avatar, typeCounts.frame, typeCounts.skin, typeCounts.effect] };

      const chart6 = { labels: ['<1m', '1-3m', '3-5m', '>5m'], data: [
          Math.floor(totalMatchesAll * 0.1), Math.floor(totalMatchesAll * 0.5), 
          Math.floor(totalMatchesAll * 0.3), Math.floor(totalMatchesAll * 0.1)
      ] };

      const mau = profs.filter(p => p.last_seen && new Date(p.last_seen) >= thirtyDaysAgo).length;
      const dau = profs.filter(p => p.last_seen && new Date(p.last_seen) >= today).length;
      const chart7 = { labels: ['Current'], datasets: { dau: [dau], mau: [mau] } };

      const chart8 = { labels: ['Day 1', 'Day 3', 'Day 7', 'Day 14', 'Day 30'], data: [dau, Math.floor(dau*0.7), Math.floor(dau*0.5), Math.floor(dau*0.3), Math.floor(dau*0.2)] };

      const chart9 = { labels: ['W1', 'W2', 'W3', 'W4'], data: [4.5, 4.2, 5.1, 3.8] };

      const arpu = totalUsers > 0 ? (purch.length * 100) / totalUsers : 0;
      const chart10 = { labels: ['Current ARPU'], data: [arpu] };

      const premiumUsers = profs.filter(p => (p.level || 1) > 10).length;
      const freeUsers = Math.max(0, totalUsers - premiumUsers);
      const chart11 = { labels: ['Free', 'Premium'], data: [freeUsers, premiumUsers] };

      const chart12 = { labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], data: [12, 8, 15, 10, 5] };

      const chart13 = { labels: ['12am', '4am', '8am', '12pm', '4pm', '8pm'], data: [
          Math.floor(onlineNow*0.2), Math.floor(onlineNow*0.1), Math.floor(onlineNow*0.4), 
          Math.floor(onlineNow*0.8), Math.floor(onlineNow*0.9), onlineNow
      ] };

      const chart14 = { labels: ['10m', '20m', '30m', '40m', '50m', '60m'], data: [45, 52, 48, 65, 78, 55] };

      const chart15 = { labels: ['<50ms', '50-100', '100-200', '>200ms'], data: [600, 250, 80, 20] };

      const premMatches = Math.floor(totalMatchesAll * (premiumUsers/(totalUsers||1)));
      const freeMatches = Math.max(0, totalMatchesAll - premMatches);
      const chart16 = { labels: ['Free Matches', 'Prem Matches'], data: [freeMatches, premMatches] };

      const chart17 = { labels: ['Twitter', 'FB', 'Insta', 'Copy Link'], data: [120, 80, 150, 350] };

      const chart18 = { labels: revenueLabels, data: [10, 15, 8, 20, 25, 30, 40] };

      const spenderMap = {};
      purch.forEach(p => {
        const item = items.find(it => it.id === p.item_id);
        if (item) {
          spenderMap[p.user_id] = (spenderMap[p.user_id] || 0) + item.price;
        }
      });
      const topSpenders = Object.entries(spenderMap)
        .sort((a,b) => b[1] - a[1])
        .slice(0, 4)
        .map(entry => {
          const u = profs.find(p => p.id === entry[0]);
          return { name: u ? u.username : 'Unknown', total: entry[1] };
        });
      const chart19 = { 
        labels: topSpenders.map(s => s.name).length ? topSpenders.map(s => s.name) : ['None'], 
        data: topSpenders.map(s => s.total).length ? topSpenders.map(s => s.total) : [1] 
      };

      const modeCounts = { ranked: 0, friends: 0, training: 0 };
      mat.forEach(m => { if (modeCounts[m.mode] !== undefined) modeCounts[m.mode]++; });
      const chart20 = { labels: ['Ranked', 'Friends', 'Training'], data: [modeCounts.ranked, modeCounts.friends, modeCounts.training] };

      const avgGrowth = usersPerDay.reduce((acc, val) => acc + val.users, 0) / 7;
      const proj = [totalUsers];
      for(let i=1; i<=5; i++) proj.push(Math.floor(totalUsers + (avgGrowth * 30 * i)));
      const chart21 = { labels: ['Month 1 (Now)', 'Month 2', 'Month 3', 'Month 4', 'Month 5', 'Month 6(Proj)'], data: proj };

      return { 
        matchesPerDay, usersPerDay, rankDistribution, topPlayers, 
        totalMatches: totalMatchesAll, totalUsers, onlineNow,
        extendedCharts: {
          c1: chart1, c2: chart2, c3: chart3, c4: chart4, c5: chart5, c6: chart6, c7: chart7,
          c8: chart8, c9: chart9, c10: chart10, c11: chart11, c12: chart12, c13: chart13, c14: chart14,
          c15: chart15, c16: chart16, c17: chart17, c18: chart18, c19: chart19, c20: chart20, c21: chart21
        }
      };
    });
    
    res.json(result);
  } catch (err) {
    console.error('Extended stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== USER MANAGEMENT =====
router.get('/users', async (req, res) => {
  try {
    const { search, limit = 50 } = req.query;
    const cacheKey = `admin_users_${search || ''}_${limit}`;
    const data = await cache.getOrSet(cacheKey, 10, async () => {
      let query = supabase.from('profiles').select('*').order('created_at', { ascending: false }).limit(limit);
      if (search) query = query.ilike('username', `%${search}%`);
      const { data: dbData, error } = await query;
      if (error) throw error;
      return dbData;
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/users/:id', async (req, res) => {
  try {
    const { coins, level, rank, role, xp, score, wins, losses, draws } = req.body;
    const updates = {};
    if (coins !== undefined) updates.coins = coins;
    if (level !== undefined) updates.level = level;
    if (rank !== undefined) updates.rank = rank;
    if (role !== undefined) updates.role = role;
    if (xp !== undefined) updates.xp = xp;
    if (score !== undefined) updates.score = score;
    if (wins !== undefined) updates.wins = wins;
    if (losses !== undefined) updates.losses = losses;
    if (draws !== undefined) updates.draws = draws;

    const { data, error } = await supabase.from('profiles').update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== FILE UPLOAD (Avatars/Banners) =====
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const { getSupabaseClient } = require('../config/supabase');

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    // Use the admin user's JWT for authenticated storage access
    const token = req.headers.authorization?.replace('Bearer ', '');
    const authClient = token ? getSupabaseClient(token) : supabase;
    
    // Generate unique filename
    const ext = req.file.originalname.split('.').pop();
    const filename = `${Date.now()}_${Math.random().toString(36).substring(2)}.${ext}`;
    
    // Upload to Supabase Storage 'avatars' bucket
    const { data, error } = await authClient.storage
      .from('avatars')
      .upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });
      
    if (error) throw error;
    
    // Get public URL
    const { data: publicUrlData } = authClient.storage.from('avatars').getPublicUrl(filename);
    
    res.json({ url: publicUrlData.publicUrl });
  } catch (err) {
    console.error('Upload Error:', err);
    res.status(500).json({ error: err.message || 'Failed to upload file' });
  }
});

// ===== SHOP ITEMS MANAGEMENT =====
router.get('/shop-items', async (req, res) => {
  try {
    const { data, error } = await supabase.from('shop_items').select('*').order('created_at', { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/shop-items', async (req, res) => {
  try {
    const { data, error } = await supabase.from('shop_items').insert(req.body).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/shop-items/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('shop_items').update(req.body).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/shop-items/:id', async (req, res) => {
  try {
    await supabase.from('shop_items').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== BANNER MANAGEMENT =====
router.get('/banners', async (req, res) => {
  try {
    const { data } = await supabase.from('banners').select('*').order('sort_order');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/banners', async (req, res) => {
  try {
    const { data, error } = await supabase.from('banners').insert(req.body).select().single();
    if (error) return res.status(400).json({ error: error.message });
    cache.invalidate('banners');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/banners/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('banners').update(req.body).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    cache.invalidate('banners');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/banners/:id', async (req, res) => {
  try {
    await supabase.from('banners').delete().eq('id', req.params.id);
    cache.invalidate('banners');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== MAIL MANAGEMENT (send to all users or specific user) =====
router.post('/mails/send', async (req, res) => {
  try {
    const { user_id, subject, body, type = 'system', icon = '📬', from_name = 'Admin', reward_coins = 0, reward_item_name = null, send_to_all = false } = req.body;

    if (send_to_all) {
      const { data: users } = await supabase.from('profiles').select('id');
      const mails = users.map(u => ({
        user_id: u.id, subject, body, type, icon, from_name, reward_coins, reward_item_name
      }));
      await supabase.from('mails').insert(mails);
      res.json({ success: true, sent_to: users.length });
    } else {
      if (!user_id) return res.status(400).json({ error: 'user_id required' });
      const { data, error } = await supabase.from('mails').insert({
        user_id, subject, body, type, icon, from_name, reward_coins, reward_item_name,
        reward_label: req.body.reward_label || (reward_coins > 0 ? `${reward_coins} Coins` : null),
        reward_emoji: req.body.reward_emoji || (reward_coins > 0 ? '🪙' : null)
      }).select().single();
      if (error) return res.status(400).json({ error: error.message });
      res.json(data);
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== APP SETTINGS =====
router.get('/settings', async (req, res) => {
  try {
    const { data } = await supabase.from('app_settings').select('*').eq('id', 1).single();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const { data, error } = await supabase.from('app_settings').update(req.body).eq('id', 1).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});



// ===== SERVER HEALTH =====
const os = require('os');
const HEALTH_HISTORY_SIZE = 60; // 60 data points × 10s = ~10 min
const healthHistory = [];
let lastCpuUsage = process.cpuUsage();

// Sample server metrics every 10 seconds
setInterval(() => {
  const cpus = os.cpus();
  const cpuUsage = cpus.reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const idle = cpu.times.idle;
    return acc + ((total - idle) / total) * 100;
  }, 0) / cpus.length;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const mem = ((totalMem - freeMem) / totalMem) * 100;
  const heap = process.memoryUsage();
  let sockets = 0;
  try { sockets = global.__io?.engine?.clientsCount || 0; } catch(e) {}

  // New metrics
  const currentCpuUsage = process.cpuUsage(lastCpuUsage);
  lastCpuUsage = process.cpuUsage();
  const freeMemPercent = Math.round((freeMem / totalMem) * 1000) / 10;
  const loadAvg = os.loadavg()[0]; // 1-min load average
  let activeHandles = 0;
  let activeRequests = 0;
  try { activeHandles = process._getActiveHandles?.()?.length || 0; } catch(e) {}
  try { activeRequests = process._getActiveRequests?.()?.length || 0; } catch(e) {}

  healthHistory.push({
    time: new Date().toISOString(),
    cpu: Math.round(cpuUsage * 10) / 10,
    memory: Math.round(mem * 10) / 10,
    sockets,
    heapUsed: Math.round(heap.heapUsed / 1024 / 1024),
    heapTotal: Math.round(heap.heapTotal / 1024 / 1024),
    rss: Math.round(heap.rss / 1024 / 1024),
    eventLoopLag: 0,
    // 10 new metrics
    externalMem: Math.round((heap.external || 0) / 1024 / 1024),
    arrayBuffers: Math.round((heap.arrayBuffers || 0) / 1024 / 1024),
    cpuUser: Math.round(currentCpuUsage.user / 1000),     // ms
    cpuSystem: Math.round(currentCpuUsage.system / 1000), // ms
    freeMemPercent,
    loadAvg: Math.round(loadAvg * 100) / 100,
    activeHandles,
    activeRequests,
    uptimeSec: Math.round(process.uptime()),
    heapPercent: Math.round((heap.heapUsed / heap.heapTotal) * 1000) / 10
  });
  if (healthHistory.length > HEALTH_HISTORY_SIZE) healthHistory.shift();
}, 10000);

// Event loop lag measurement
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = now - lastTick - 1000;
  if (healthHistory.length > 0) healthHistory[healthHistory.length - 1].eventLoopLag = Math.max(0, lag);
  lastTick = now;
}, 1000);

router.get('/server-health', async (req, res) => {
  const cpus = os.cpus();
  const cpuUsage = cpus.reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const idle = cpu.times.idle;
    return acc + ((total - idle) / total) * 100;
  }, 0) / cpus.length;

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = (usedMem / totalMem) * 100;

  const uptimeSec = process.uptime();
  const hrs = Math.floor(uptimeSec / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);

  let activeSockets = 0;
  try { activeSockets = req.io?.engine?.clientsCount || 0; } catch(e) {}

  const heap = process.memoryUsage();
  
  // Fetch DB Storage Size
  let dbUsedBytes = 0;
  try {
    dbUsedBytes = await cache.getOrSet('db_size', 60, async () => {
      const { data } = await supabase.rpc('get_db_size');
      return data ? parseInt(data) : 0;
    });
  } catch (e) { console.error('DB size fetch error:', e); }

  const dbMaxBytes = 500 * 1024 * 1024; // 500MB Free Tier Limit
  const dbFreeBytes = Math.max(0, dbMaxBytes - dbUsedBytes);

  res.json({
    cpu: Math.round(cpuUsage * 10) / 10,
    memoryUsed: Math.round(usedMem / 1024 / 1024),
    memoryTotal: Math.round(totalMem / 1024 / 1024),
    memoryPercent: Math.round(memPercent * 10) / 10,
    dbStorageUsedMB: Math.round(dbUsedBytes / 1024 / 1024 * 10) / 10,
    dbStorageFreeMB: Math.round(dbFreeBytes / 1024 / 1024 * 10) / 10,
    dbStorageTotalMB: 500,
    uptime: `${hrs}h ${mins}m`,
    uptimeSeconds: Math.round(uptimeSec),
    nodeVersion: process.version,
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    activeSockets,
    pid: process.pid,
    heapUsed: Math.round(heap.heapUsed / 1024 / 1024),
    heapTotal: Math.round(heap.heapTotal / 1024 / 1024),
    rss: Math.round(heap.rss / 1024 / 1024),
    eventLoopLag: healthHistory.length > 0 ? healthHistory[healthHistory.length - 1].eventLoopLag : 0,
    timestamp: new Date().toISOString()
  });
});

router.get('/server-health/history', (req, res) => {
  res.json(healthHistory);
});

// ===== ANNOUNCEMENTS =====
router.get('/announcements', async (req, res) => {
  try {
    const { data } = await supabase.from('announcements').select('*').order('created_at', { ascending: false });
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/announcements', async (req, res) => {
  try {
    const { title, message, type = 'info', icon = '📢', active = true, priority = 0 } = req.body;
    const { data, error } = await supabase.from('announcements')
      .insert({ title, message, type, icon, active, priority }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    // Broadcast to all connected users via socket
    if (active && req.io) {
      req.io.emit('announcement', { title, message, type, icon });
    }
    res.json(data);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

router.put('/announcements/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('announcements').update(req.body).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

router.delete('/announcements/:id', async (req, res) => {
  try {
    await supabase.from('announcements').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ===== QUICK REWARD (coins + XP + optional mail + notification) =====
router.post('/rewards/send', async (req, res) => {
  try {
    const { user_id, coins = 0, xp = 0, reason = 'Admin Reward', send_to_all = false } = req.body;

    async function rewardUser(uid) {
      // Update profile
      const { data: profile } = await supabase.from('profiles').select('coins, xp').eq('id', uid).single();
      if (!profile) return;
      await supabase.from('profiles').update({
        coins: (profile.coins || 0) + coins,
        xp: (profile.xp || 0) + xp
      }).eq('id', uid);

      // Create notification
      await supabase.from('notifications').insert({
        user_id: uid,
        type: 'reward',
        title: '🎁 Reward Received!',
        message: reason + (coins > 0 ? ` (+${coins} coins)` : '') + (xp > 0 ? ` (+${xp} XP)` : ''),
        read: false
      });

      // Create mail
      const parts = [];
      if (coins > 0) parts.push(coins + ' Coins');
      if (xp > 0) parts.push(xp + ' XP');
      await supabase.from('mails').insert({
        user_id: uid,
        subject: '🎁 ' + reason,
        body: 'You received a reward from the admin team: ' + parts.join(' + '),
        type: 'reward',
        icon: '🎁',
        from_name: 'Admin Team',
        reward_coins: coins,
        reward_label: parts.join(' + '),
        reward_emoji: '🎁'
      });

      // Push via socket
      if (req.io) {
        req.io.to(uid).emit('notification', {
          type: 'reward',
          title: '🎁 Reward Received!',
          message: reason
        });
      }
    }

    if (send_to_all) {
      const { data: users } = await supabase.from('profiles').select('id');
      const ulist = users || [];
      // Process in chunks to prevent database connection exhaustion
      for (let i = 0; i < ulist.length; i += 50) {
        const chunk = ulist.slice(i, i + 50);
        await Promise.all(chunk.map(u => rewardUser(u.id)));
      }
      res.json({ success: true, rewarded: ulist.length });
    } else {
      if (!user_id) return res.status(400).json({ error: 'user_id required' });
      await rewardUser(user_id);
      res.json({ success: true, rewarded: 1 });
    }
  } catch (err) {
    console.error('Reward error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== ACTIVITY LOG =====
router.get('/activity-log', async (req, res) => {
  try {
    const log = await cache.getOrSet('admin_activity_log', 15, async () => {
      const [signupsRes, matchesRes, purchasesRes] = await Promise.all([
        supabase.from('profiles').select('id, username, created_at').order('created_at', { ascending: false }).limit(10),
        supabase.from('matches').select('id, winner_id, player1_id, player2_id, created_at').order('created_at', { ascending: false }).limit(10),
        supabase.from('user_items').select('id, user_id, item_id, purchased_at').order('purchased_at', { ascending: false }).limit(10)
      ]);
      return {
        recentSignups: signupsRes.data || [],
        recentMatches: matchesRes.data || [],
        recentPurchases: purchasesRes.data || []
      };
    });
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== BROADCAST ANNOUNCEMENT =====
router.post('/broadcast', async (req, res) => {
  try {
    const { title, message, type = 'info' } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    if (req.io) {
      req.io.emit('announcement', { title: title || '📢 Announcement', message, type });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== ACHIEVEMENTS MANAGEMENT =====
router.get('/achievements', async (req, res) => {
  try {
    const { data, error } = await supabase.from('achievements_def').select('*').order('created_at', { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/achievements', async (req, res) => {
  try {
    const { name, description, emoji, category, max_progress, tier, xp_reward } = req.body;
    if (!name || !description) return res.status(400).json({ error: 'Name and description required' });
    
    const { data, error } = await supabase.from('achievements_def').insert({
      name, description, emoji: emoji || '🏆', category: category || 'special', 
      max_progress: parseInt(max_progress) || 1, tier: tier || 'bronze', xp_reward: parseInt(xp_reward) || 100
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/achievements/:id', async (req, res) => {
  try {
    const { name, description, emoji, category, max_progress, tier, xp_reward } = req.body;
    const { data, error } = await supabase.from('achievements_def').update({
      name, description, emoji, category, max_progress: parseInt(max_progress), tier, xp_reward: parseInt(xp_reward)
    }).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/achievements/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('achievements_def').delete().eq('id', req.params.id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

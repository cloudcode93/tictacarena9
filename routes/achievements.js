const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');
const cache = require('../utils/cache');

// Get achievements with user progress — parallel fetch + cached defs
router.get('/', authMiddleware, async (req, res) => {
  try {
    // Cache achievement defs (rarely change) + fetch user progress in PARALLEL
    const [defs, progressResult] = await Promise.all([
      cache.getOrSet('achievement_defs', 300, async () => {
        const { data } = await supabaseAdmin.from('achievements_def').select('*').order('created_at');
        return data || [];
      }),
      supabaseAdmin.from('user_achievements').select('*').eq('user_id', req.user.id)
    ]);

    const progressMap = {};
    (progressResult.data || []).forEach(p => { progressMap[p.achievement_id] = p; });

    const achievements = defs.map(d => ({
      ...d,
      progress: progressMap[d.id]?.progress || 0,
      unlocked: progressMap[d.id]?.unlocked || false,
      unlocked_at: progressMap[d.id]?.unlocked_at || null
    }));

    res.json(achievements);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

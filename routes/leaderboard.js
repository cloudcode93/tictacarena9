const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const cache = require('../utils/cache');

// Get leaderboard (cached 30s)
router.get('/', async (req, res) => {
  try {
    const tab = req.query.tab || 'global';
    
    let orderBy = 'score';
    if (tab === 'weekly') orderBy = 'wins';
    if (tab === 'monthly') orderBy = 'level';
    
    if (tab === 'friends') {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
         return res.json([]);
      }
      const token = authHeader.split(' ')[1];
      const { data: { user } } = await supabase.auth.getUser(token);
      if (!user) return res.json([]);
      
      const { data: f1 } = await supabase.from('friends').select('friend_id').eq('user_id', user.id).eq('status', 'accepted');
      const { data: f2 } = await supabase.from('friends').select('user_id').eq('friend_id', user.id).eq('status', 'accepted');
      
      const friendIds = [...(f1 || []).map(f => f.friend_id), ...(f2 || []).map(f => f.user_id), user.id];
      
      if (friendIds.length === 0) return res.json([]);

      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, level, rank, score, wins, losses, draws, equipped_avatar_url, online')
        .in('id', friendIds)
        .order('score', { ascending: false })
        .limit(50);
        
      if (error) throw error;
      return res.json((data || []).map((p, i) => ({ ...p, globalRank: i + 1 })));
    }

    const leaderboard = await cache.getOrSet(`leaderboard_${tab}`, 30, async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, level, rank, score, wins, losses, draws, equipped_avatar_url, online')
        .order(orderBy, { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data || []).map((p, i) => ({ ...p, globalRank: i + 1 }));
    });
    res.json(leaderboard);
  } catch (err) {
    console.error('Leaderboard error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

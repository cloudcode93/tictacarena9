const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');

// Get match history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('matches')
      .select('*, player1:player1_id(id, username, equipped_avatar_url, level, rank), player2:player2_id(id, username, equipped_avatar_url, level, rank)')
      .or(`player1_id.eq.${req.user.id},player2_id.eq.${req.user.id}`)
      .order('created_at', { ascending: false })
      .limit(30);

    if (error) return res.status(400).json({ error: error.message });

    const history = (data || []).map(m => {
      const isPlayer1 = m.player1_id === req.user.id;
      let result = 'draw';
      if (m.result === 'player1') result = isPlayer1 ? 'win' : 'loss';
      else if (m.result === 'player2') result = isPlayer1 ? 'loss' : 'win';

      return {
        id: m.id,
        opponent: isPlayer1 ? m.player2 : m.player1,
        result,
        mode: m.mode,
        duration_seconds: m.duration_seconds,
        xp: isPlayer1 ? m.xp_player1 : m.xp_player2,
        coins: isPlayer1 ? m.coins_player1 : m.coins_player2,
        rank_points: isPlayer1 ? m.rank_points_player1 : m.rank_points_player2,
        created_at: m.created_at
      };
    });

    res.json(history);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

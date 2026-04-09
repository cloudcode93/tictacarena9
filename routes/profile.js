const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');

const cache = require('../utils/cache');

// Get current user profile
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const data = await cache.getOrSet(`profile_me_${req.user.id}`, 5, async () => {
      const { data: dbData, error } = await supabase
        .from('profiles')
        .select('id, username, level, rank, xp, xp_to_next, score, coins, wins, losses, draws, equipped_avatar_url, equipped_frame, equipped_skin, equipped_effect, online, role, created_at')
        .eq('id', req.user.id)
        .single();
      if (error) throw error;
      return dbData;
    });

    res.json(data);
  } catch (err) {
    res.status(err.code === 'PGRST116' || err.message ? 400 : 500).json({ error: err.message || 'Server error' });
  }
});

// Get any user profile by ID
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const data = await cache.getOrSet(`profile_${req.params.id}`, 10, async () => {
      const { data: dbData, error } = await supabase
        .from('profiles')
        .select('id, username, level, rank, xp, score, wins, losses, draws, equipped_avatar_url, online, last_seen')
        .eq('id', req.params.id)
        .single();
      if (error) throw error;
      return dbData;
    });

    res.json(data);
  } catch (err) {
    res.status(err.message ? 404 : 500).json({ error: err.message || 'Server error' });
  }
});

// Update current user profile
router.put('/me', authMiddleware, async (req, res) => {
  try {
    const allowedFields = ['username', 'equipped_avatar_url', 'equipped_frame', 'equipped_skin', 'equipped_effect'];
    const updates = {};
    
    // Username validation: 6-10 chars, letters and numbers only
    if (req.body.username !== undefined) {
      const username = String(req.body.username).trim();
      const userRegex = /^(?=.*[a-zA-Z])(?=.*[0-9])[a-zA-Z0-9]{6,10}$/;
      
      if (!userRegex.test(username)) {
        return res.status(400).json({ error: 'Username must be 6-10 characters long and contain both letters and numbers (no special characters).' });
      }
      updates.username = username;
    }

    for (const field of allowedFields) {
      if (field !== 'username' && req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) {
      // Handle Postgres Unique Constraint Violation (Error 23505)
      if (error.code === '23505' || error.message.includes('unique constraint')) {
        return res.status(409).json({ error: 'This username is already taken by another player. Please choose a different one.' });
      }
      return res.status(400).json({ error: error.message });
    }
    
    // Invalidate local cache instantly so the next load shows fresh data
    cache.invalidate(`profile_me_${req.user.id}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
